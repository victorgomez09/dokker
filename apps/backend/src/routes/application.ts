import {
	clearOldDeployments,
	createApplication,
	deleteAllMiddlewares,
	findApplicationById,
	findEnvironmentById,
	findGitProviderById,
	findProjectById,
	getApplicationStats,
	IS_CLOUD,
	mechanizeDockerContainer,
	readConfig,
	readRemoteConfig,
	removeDeployments,
	removeDirectoryCode,
	removeMonitoringDirectory,
	removeService,
	removeTraefikConfig,
	startService,
	startServiceRemote,
	stopService,
	stopServiceRemote,
	unzipDrop,
	updateApplication,
	updateApplicationStatus,
	updateDeploymentStatus,
	writeConfig,
	writeConfigRemote,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
	addNewService,
	checkServiceAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@dokploy/server/services/permission";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { HonoEnv } from "@/types/hono";
import {
	apiCreateApplication,
	apiDeployApplication,
	apiFindMonitoringStats,
	apiFindOneApplication,
	apiRedeployApplication,
	apiReloadApplication,
	apiSaveBitbucketProvider,
	apiSaveBuildType,
	apiSaveDockerProvider,
	apiSaveEnvironmentVariables,
	apiSaveGiteaProvider,
	apiSaveGithubProvider,
	apiSaveGitlabProvider,
	apiSaveGitProvider,
	apiUpdateApplication,
	applications,
	environments,
	projects,
} from "@/db/schema";
import { isAuthed, withPermission } from "@/middlewares/guards";
import { deploymentWorker } from "@/queues/deployments-queue";
import type { DeploymentJob } from "@/queues/queue-types";
import {
	cleanQueuesByApplication,
	getJobsByApplicationId,
	killDockerBuild,
	myQueue,
} from "@/queues/queueSetup";
import { cancelDeployment, deploy } from "@/utils/deploy";
import { getCtx } from "@/middlewares/auth";
import { toHttpError } from "@/utils/trpc";

const application = new Hono<HonoEnv>();

application.use("*", isAuthed);

application.post("/create", zValidator("json", apiCreateApplication), async (c) => {
	try {
		const input = c.req.valid("json");
		const ctx = getCtx(c);

		const environment = await findEnvironmentById(input.environmentId);
		const project = await findProjectById(environment.projectId);

		await checkServiceAccess(ctx, project.projectId, "create");

		if (IS_CLOUD && !input.serverId) {
			throw new HTTPException(401, {
				message: "You need to use a server to create an application",
			});
		}

		if (project.organizationId !== ctx.session.activeOrganizationId) {
			throw new HTTPException(401, {
				message: "You are not authorized to access this project",
			});
		}

		const newApplication = await createApplication(input);
		await addNewService(ctx, newApplication.applicationId);

		return c.json(newApplication, 201);
	} catch (error) {
		throw toHttpError(error, "Error creating the application");
	}
});

application.get(
	"/one/:applicationId",
	zValidator("param", z.object({ applicationId: z.string() })),
	async (c) => {
		try {
			const { applicationId } = c.req.valid("param");
			const ctx = getCtx(c);

			await checkServiceAccess(ctx, applicationId, "read");

			const app = await findApplicationById(applicationId);
			if (
				app.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new HTTPException(401, {
					message: "You are not authorized to access this application",
				});
			}

			let hasGitProviderAccess = true;
			let unauthorizedProvider: string | null = null;

			const getGitProviderId = () => {
				switch (app.sourceType) {
					case "github":
						return app.github?.gitProviderId;
					case "gitlab":
						return app.gitlab?.gitProviderId;
					case "bitbucket":
						return app.bitbucket?.gitProviderId;
					case "gitea":
						return app.gitea?.gitProviderId;
					default:
						return null;
				}
			};

			const gitProviderId = getGitProviderId();
			if (gitProviderId) {
				try {
					const gitProvider = await findGitProviderById(gitProviderId);
					if (gitProvider.userId !== ctx.session.userId) {
						hasGitProviderAccess = false;
						unauthorizedProvider = app.sourceType;
					}
				} catch {
					hasGitProviderAccess = false;
					unauthorizedProvider = app.sourceType;
				}
			}

			return c.json({
				...app,
				hasGitProviderAccess,
				unauthorizedProvider,
			});
		} catch (error) {
			throw toHttpError(error, "Error fetching application");
		}
	},
);

application.post("/reload", zValidator("json", apiReloadApplication), async (c) => {
	try {
		const input = c.req.valid("json");
		const ctx = getCtx(c);

		await checkServicePermissionAndAccess(ctx, input.applicationId, {
			deployment: ["create"],
		});

		const app = await findApplicationById(input.applicationId);

		await updateApplicationStatus(input.applicationId, "idle");
		await mechanizeDockerContainer(app);
		await updateApplicationStatus(input.applicationId, "done");

		return c.json({ success: true });
	} catch (error) {
		const input = c.req.valid("json");
		await updateApplicationStatus(input.applicationId, "error").catch(() => undefined);
		throw toHttpError(error, "Error reloading application");
	}
});

application.delete(
	"/delete/:applicationId",
	zValidator("param", z.object({ applicationId: z.string() })),
	async (c) => {
		try {
			const { applicationId } = c.req.valid("param");
			const ctx = getCtx(c);

			await checkServiceAccess(ctx, applicationId, "delete");
			const app = await findApplicationById(applicationId);

			if (
				app.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new HTTPException(401, {
					message: "You are not authorized to delete this application",
				});
			}

			await db
				.delete(applications)
				.where(eq(applications.applicationId, applicationId))
				.returning();

			if (!IS_CLOUD) {
				const queueJobs = await getJobsByApplicationId(applicationId);
				for (const job of queueJobs) {
					if (job.id) {
						deploymentWorker.cancelJob(job.id, "User requested cancellation");
					}
				}
			}

			const cleanupOperations = [
				async () => await deleteAllMiddlewares(app),
				async () => await removeDeployments(app),
				async () => await removeDirectoryCode(app.appName, app.serverId),
				async () => await removeMonitoringDirectory(app.appName, app.serverId),
				async () => await removeTraefikConfig(app.appName, app.serverId),
				async () => await removeService(app.appName, app.serverId),
			];

			for (const operation of cleanupOperations) {
				try {
					await operation();
				} catch {
					// Best-effort cleanup
				}
			}

			return c.json(app);
		} catch (error) {
			throw toHttpError(error, "Error deleting application");
		}
	},
);

application.post("/stop", zValidator("json", apiFindOneApplication), async (c) => {
	try {
		const input = c.req.valid("json");
		const ctx = getCtx(c);

		await checkServicePermissionAndAccess(ctx, input.applicationId, {
			deployment: ["create"],
		});

		const service = await findApplicationById(input.applicationId);
		if (service.serverId) {
			await stopServiceRemote(service.serverId, service.appName);
		} else {
			await stopService(service.appName);
		}

		await updateApplicationStatus(input.applicationId, "idle");
		return c.json(service);
	} catch (error) {
		throw toHttpError(error, "Error stopping application");
	}
});

application.post("/start", zValidator("json", apiFindOneApplication), async (c) => {
	try {
		const input = c.req.valid("json");
		const ctx = getCtx(c);

		await checkServicePermissionAndAccess(ctx, input.applicationId, {
			deployment: ["create"],
		});

		const service = await findApplicationById(input.applicationId);
		if (service.serverId) {
			await startServiceRemote(service.serverId, service.appName);
		} else {
			await startService(service.appName);
		}

		await updateApplicationStatus(input.applicationId, "done");
		return c.json(service);
	} catch (error) {
		throw toHttpError(error, "Error starting application");
	}
});

application.post(
	"/redeploy",
	zValidator("json", apiRedeployApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});

			const app = await findApplicationById(input.applicationId);
			const jobData: DeploymentJob = {
				applicationId: input.applicationId,
				titleLog: input.title || "Rebuild deployment",
				descriptionLog: input.description || "",
				type: "redeploy",
				applicationType: "application",
				server: !!app.serverId,
			};

			if (IS_CLOUD && app.serverId) {
				jobData.serverId = app.serverId;
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
				return c.json({ success: true });
			}

			await myQueue.add(
				"deployments",
				{ ...jobData },
				{
					removeOnComplete: true,
					removeOnFail: true,
				},
			);

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error scheduling redeploy");
		}
	},
);

application.post(
	"/save-environment",
	zValidator("json", apiSaveEnvironmentVariables),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				envVars: ["write"],
			});

			await updateApplication(input.applicationId, {
				env: input.env,
				buildArgs: input.buildArgs,
				buildSecrets: input.buildSecrets,
				createEnvFile: input.createEnvFile,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving environment variables");
		}
	},
);

application.post(
	"/save-build-type",
	zValidator("json", apiSaveBuildType),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				buildType: input.buildType,
				dockerfile: input.dockerfile,
				publishDirectory: input.publishDirectory,
				dockerContextPath: input.dockerContextPath,
				dockerBuildStage: input.dockerBuildStage,
				herokuVersion: input.herokuVersion,
				isStaticSpa: input.isStaticSpa,
				railpackVersion: input.railpackVersion,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving build type");
		}
	},
);

application.post(
	"/save-github-provider",
	zValidator("json", apiSaveGithubProvider),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				repository: input.repository,
				branch: input.branch,
				sourceType: "github",
				owner: input.owner,
				buildPath: input.buildPath,
				applicationStatus: "idle",
				githubId: input.githubId,
				watchPaths: input.watchPaths,
				triggerType: input.triggerType,
				enableSubmodules: input.enableSubmodules,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving GitHub provider");
		}
	},
);

application.post(
	"/save-gitlab-provider",
	zValidator("json", apiSaveGitlabProvider),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				gitlabRepository: input.gitlabRepository,
				gitlabOwner: input.gitlabOwner,
				gitlabBranch: input.gitlabBranch,
				gitlabBuildPath: input.gitlabBuildPath,
				sourceType: "gitlab",
				applicationStatus: "idle",
				gitlabId: input.gitlabId,
				gitlabProjectId: input.gitlabProjectId,
				gitlabPathNamespace: input.gitlabPathNamespace,
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving GitLab provider");
		}
	},
);

application.post(
	"/save-bitbucket-provider",
	zValidator("json", apiSaveBitbucketProvider),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				bitbucketRepository: input.bitbucketRepository,
				bitbucketRepositorySlug: input.bitbucketRepositorySlug,
				bitbucketOwner: input.bitbucketOwner,
				bitbucketBranch: input.bitbucketBranch,
				bitbucketBuildPath: input.bitbucketBuildPath,
				sourceType: "bitbucket",
				applicationStatus: "idle",
				bitbucketId: input.bitbucketId,
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving Bitbucket provider");
		}
	},
);

application.post(
	"/save-gitea-provider",
	zValidator("json", apiSaveGiteaProvider),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				giteaRepository: input.giteaRepository,
				giteaOwner: input.giteaOwner,
				giteaBranch: input.giteaBranch,
				giteaBuildPath: input.giteaBuildPath,
				sourceType: "gitea",
				applicationStatus: "idle",
				giteaId: input.giteaId,
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving Gitea provider");
		}
	},
);

application.post(
	"/save-docker-provider",
	zValidator("json", apiSaveDockerProvider),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				dockerImage: input.dockerImage,
				username: input.username,
				password: input.password,
				sourceType: "docker",
				applicationStatus: "idle",
				registryUrl: input.registryUrl,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving Docker provider");
		}
	},
);

application.post(
	"/save-git-provider",
	zValidator("json", apiSaveGitProvider),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				customGitBranch: input.customGitBranch,
				customGitBuildPath: input.customGitBuildPath,
				customGitUrl: input.customGitUrl,
				customGitSSHKeyId: input.customGitSSHKeyId,
				sourceType: "git",
				applicationStatus: "idle",
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error saving Git provider");
		}
	},
);

application.post(
	"/disconnect-git-provider",
	zValidator("json", apiFindOneApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				repository: null,
				branch: null,
				owner: null,
				buildPath: "/",
				githubId: null,
				triggerType: "push",
				gitlabRepository: null,
				gitlabOwner: null,
				gitlabBranch: null,
				gitlabBuildPath: null,
				gitlabId: null,
				gitlabProjectId: null,
				gitlabPathNamespace: null,
				bitbucketRepository: null,
				bitbucketOwner: null,
				bitbucketBranch: null,
				bitbucketBuildPath: null,
				bitbucketId: null,
				giteaRepository: null,
				giteaOwner: null,
				giteaBranch: null,
				giteaBuildPath: null,
				giteaId: null,
				customGitBranch: null,
				customGitBuildPath: null,
				customGitUrl: null,
				customGitSSHKeyId: null,
				sourceType: "github",
				applicationStatus: "idle",
				watchPaths: null,
				enableSubmodules: false,
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error disconnecting git provider");
		}
	},
);

application.post(
	"/mark-running",
	zValidator("json", apiFindOneApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});

			await updateApplicationStatus(input.applicationId, "running");
			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error updating application status");
		}
	},
);

application.post("/update", zValidator("json", apiUpdateApplication), async (c) => {
	try {
		const input = c.req.valid("json");
		const ctx = getCtx(c);

		await checkServicePermissionAndAccess(ctx, input.applicationId, {
			service: ["create"],
		});

		const { applicationId, ...rest } = input;
		const updateApp = await updateApplication(applicationId, {
			...rest,
		});

		if (!updateApp) {
			throw new HTTPException(400, {
				message: "Error updating application",
			});
		}

		return c.json({ success: true });
	} catch (error) {
		throw toHttpError(error, "Error updating application");
	}
});

application.post(
	"/refresh-token",
	zValidator("json", apiFindOneApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			await updateApplication(input.applicationId, {
				refreshToken: nanoid(),
			});

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error refreshing token");
		}
	},
);

application.post("/deploy", zValidator("json", apiDeployApplication), async (c) => {
	try {
		const input = c.req.valid("json");
		const ctx = getCtx(c);

		await checkServicePermissionAndAccess(ctx, input.applicationId, {
			deployment: ["create"],
		});

		const app = await findApplicationById(input.applicationId);
		const jobData: DeploymentJob = {
			applicationId: input.applicationId,
			titleLog: input.title || "Manual deployment",
			descriptionLog: input.description || "",
			type: "deploy",
			applicationType: "application",
			server: !!app.serverId,
		};

		if (IS_CLOUD && app.serverId) {
			jobData.serverId = app.serverId;
			deploy(jobData).catch((error) => {
				console.error("Background deployment failed:", error);
			});
			return c.json({ success: true });
		}

		await myQueue.add(
			"deployments",
			{ ...jobData },
			{
				removeOnComplete: true,
				removeOnFail: true,
			},
		);

		return c.json({ success: true });
	} catch (error) {
		throw toHttpError(error, "Error scheduling deployment");
	}
});

application.post(
	"/clean-queues",
	zValidator("json", apiFindOneApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["cancel"],
			});
			await cleanQueuesByApplication(input.applicationId);

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error cleaning queues");
		}
	},
);

application.post(
	"/clear-deployments",
	zValidator("json", apiFindOneApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});

			const app = await findApplicationById(input.applicationId);
			await clearOldDeployments(app.appName, app.serverId);

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error clearing deployments");
		}
	},
);

application.post(
	"/kill-build",
	zValidator("json", apiFindOneApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["cancel"],
			});

			const app = await findApplicationById(input.applicationId);
			await killDockerBuild("application", app.serverId);

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error killing build");
		}
	},
);

application.get(
	"/read-traefik-config/:applicationId",
	zValidator("param", z.object({ applicationId: z.string() })),
	async (c) => {
		try {
			const { applicationId } = c.req.valid("param");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, applicationId, {
				traefikFiles: ["read"],
			});

			const app = await findApplicationById(applicationId);
			if (app.serverId) {
				const traefikConfig = await readRemoteConfig(app.serverId, app.appName);
				return c.json(traefikConfig);
			}

			const traefikConfig = readConfig(app.appName);
			return c.json(traefikConfig);
		} catch (error) {
			throw toHttpError(error, "Error reading Traefik config");
		}
	},
);

application.post(
	"/drop-deployment",
	async (c) => {
		try {
			const form = await c.req.parseBody();
			const applicationId = form.applicationId;
			const zip = form.zip;
			const dropBuildPath = form.dropBuildPath;

			if (typeof applicationId !== "string" || !applicationId.trim()) {
				throw new HTTPException(400, { message: "applicationId is required" });
			}
			if (!(zip instanceof File)) {
				throw new HTTPException(400, { message: "zip file is required" });
			}

			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, applicationId, {
				deployment: ["create"],
			});

			const app = await findApplicationById(applicationId);

			await updateApplication(applicationId, {
				sourceType: "drop",
				dropBuildPath: typeof dropBuildPath === "string" ? dropBuildPath : "",
			});

			await unzipDrop(zip, app);

			const jobData: DeploymentJob = {
				applicationId: app.applicationId,
				titleLog: "Manual deployment",
				descriptionLog: "",
				type: "deploy",
				applicationType: "application",
				server: !!app.serverId,
			};

			if (IS_CLOUD && app.serverId) {
				jobData.serverId = app.serverId;
				deploy(jobData).catch((error) => {
					console.error("Background deployment failed:", error);
				});
				return c.json({ success: true });
			}

			await myQueue.add(
				"deployments",
				{ ...jobData },
				{
					removeOnComplete: true,
					removeOnFail: true,
				},
			);

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error processing drop deployment");
		}
	},
);

application.post(
	"/update-traefik-config",
	zValidator("json", z.object({ applicationId: z.string(), traefikConfig: z.string() })),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				traefikFiles: ["write"],
			});

			const app = await findApplicationById(input.applicationId);
			if (app.serverId) {
				await writeConfigRemote(app.serverId, app.appName, input.traefikConfig);
			} else {
				writeConfig(app.appName, input.traefikConfig);
			}

			return c.json({ success: true });
		} catch (error) {
			throw toHttpError(error, "Error updating Traefik config");
		}
	},
);

application.get(
	"/read-app-monitoring",
	withPermission("monitoring", "read"),
	zValidator("query", apiFindMonitoringStats),
	async (c) => {
		try {
			if (IS_CLOUD) {
				throw new HTTPException(401, {
					message: "Functionality not available in cloud version",
				});
			}

			const input = c.req.valid("query");
			const stats = await getApplicationStats(input.appName);
			return c.json(stats);
		} catch (error) {
			throw toHttpError(error, "Error reading app monitoring");
		}
	},
);

application.post(
	"/move",
	zValidator(
		"json",
		z.object({
			applicationId: z.string(),
			targetEnvironmentId: z.string(),
		}),
	),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			const updatedApplication = await db
				.update(applications)
				.set({
					environmentId: input.targetEnvironmentId,
				})
				.where(eq(applications.applicationId, input.applicationId))
				.returning()
				.then((res) => res[0]);

			if (!updatedApplication) {
				throw new HTTPException(500, {
					message: "Failed to move application",
				});
			}

			return c.json(updatedApplication);
		} catch (error) {
			throw toHttpError(error, "Error moving application");
		}
	},
);

application.post(
	"/cancel-deployment",
	zValidator("json", apiFindOneApplication),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["cancel"],
			});

			const app = await findApplicationById(input.applicationId);

			if (IS_CLOUD && app.serverId) {
				await updateApplicationStatus(input.applicationId, "idle");

				if (app.deployments[0]) {
					await updateDeploymentStatus(app.deployments[0].deploymentId, "done");
				}

				await cancelDeployment({
					applicationId: input.applicationId,
					applicationType: "application",
				});

				return c.json({
					success: true,
					message: "Deployment cancellation requested",
				});
			}

			throw new HTTPException(400, {
				message: "Deployment cancellation only available in cloud version",
			});
		} catch (error) {
			throw toHttpError(error, "Failed to cancel deployment");
		}
	},
);

application.post(
	"/search",
	zValidator(
		"json",
		z.object({
			q: z.string().optional(),
			name: z.string().optional(),
			appName: z.string().optional(),
			description: z.string().optional(),
			repository: z.string().optional(),
			owner: z.string().optional(),
			dockerImage: z.string().optional(),
			projectId: z.string().optional(),
			environmentId: z.string().optional(),
			limit: z.number().min(1).max(100).default(20),
			offset: z.number().min(0).default(0),
		}),
	),
	async (c) => {
		try {
			const input = c.req.valid("json");
			const ctx = getCtx(c);

			const baseConditions = [
				eq(projects.organizationId, ctx.session.activeOrganizationId),
			];

			if (input.projectId) {
				baseConditions.push(eq(environments.projectId, input.projectId));
			}
			if (input.environmentId) {
				baseConditions.push(eq(applications.environmentId, input.environmentId));
			}

			if (input.q?.trim()) {
				const term = `%${input.q.trim()}%`;
				baseConditions.push(
					or(
						ilike(applications.name, term),
						ilike(applications.appName, term),
						ilike(applications.description ?? "", term),
						ilike(applications.repository ?? "", term),
						ilike(applications.owner ?? "", term),
						ilike(applications.dockerImage ?? "", term),
					)!,
				);
			}

			if (input.name?.trim()) {
				baseConditions.push(ilike(applications.name, `%${input.name.trim()}%`));
			}
			if (input.appName?.trim()) {
				baseConditions.push(ilike(applications.appName, `%${input.appName.trim()}%`));
			}
			if (input.description?.trim()) {
				baseConditions.push(
					ilike(applications.description ?? "", `%${input.description.trim()}%`),
				);
			}
			if (input.repository?.trim()) {
				baseConditions.push(
					ilike(applications.repository ?? "", `%${input.repository.trim()}%`),
				);
			}
			if (input.owner?.trim()) {
				baseConditions.push(ilike(applications.owner ?? "", `%${input.owner.trim()}%`));
			}
			if (input.dockerImage?.trim()) {
				baseConditions.push(
					ilike(applications.dockerImage ?? "", `%${input.dockerImage.trim()}%`),
				);
			}

			const { accessedServices } = await findMemberByUserId(
				ctx.user.id,
				ctx.session.activeOrganizationId,
			);

			if (accessedServices.length === 0) {
				return c.json({ items: [], total: 0 });
			}

			baseConditions.push(
				sql`${applications.applicationId} IN (${sql.join(
					accessedServices.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			);

			const where = and(...baseConditions);

			const [items, countResult] = await Promise.all([
				db
					.select({
						applicationId: applications.applicationId,
						name: applications.name,
						appName: applications.appName,
						description: applications.description,
						environmentId: applications.environmentId,
						applicationStatus: applications.applicationStatus,
						sourceType: applications.sourceType,
						createdAt: applications.createdAt,
					})
					.from(applications)
					.innerJoin(
						environments,
						eq(applications.environmentId, environments.environmentId),
					)
					.innerJoin(projects, eq(environments.projectId, projects.projectId))
					.where(where)
					.orderBy(desc(applications.createdAt))
					.limit(input.limit)
					.offset(input.offset),
				db
					.select({ count: sql<number>`count(*)::int` })
					.from(applications)
					.innerJoin(
						environments,
						eq(applications.environmentId, environments.environmentId),
					)
					.innerJoin(projects, eq(environments.projectId, projects.projectId))
					.where(where),
			]);

			return c.json({
				items,
				total: countResult[0]?.count ?? 0,
			});
		} catch (error) {
			throw toHttpError(error, "Error searching applications");
		}
	},
);

export default application;

import {
    addDomainToCompose,
    clearOldDeployments,
    cloneCompose,
    createCommand,
    createCompose,
    createComposeByTemplate,
    createDomain,
    createMount,
    deleteMount,
    execAsync,
    execAsyncRemote,
    findComposeById,
    findDomainsByComposeId,
    findEnvironmentById,
    findGitProviderById,
    findProjectById,
    findServerById,
    getComposeContainer,
    getWebServerSettings,
    IS_CLOUD,
    loadServices,
    randomizeComposeFile,
    randomizeIsolatedDeploymentComposeFile,
    removeCompose,
    removeComposeDirectory,
    removeDeploymentsByComposeId,
    removeDomainById,
    startCompose,
    stopCompose,
    updateCompose,
    updateDeploymentStatus,
} from "@dokploy/server";
import {
    addNewService,
    checkServiceAccess,
    checkServicePermissionAndAccess,
    findMemberByUserId,
} from "@dokploy/server/services/permission";
import { db } from "@dokploy/server/db";
import {
    type CompleteTemplate,
    fetchTemplateFiles,
    fetchTemplatesList,
} from "@dokploy/server/templates/github";
import { processTemplate } from "@dokploy/server/templates/processors";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { Hono } from "hono";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import _ from "lodash";
import { nanoid } from "nanoid";
import { parse } from "toml";
import { stringify } from "yaml";
import { z } from "zod";
import type { HonoEnv } from "@/types/hono";
import {
    apiCreateCompose,
    apiDeleteCompose,
    apiDeployCompose,
    apiFetchServices,
    apiFindCompose,
    apiRandomizeCompose,
    apiRedeployCompose,
    apiUpdateCompose,
    compose as composeTable,
    environments,
    projects,
} from "@/db/schema";
import { deploymentWorker } from "@/queues/deployments-queue";
import type { DeploymentJob } from "@/queues/queue-types";
import {
    cleanQueuesByCompose,
    getJobsByComposeId,
    killDockerBuild,
    myQueue,
} from "@/queues/queueSetup";
import { cancelDeployment, deploy } from "@/utils/deploy";
import { generatePassword } from "@/utils/templates";
import { slugify } from "@/utils/slug";
import { audit } from "@/utils/audit";
import { getCtx } from "@/middlewares/auth";
import { toHttpError } from "@/utils/trpc";
import { isAuthed } from "@/middlewares/guards";

const compose = new Hono<HonoEnv>();

compose.use("*", isAuthed);

// POST /create
compose.post("/create", zValidator("json", apiCreateCompose), async (c) => {
    try {
        const input = c.req.valid("json");
        const ctx = getCtx(c);

        const environment = await findEnvironmentById(input.environmentId);
        const project = await findProjectById(environment.projectId);

        await checkServiceAccess(ctx, project.projectId, "create");

        if (IS_CLOUD && !input.serverId) {
            throw new HTTPException(401, {
                message: "You need to use a server to create a compose",
            });
        }

        if (project.organizationId !== ctx.session.activeOrganizationId) {
            throw new HTTPException(401, {
                message: "You are not authorized to access this project",
            });
        }

        const newService = await createCompose({ ...input });
        await addNewService(ctx, newService.composeId);

        await audit(ctx, {
            action: "create",
            resourceType: "service",
            resourceId: newService.composeId,
            resourceName: newService.appName,
        });

        return c.json(newService, 201);
    } catch (error) {
        throw toHttpError(error, "Error creating the compose");
    }
});

// GET /one/:composeId
compose.get(
    "/one/:composeId",
    zValidator("param", z.object({ composeId: z.string() })),
    async (c) => {
        try {
            const { composeId } = c.req.valid("param");
            const ctx = getCtx(c);

            await checkServiceAccess(ctx, composeId, "read");

            const composeData = await findComposeById(composeId);
            if (
                composeData.environment.project.organizationId !==
                ctx.session.activeOrganizationId
            ) {
                throw new HTTPException(401, {
                    message: "You are not authorized to access this compose",
                });
            }

            let hasGitProviderAccess = true;
            let unauthorizedProvider: string | null = null;

            const getGitProviderId = () => {
                switch (composeData.sourceType) {
                    case "github":
                        return composeData.github?.gitProviderId;
                    case "gitlab":
                        return composeData.gitlab?.gitProviderId;
                    case "bitbucket":
                        return composeData.bitbucket?.gitProviderId;
                    case "gitea":
                        return composeData.gitea?.gitProviderId;
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
                        unauthorizedProvider = composeData.sourceType;
                    }
                } catch {
                    hasGitProviderAccess = false;
                    unauthorizedProvider = composeData.sourceType;
                }
            }

            return c.json({ ...composeData, hasGitProviderAccess, unauthorizedProvider });
        } catch (error) {
            throw toHttpError(error, "Error fetching compose");
        }
    },
);

// PUT /update
compose.put("/update", zValidator("json", apiUpdateCompose), async (c) => {
    try {
        const input = c.req.valid("json");
        const ctx = getCtx(c);

        await checkServicePermissionAndAccess(ctx, input.composeId, {
            service: ["create"],
        });

        const updated = await updateCompose(input.composeId, input);

        await audit(ctx, {
            action: "update",
            resourceType: "compose",
            resourceId: input.composeId,
            resourceName: updated?.name,
        });

        return c.json(updated);
    } catch (error) {
        throw toHttpError(error, "Error updating compose");
    }
});

// DELETE /delete
compose.delete("/delete", zValidator("json", apiDeleteCompose), async (c) => {
    try {
        const input = c.req.valid("json");
        const ctx = getCtx(c);

        await checkServiceAccess(ctx, input.composeId, "delete");

        const composeResult = await findComposeById(input.composeId);
        if (
            composeResult.environment.project.organizationId !==
            ctx.session.activeOrganizationId
        ) {
            throw new HTTPException(401, {
                message: "You are not authorized to delete this compose",
            });
        }

        await db
            .delete(composeTable)
            .where(eq(composeTable.composeId, input.composeId))
            .returning();

        if (!IS_CLOUD) {
            const queueJobs = await getJobsByComposeId(input.composeId);
            for (const job of queueJobs) {
                if (job.id) {
                    deploymentWorker.cancelJob(job.id, "User requested cancellation");
                }
            }
        }

        const cleanupOperations = [
            async () => await removeCompose(composeResult, input.deleteVolumes),
            async () => await removeDeploymentsByComposeId(composeResult),
            async () => await removeComposeDirectory(composeResult.appName),
        ];

        for (const operation of cleanupOperations) {
            try {
                await operation();
            } catch (_) { }
        }

        await audit(ctx, {
            action: "delete",
            resourceType: "service",
            resourceId: composeResult.composeId,
            resourceName: composeResult.appName,
        });

        return c.json(composeResult);
    } catch (error) {
        throw toHttpError(error, "Error deleting compose");
    }
});

// POST /clean-queues
compose.post(
    "/clean-queues",
    zValidator("json", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                deployment: ["create"],
            });

            await cleanQueuesByCompose(input.composeId);

            return c.json({ success: true, message: "Queues cleaned successfully" });
        } catch (error) {
            throw toHttpError(error, "Error cleaning queues");
        }
    },
);

// POST /clear-deployments
compose.post(
    "/clear-deployments",
    zValidator("json", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                deployment: ["create"],
            });

            const composeData = await findComposeById(input.composeId);
            await clearOldDeployments(composeData.appName, composeData.serverId);

            await audit(ctx, {
                action: "update",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.name,
            });

            return c.json(true);
        } catch (error) {
            throw toHttpError(error, "Error clearing deployments");
        }
    },
);

// POST /kill-build
compose.post(
    "/kill-build",
    zValidator("json", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                deployment: ["cancel"],
            });

            const composeData = await findComposeById(input.composeId);
            await killDockerBuild("compose", composeData.serverId);

            return c.json({ success: true });
        } catch (error) {
            throw toHttpError(error, "Error killing build");
        }
    },
);

// GET /load-services
compose.get(
    "/load-services",
    zValidator("query", apiFetchServices),
    async (c) => {
        try {
            const input = c.req.valid("query");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const services = await loadServices(input.composeId, input.type);
            return c.json(services);
        } catch (error) {
            throw toHttpError(error, "Error loading services");
        }
    },
);

// GET /load-mounts-by-service
compose.get(
    "/load-mounts-by-service",
    zValidator(
        "query",
        z.object({
            composeId: z.string().min(1),
            serviceName: z.string().min(1),
        }),
    ),
    async (c) => {
        try {
            const input = c.req.valid("query");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const composeData = await findComposeById(input.composeId);
            const container = await getComposeContainer(composeData, input.serviceName);
            const mounts = container?.Mounts.filter(
                (mount) => mount.Type === "volume" && mount.Source !== "",
            );

            return c.json(mounts);
        } catch (error) {
            throw toHttpError(error, "Error loading mounts");
        }
    },
);

// POST /fetch-source-type
compose.post(
    "/fetch-source-type",
    zValidator("json", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const composeData = await findComposeById(input.composeId);
            const command = await cloneCompose(composeData);

            if (composeData.serverId) {
                await execAsyncRemote(composeData.serverId, command);
            } else {
                await execAsync(command);
            }

            return c.json(composeData.sourceType);
        } catch (error) {
            throw toHttpError(error, "Error fetching source type");
        }
    },
);

// POST /randomize-compose
compose.post(
    "/randomize-compose",
    zValidator("json", apiRandomizeCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const result = await randomizeComposeFile(input.composeId, input.suffix);
            const composeData = await findComposeById(input.composeId);

            await audit(ctx, {
                action: "update",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.name,
            });

            return c.json(result);
        } catch (error) {
            throw toHttpError(error, "Error randomizing compose");
        }
    },
);

// POST /isolated-deployment
compose.post(
    "/isolated-deployment",
    zValidator("json", apiRandomizeCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const result = await randomizeIsolatedDeploymentComposeFile(
                input.composeId,
                input.suffix,
            );
            const composeData = await findComposeById(input.composeId);

            await audit(ctx, {
                action: "update",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.name,
            });

            return c.json(result);
        } catch (error) {
            throw toHttpError(error, "Error creating isolated deployment");
        }
    },
);

// GET /get-converted-compose
compose.get(
    "/get-converted-compose",
    zValidator("query", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("query");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const composeData = await findComposeById(input.composeId);
            const domains = await findDomainsByComposeId(input.composeId);
            const composeFile = await addDomainToCompose(composeData, domains);

            return c.json(stringify(composeFile, { lineWidth: 1000 }));
        } catch (error) {
            throw toHttpError(error, "Error getting converted compose");
        }
    },
);

// POST /deploy
compose.post("/deploy", zValidator("json", apiDeployCompose), async (c) => {
    try {
        const input = c.req.valid("json");
        const ctx = getCtx(c);

        await checkServicePermissionAndAccess(ctx, input.composeId, {
            deployment: ["create"],
        });

        const composeData = await findComposeById(input.composeId);

        const jobData: DeploymentJob = {
            composeId: input.composeId,
            titleLog: input.title || "Manual deployment",
            type: "deploy",
            applicationType: "compose",
            descriptionLog: input.description || "",
            server: !!composeData.serverId,
        };

        if (IS_CLOUD && composeData.serverId) {
            jobData.serverId = composeData.serverId;
            deploy(jobData).catch((error) => {
                console.error("Background deployment failed:", error);
            });
            await audit(ctx, {
                action: "deploy",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.name,
            });
            return c.json(true);
        }

        await myQueue.add(
            "deployments",
            { ...jobData },
            { removeOnComplete: true, removeOnFail: true },
        );

        await audit(ctx, {
            action: "deploy",
            resourceType: "compose",
            resourceId: input.composeId,
            resourceName: composeData.name,
        });

        return c.json({
            success: true,
            message: "Deployment queued",
            composeId: composeData.composeId,
        });
    } catch (error) {
        throw toHttpError(error, "Error deploying compose");
    }
});

// POST /redeploy
compose.post("/redeploy", zValidator("json", apiRedeployCompose), async (c) => {
    try {
        const input = c.req.valid("json");
        const ctx = getCtx(c);

        await checkServicePermissionAndAccess(ctx, input.composeId, {
            deployment: ["create"],
        });

        const composeData = await findComposeById(input.composeId);

        const jobData: DeploymentJob = {
            composeId: input.composeId,
            titleLog: input.title || "Rebuild deployment",
            type: "redeploy",
            applicationType: "compose",
            descriptionLog: input.description || "",
            server: !!composeData.serverId,
        };

        if (IS_CLOUD && composeData.serverId) {
            jobData.serverId = composeData.serverId;
            deploy(jobData).catch((error) => {
                console.error("Background deployment failed:", error);
            });
            await audit(ctx, {
                action: "deploy",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.name,
            });
            return c.json(true);
        }

        await myQueue.add(
            "deployments",
            { ...jobData },
            { removeOnComplete: true, removeOnFail: true },
        );

        await audit(ctx, {
            action: "deploy",
            resourceType: "compose",
            resourceId: input.composeId,
            resourceName: composeData.name,
        });

        return c.json({
            success: true,
            message: "Redeployment queued",
            composeId: composeData.composeId,
        });
    } catch (error) {
        throw toHttpError(error, "Error redeploying compose");
    }
});

// POST /stop
compose.post("/stop", zValidator("json", apiFindCompose), async (c) => {
    try {
        const input = c.req.valid("json");
        const ctx = getCtx(c);

        await checkServicePermissionAndAccess(ctx, input.composeId, {
            deployment: ["create"],
        });

        await stopCompose(input.composeId);
        const composeData = await findComposeById(input.composeId);

        await audit(ctx, {
            action: "stop",
            resourceType: "compose",
            resourceId: input.composeId,
            resourceName: composeData.name,
        });

        return c.json(true);
    } catch (error) {
        throw toHttpError(error, "Error stopping compose");
    }
});

// POST /start
compose.post("/start", zValidator("json", apiFindCompose), async (c) => {
    try {
        const input = c.req.valid("json");
        const ctx = getCtx(c);

        await checkServicePermissionAndAccess(ctx, input.composeId, {
            deployment: ["create"],
        });

        await startCompose(input.composeId);
        const composeData = await findComposeById(input.composeId);

        await audit(ctx, {
            action: "start",
            resourceType: "compose",
            resourceId: input.composeId,
            resourceName: composeData.name,
        });

        return c.json(true);
    } catch (error) {
        throw toHttpError(error, "Error starting compose");
    }
});

// GET /get-default-command
compose.get(
    "/get-default-command",
    zValidator("query", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("query");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const composeData = await findComposeById(input.composeId);
            const command = createCommand(composeData);

            return c.json(`docker ${command}`);
        } catch (error) {
            throw toHttpError(error, "Error getting default command");
        }
    },
);

// POST /refresh-token
compose.post(
    "/refresh-token",
    zValidator("json", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            await updateCompose(input.composeId, { refreshToken: nanoid() });
            const composeData = await findComposeById(input.composeId);

            await audit(ctx, {
                action: "update",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.name,
            });

            return c.json(true);
        } catch (error) {
            throw toHttpError(error, "Error refreshing token");
        }
    },
);

// POST /deploy-template
compose.post(
    "/deploy-template",
    zValidator(
        "json",
        z.object({
            environmentId: z.string(),
            serverId: z.string().optional(),
            id: z.string(),
            baseUrl: z.string().optional(),
        }),
    ),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            const environment = await findEnvironmentById(input.environmentId);
            await checkServiceAccess(ctx, environment.projectId, "create");

            if (IS_CLOUD && !input.serverId) {
                throw new HTTPException(401, {
                    message: "You need to use a server to create a compose",
                });
            }

            const template = await fetchTemplateFiles(input.id, input.baseUrl);
            const project = await findProjectById(environment.projectId);

            let serverIp = "127.0.0.1";
            if (input.serverId) {
                const server = await findServerById(input.serverId);
                serverIp = server.ipAddress;
            } else if (process.env.NODE_ENV === "development") {
                serverIp = "127.0.0.1";
            } else {
                const settings = await getWebServerSettings();
                serverIp = settings?.serverIp || "127.0.0.1";
            }

            const projectName = slugify(`${project.name} ${input.id}`);
            const appName = `${projectName}-${generatePassword(6)}`;
            const config = {
                ...template.config,
                variables: {
                    APP_NAME: appName,
                    ...template.config.variables,
                },
            };
            const generate = processTemplate(config, { serverIp, projectName });

            const composeData = await createComposeByTemplate({
                ...input,
                composeFile: template.dockerCompose,
                env: generate.envs?.join("\n"),
                serverId: input.serverId,
                name: input.id,
                sourceType: "raw",
                appName: appName,
                isolatedDeployment: true,
            });

            await addNewService(ctx, composeData.composeId);

            if (generate.mounts && generate.mounts.length > 0) {
                for (const mount of generate.mounts) {
                    await createMount({
                        filePath: mount.filePath,
                        mountPath: "",
                        content: mount.content,
                        serviceId: composeData.composeId,
                        serviceType: "compose",
                        type: "file",
                    });
                }
            }

            if (generate.domains && generate.domains.length > 0) {
                for (const domain of generate.domains) {
                    await createDomain({
                        ...domain,
                        domainType: "compose",
                        certificateType: "none",
                        composeId: composeData.composeId,
                        host: domain.host || "",
                    });
                }
            }

            await audit(ctx, {
                action: "create",
                resourceType: "compose",
                resourceId: composeData.composeId,
                resourceName: composeData.name,
            });

            return c.json(composeData, 201);
        } catch (error) {
            throw toHttpError(error, "Error deploying template");
        }
    },
);

// GET /templates  (público, sin isAuthed)
compose.get(
    "/templates",
    zValidator("query", z.object({ baseUrl: z.string().optional() })),
    async (c) => {
        try {
            const { baseUrl } = c.req.valid("query");
            const githubTemplates = await fetchTemplatesList(baseUrl);
            if (githubTemplates.length > 0) {
                return c.json(githubTemplates);
            }
        } catch (error) {
            console.warn(
                "Failed to fetch templates from GitHub, falling back to local templates:",
                error,
            );
        }
        return c.json([]);
    },
);

// GET /get-tags
compose.get(
    "/get-tags",
    zValidator("query", z.object({ baseUrl: z.string().optional() })),
    async (c) => {
        try {
            const { baseUrl } = c.req.valid("query");
            const githubTemplates = await fetchTemplatesList(baseUrl);
            const allTags = githubTemplates.flatMap((template) => template.tags);
            const uniqueTags = _.uniq(allTags);
            return c.json(uniqueTags);
        } catch (error) {
            throw toHttpError(error, "Error fetching tags");
        }
    },
);

// POST /disconnect-git-provider
compose.post(
    "/disconnect-git-provider",
    zValidator("json", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            await updateCompose(input.composeId, {
                repository: null,
                branch: null,
                owner: null,
                composePath: undefined,
                githubId: null,
                triggerType: "push",

                gitlabRepository: null,
                gitlabOwner: null,
                gitlabBranch: null,
                gitlabId: null,
                gitlabProjectId: null,
                gitlabPathNamespace: null,

                bitbucketRepository: null,
                bitbucketOwner: null,
                bitbucketBranch: null,
                bitbucketId: null,

                giteaRepository: null,
                giteaOwner: null,
                giteaBranch: null,
                giteaId: null,

                customGitBranch: null,
                customGitUrl: null,
                customGitSSHKeyId: null,

                sourceType: "github",
                composeStatus: "idle",
                watchPaths: null,
                enableSubmodules: false,
            });

            const composeData = await findComposeById(input.composeId);
            await audit(ctx, {
                action: "update",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.name,
            });

            return c.json(true);
        } catch (error) {
            throw toHttpError(error, "Error disconnecting git provider");
        }
    },
);

// POST /move
compose.post(
    "/move",
    zValidator(
        "json",
        z.object({
            composeId: z.string(),
            targetEnvironmentId: z.string(),
        }),
    ),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const updatedCompose = await db
                .update(composeTable)
                .set({ environmentId: input.targetEnvironmentId })
                .where(eq(composeTable.composeId, input.composeId))
                .returning()
                .then((res) => res[0]);

            if (!updatedCompose) {
                throw new HTTPException(500, { message: "Failed to move compose" });
            }

            await audit(ctx, {
                action: "update",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: updatedCompose.name,
            });

            return c.json(updatedCompose);
        } catch (error) {
            throw toHttpError(error, "Error moving compose");
        }
    },
);

// POST /process-template
compose.post(
    "/process-template",
    zValidator(
        "json",
        z.object({
            base64: z.string(),
            composeId: z.string().min(1),
        }),
    ),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const composeData = await findComposeById(input.composeId);
            const decodedData = Buffer.from(input.base64, "base64").toString("utf-8");

            let serverIp = "127.0.0.1";
            if (composeData.serverId) {
                const server = await findServerById(composeData.serverId);
                serverIp = server.ipAddress;
            } else if (process.env.NODE_ENV === "development") {
                serverIp = "127.0.0.1";
            } else {
                const settings = await getWebServerSettings();
                serverIp = settings?.serverIp || "127.0.0.1";
            }

            const templateData = JSON.parse(decodedData);
            const config = parse(templateData.config) as CompleteTemplate;

            if (!templateData.compose || !config) {
                throw new HTTPException(400, {
                    message:
                        "Invalid template format. Must contain compose and config fields",
                });
            }

            const configModified = {
                ...config,
                variables: {
                    APP_NAME: composeData.appName,
                    ...config.variables,
                },
            };

            const processedTemplate = processTemplate(configModified, {
                serverIp,
                projectName: composeData.appName,
            });

            return c.json({
                compose: templateData.compose,
                template: processedTemplate,
            });
        } catch (error) {
            throw toHttpError(error, "Error processing template");
        }
    },
);

// POST /import
compose.post(
    "/import",
    zValidator(
        "json",
        z.object({
            base64: z.string(),
            composeId: z.string().min(1),
        }),
    ),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                service: ["create"],
            });

            const composeData = await findComposeById(input.composeId);
            const decodedData = Buffer.from(input.base64, "base64").toString("utf-8");

            for (const mount of composeData.mounts) {
                await deleteMount(mount.mountId);
            }

            for (const domain of composeData.domains) {
                await removeDomainById(domain.domainId);
            }

            let serverIp = "127.0.0.1";
            if (composeData.serverId) {
                const server = await findServerById(composeData.serverId);
                serverIp = server.ipAddress;
            } else if (process.env.NODE_ENV === "development") {
                serverIp = "127.0.0.1";
            } else {
                const settings = await getWebServerSettings();
                serverIp = settings?.serverIp || "127.0.0.1";
            }

            const templateData = JSON.parse(decodedData);
            const config = parse(templateData.config) as CompleteTemplate;

            if (!templateData.compose || !config) {
                throw new HTTPException(400, {
                    message:
                        "Invalid template format. Must contain compose and config fields",
                });
            }

            const configModified = {
                ...config,
                variables: {
                    APP_NAME: composeData.appName,
                    ...config.variables,
                },
            };

            const processedTemplate = processTemplate(configModified, {
                serverIp,
                projectName: composeData.appName,
            });

            await updateCompose(input.composeId, {
                composeFile: templateData.compose,
                sourceType: "raw",
                env: processedTemplate.envs?.join("\n"),
                isolatedDeployment: true,
            });

            if (processedTemplate.mounts && processedTemplate.mounts.length > 0) {
                for (const mount of processedTemplate.mounts) {
                    await createMount({
                        filePath: mount.filePath,
                        mountPath: "",
                        content: mount.content,
                        serviceId: composeData.composeId,
                        serviceType: "compose",
                        type: "file",
                    });
                }
            }

            if (processedTemplate.domains && processedTemplate.domains.length > 0) {
                for (const domain of processedTemplate.domains) {
                    await createDomain({
                        ...domain,
                        domainType: "compose",
                        certificateType: "none",
                        composeId: composeData.composeId,
                        host: domain.host || "",
                    });
                }
            }

            await audit(ctx, {
                action: "update",
                resourceType: "compose",
                resourceId: input.composeId,
                resourceName: composeData.appName,
            });

            return c.json({ success: true, message: "Template imported successfully" });
        } catch (error) {
            throw toHttpError(error, "Error importing template");
        }
    },
);

// POST /cancel-deployment
compose.post(
    "/cancel-deployment",
    zValidator("json", apiFindCompose),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const ctx = getCtx(c);

            await checkServicePermissionAndAccess(ctx, input.composeId, {
                deployment: ["cancel"],
            });

            const composeData = await findComposeById(input.composeId);

            if (IS_CLOUD && composeData.serverId) {
                await updateCompose(input.composeId, { composeStatus: "idle" });

                if (composeData.deployments[0]) {
                    await updateDeploymentStatus(
                        composeData.deployments[0].deploymentId,
                        "done",
                    );
                }

                await cancelDeployment({
                    composeId: input.composeId,
                    applicationType: "compose",
                });

                await audit(ctx, {
                    action: "stop",
                    resourceType: "compose",
                    resourceId: input.composeId,
                    resourceName: composeData.name,
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
            throw toHttpError(error, "Error cancelling deployment");
        }
    },
);

// GET /search
compose.get(
    "/search",
    zValidator(
        "query",
        z.object({
            q: z.string().optional(),
            name: z.string().optional(),
            appName: z.string().optional(),
            description: z.string().optional(),
            projectId: z.string().optional(),
            environmentId: z.string().optional(),
            limit: z.coerce.number().min(1).max(100).default(20),
            offset: z.coerce.number().min(0).default(0),
        }),
    ),
    async (c) => {
        try {
            const input = c.req.valid("query");
            const ctx = getCtx(c);

            const baseConditions = [
                eq(projects.organizationId, ctx.session.activeOrganizationId),
            ];

            if (input.projectId) {
                baseConditions.push(eq(environments.projectId, input.projectId));
            }
            if (input.environmentId) {
                baseConditions.push(
                    eq(composeTable.environmentId, input.environmentId),
                );
            }

            if (input.q?.trim()) {
                const term = `%${input.q.trim()}%`;
                baseConditions.push(
                    or(
                        ilike(composeTable.name, term),
                        ilike(composeTable.appName, term),
                        ilike(composeTable.description ?? "", term),
                    )!,
                );
            }

            if (input.name?.trim()) {
                baseConditions.push(
                    ilike(composeTable.name, `%${input.name.trim()}%`),
                );
            }
            if (input.appName?.trim()) {
                baseConditions.push(
                    ilike(composeTable.appName, `%${input.appName.trim()}%`),
                );
            }
            if (input.description?.trim()) {
                baseConditions.push(
                    ilike(
                        composeTable.description ?? "",
                        `%${input.description.trim()}%`,
                    ),
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
                sql`${composeTable.composeId} IN (${sql.join(
                    accessedServices.map((id) => sql`${id}`),
                    sql`, `,
                )})`,
            );

            const where = and(...baseConditions);

            const [items, countResult] = await Promise.all([
                db
                    .select({
                        composeId: composeTable.composeId,
                        name: composeTable.name,
                        appName: composeTable.appName,
                        description: composeTable.description,
                        environmentId: composeTable.environmentId,
                        composeStatus: composeTable.composeStatus,
                        sourceType: composeTable.sourceType,
                        createdAt: composeTable.createdAt,
                    })
                    .from(composeTable)
                    .innerJoin(
                        environments,
                        eq(composeTable.environmentId, environments.environmentId),
                    )
                    .innerJoin(projects, eq(environments.projectId, projects.projectId))
                    .where(where)
                    .orderBy(desc(composeTable.createdAt))
                    .limit(input.limit)
                    .offset(input.offset),
                db
                    .select({ count: sql<number>`count(*)::int` })
                    .from(composeTable)
                    .innerJoin(
                        environments,
                        eq(composeTable.environmentId, environments.environmentId),
                    )
                    .innerJoin(projects, eq(environments.projectId, projects.projectId))
                    .where(where),
            ]);

            return c.json({
                items,
                total: countResult[0]?.count ?? 0,
            });
        } catch (error) {
            throw toHttpError(error, "Error searching composes");
        }
    },
);

export default compose;

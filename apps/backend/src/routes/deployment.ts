import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import {
    execAsync,
    execAsyncRemote,
    findAllDeploymentsByApplicationId,
    findAllDeploymentsByComposeId,
    findAllDeploymentsByServerId,
    findAllDeploymentsCentralized,
    findDeploymentById,
    IS_CLOUD,
    removeDeployment,
    resolveServicePath,
    updateDeploymentStatus,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
    checkServicePermissionAndAccess,
    findMemberByUserId,
} from "@dokploy/server/services/permission";
import { audit } from "@/utils/audit";
import {
    apiFindAllByApplication,
    apiFindAllByCompose,
    apiFindAllByServer,
    apiFindAllByType,
    deployments,
    server,
} from "@/db/schema";
import { myQueue } from "@/queues/queueSetup";
import { fetchDeployApiJobs, type QueueJobRow } from "@/utils/deploy";
import { isAuthed } from "@/middlewares/guards";

const deployment = new Hono<{ Variables: { session: any } }>();

// Helper para emular el 'ctx' que requieren las funciones de permiso y auditoría
const getCtx = (c: any) => ({
    session: c.get("session"),
    user: c.get("session").user
});

/**
 * RUTAS
 */

// GET /all-by-application
deployment.get("/all-by-application", isAuthed, zValidator("query", apiFindAllByApplication), async (c) => {
    const input = c.req.valid("query");
    const ctx = getCtx(c);

    await checkServicePermissionAndAccess(ctx, input.applicationId, {
        deployment: ["read"],
    });

    const result = await findAllDeploymentsByApplicationId(input.applicationId);
    return c.json(result);
});

// GET /all-by-compose
deployment.get("/all-by-compose", isAuthed, zValidator("query", apiFindAllByCompose), async (c) => {
    const input = c.req.valid("query");
    const ctx = getCtx(c);

    await checkServicePermissionAndAccess(ctx, input.composeId, {
        deployment: ["read"],
    });

    const result = await findAllDeploymentsByComposeId(input.composeId);
    return c.json(result);
});

// GET /all-by-server
deployment.get("/all-by-server", isAuthed, zValidator("query", apiFindAllByServer), async (c) => {
    const input = c.req.valid("query");
    // Nota: Aquí se usaba withPermission("deployment", "read") en tRPC
    const result = await findAllDeploymentsByServerId(input.serverId);
    return c.json(result);
});

// GET /all-centralized
deployment.get("/all-centralized", isAuthed, async (c) => {
    const ctx = getCtx(c);
    const orgId = ctx.session.activeOrganizationId;

    const accessedServices =
        ctx.user.role !== "owner" && ctx.user.role !== "admin"
            ? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
            : null;

    if (accessedServices !== null && accessedServices.length === 0) {
        return c.json([]);
    }

    const result = await findAllDeploymentsCentralized(orgId, accessedServices);
    return c.json(result);
});

// GET /queue-list
deployment.get("/queue-list", isAuthed, async (c) => {
    const ctx = getCtx(c);
    const orgId = ctx.session.activeOrganizationId;
    let rows: QueueJobRow[];

    if (IS_CLOUD) {
        const servers = await db.query.server.findMany({
            where: eq(server.organizationId, orgId),
            columns: { serverId: true },
        });
        const serverRowsArrays = await Promise.all(
            servers.map(({ serverId }) => fetchDeployApiJobs(serverId)),
        );
        rows = serverRowsArrays.flat();
        rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    } else {
        const jobs = await myQueue.getJobs();
        const jobRows = await Promise.all(
            jobs.map(async (job) => {
                const state = await job.getState();
                return {
                    id: String(job.id),
                    name: job.name ?? undefined,
                    data: job.data as Record<string, unknown>,
                    timestamp: job.timestamp,
                    processedOn: job.processedOn,
                    finishedOn: job.finishedOn,
                    failedReason: job.failedReason ?? undefined,
                    state,
                };
            }),
        );
        jobRows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
        rows = jobRows;
    }

    const result = await Promise.all(
        rows.map(async (row) => ({
            ...row,
            servicePath: await resolveServicePath(
                orgId,
                (row.data ?? {}) as Record<string, unknown>,
            ),
        })),
    );

    return c.json(result);
});

// GET /all-by-type
deployment.get("/all-by-type", isAuthed, zValidator("query", apiFindAllByType), async (c) => {
    const input = c.req.valid("query");
    const ctx = getCtx(c);

    await checkServicePermissionAndAccess(ctx, input.id, {
        deployment: ["read"],
    });

    const deploymentsList = await db.query.deployments.findMany({
        where: eq(deployments[`${input.type}Id`], input.id),
        orderBy: desc(deployments.createdAt),
        with: {
            rollback: true,
        },
    });
    return c.json(deploymentsList);
});

// POST /kill-process
deployment.post("/kill-process", isAuthed, zValidator("json", z.object({
    deploymentId: z.string().min(1),
})), async (c) => {
    const { deploymentId } = c.req.valid("json");
    const ctx = getCtx(c);

    const deploymentData = await findDeploymentById(deploymentId);
    const serviceId = deploymentData.applicationId || deploymentData.composeId;

    if (serviceId) {
        await checkServicePermissionAndAccess(ctx, serviceId, {
            deployment: ["cancel"],
        });
    }

    if (!deploymentData.pid) {
        throw new HTTPException(400, { message: "Deployment is not running" });
    }

    const command = `kill -9 ${deploymentData.pid}`;
    if (deploymentData.schedule?.serverId) {
        await execAsyncRemote(deploymentData.schedule.serverId, command);
    } else {
        await execAsync(command);
    }

    await updateDeploymentStatus(deploymentData.deploymentId, "error");
    await audit(ctx, {
        action: "cancel",
        resourceType: "deployment",
        resourceId: deploymentData.deploymentId,
    });

    return c.json({ success: true });
});

// DELETE /remove/:deploymentId
deployment.delete("/remove/:deploymentId", isAuthed, async (c) => {
    const deploymentId = c.req.param("deploymentId");
    const ctx = getCtx(c);

    const deploymentData = await findDeploymentById(deploymentId);
    const serviceId = deploymentData.applicationId || deploymentData.composeId;

    if (serviceId) {
        await checkServicePermissionAndAccess(ctx, serviceId, {
            deployment: ["cancel"],
        });
    }

    const result = await removeDeployment(deploymentId);

    await audit(ctx, {
        action: "delete",
        resourceType: "deployment",
        resourceId: deploymentData.deploymentId,
    });

    return c.json(result);
});

export default deployment;
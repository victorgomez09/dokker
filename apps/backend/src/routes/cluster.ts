import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
    type DockerNode,
    execAsync,
    execAsyncRemote,
    findServerById,
    getRemoteDocker,
} from "@dokploy/server";
import { audit } from "@/utils/audit";
import { getLocalServerIp } from "@/wss/terminal";
import { isAuthed } from "@/middlewares/guards";

const cluster = new Hono<{ Variables: { session: any } }>();

const getCtx = (c: any) => ({ session: c.get("session") });

/**
 * RUTAS
 */

// GET /nodes
cluster.get("/nodes", isAuthed, zValidator("query", z.object({
    serverId: z.string().optional(),
})), async (c) => {
    const { serverId } = c.req.valid("query");

    const docker = await getRemoteDocker(serverId);
    const workers: DockerNode[] = await docker.listNodes();
    return c.json(workers);
});

// POST /remove-worker
cluster.post("/remove-worker", isAuthed, zValidator("json", z.object({
    nodeId: z.string(),
    serverId: z.string().optional(),
})), async (c) => {
    const { nodeId, serverId } = c.req.valid("json");
    const ctx = getCtx(c);

    try {
        const drainCommand = `docker node update --availability drain ${nodeId}`;
        const removeCommand = `docker node rm ${nodeId} --force`;

        if (serverId) {
            await execAsyncRemote(serverId, drainCommand);
            await execAsyncRemote(serverId, removeCommand);
        } else {
            await execAsync(drainCommand);
            await execAsync(removeCommand);
        }

        await audit(ctx, {
            action: "delete",
            resourceType: "cluster",
            resourceId: nodeId,
            resourceName: nodeId,
        });

        return c.json({ success: true });
    } catch (error) {
        throw new HTTPException(500, {
            message: "Error removing the node",
            cause: error
        });
    }
});

// GET /add-worker
cluster.get("/add-worker", isAuthed, zValidator("query", z.object({
    serverId: z.string().optional(),
})), async (c) => {
    const { serverId } = c.req.valid("query");

    const docker = await getRemoteDocker(serverId);
    const result = await docker.swarmInspect();
    const docker_version = await docker.version();

    let ip = await getLocalServerIp();
    if (serverId) {
        const server = await findServerById(serverId);
        ip = server?.ipAddress;
    }

    return c.json({
        command: `docker swarm join --token ${result.JoinTokens.Worker} ${ip}:2377`,
        version: docker_version.Version,
    });
});

// GET /add-manager
cluster.get("/add-manager", isAuthed, zValidator("query", z.object({
    serverId: z.string().optional(),
})), async (c) => {
    const { serverId } = c.req.valid("query");

    const docker = await getRemoteDocker(serverId);
    const result = await docker.swarmInspect();
    const docker_version = await docker.version();

    let ip = await getLocalServerIp();
    if (serverId) {
        const server = await findServerById(serverId);
        ip = server?.ipAddress;
    }

    return c.json({
        command: `docker swarm join --token ${result.JoinTokens.Manager} ${ip}:2377`,
        version: docker_version.Version,
    });
});

export default cluster;
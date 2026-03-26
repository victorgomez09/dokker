import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
    containerRemove,
    containerRestart,
    findServerById,
    getConfig,
    getContainers,
    getContainersByAppLabel,
    getContainersByAppNameMatch,
    getServiceContainersByAppName,
    getStackContainersByAppName,
} from "@dokploy/server";
import { audit } from "@/utils/audit";
import { isAuthed } from "@/middlewares/guards";

const docker = new Hono<{ Variables: { session: any } }>();

const getCtx = (c: any) => ({ session: c.get("session") });

export const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

/**
 * Middleware interno para validar la propiedad del servidor
 */
const validateServerAccess = async (serverId: string | undefined, session: any) => {
    if (serverId) {
        const server = await findServerById(serverId);
        if (server.organizationId !== session?.activeOrganizationId) {
            throw new HTTPException(401, { message: "Unauthorized access to this server" });
        }
    }
};

/**
 * RUTAS
 */

// GET /containers
docker.get("/containers", isAuthed, zValidator("query", z.object({
    serverId: z.string().optional(),
})), async (c) => {
    const { serverId } = c.req.valid("query");
    const session = c.get("session");

    await validateServerAccess(serverId, session);
    const result = await getContainers(serverId);
    return c.json(result);
});

// POST /restart
docker.post("/restart", isAuthed, zValidator("json", z.object({
    containerId: z.string().min(1).regex(containerIdRegex, "Invalid container id."),
})), async (c) => {
    const { containerId } = c.req.valid("json");
    const ctx = getCtx(c);

    const result = await containerRestart(containerId);

    await audit(ctx, {
        action: "start",
        resourceType: "docker",
        resourceId: containerId,
        resourceName: containerId,
    });

    return c.json(result);
});

// DELETE /remove
docker.delete("/remove", isAuthed, zValidator("json", z.object({
    containerId: z.string().min(1).regex(containerIdRegex, "Invalid container id."),
    serverId: z.string().optional(),
})), async (c) => {
    const { containerId, serverId } = c.req.valid("json");
    const session = c.get("session");
    const ctx = getCtx(c);

    await validateServerAccess(serverId, session);

    await containerRemove(containerId, serverId);

    await audit(ctx, {
        action: "delete",
        resourceType: "docker",
        resourceId: containerId,
        resourceName: containerId,
    });

    return c.json({ success: true });
});

// GET /config
docker.get("/config", isAuthed, zValidator("query", z.object({
    containerId: z.string().min(1).regex(containerIdRegex, "Invalid container id."),
    serverId: z.string().optional(),
})), async (c) => {
    const { containerId, serverId } = c.req.valid("query");
    const session = c.get("session");

    await validateServerAccess(serverId, session);
    const result = await getConfig(containerId, serverId);
    return c.json(result);
});

// GET /by-app-name-match
docker.get("/by-app-name-match", isAuthed, zValidator("query", z.object({
    appType: z.enum(["stack", "docker-compose"]).optional(),
    appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
    serverId: z.string().optional(),
})), async (c) => {
    const { appName, appType, serverId } = c.req.valid("query");
    const session = c.get("session");

    await validateServerAccess(serverId, session);
    const result = await getContainersByAppNameMatch(appName, appType, serverId);
    return c.json(result);
});

// GET /by-app-label
docker.get("/by-app-label", isAuthed, zValidator("query", z.object({
    appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
    serverId: z.string().optional(),
    type: z.enum(["standalone", "swarm"]),
})), async (c) => {
    const { appName, serverId, type } = c.req.valid("query");
    const session = c.get("session");

    await validateServerAccess(serverId, session);
    const result = await getContainersByAppLabel(appName, type, serverId);
    return c.json(result);
});

// GET /stack-containers
docker.get("/stack-containers", isAuthed, zValidator("query", z.object({
    appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
    serverId: z.string().optional(),
})), async (c) => {
    const { appName, serverId } = c.req.valid("query");
    const session = c.get("session");

    await validateServerAccess(serverId, session);
    const result = await getStackContainersByAppName(appName, serverId);
    return c.json(result);
});

// GET /service-containers
docker.get("/service-containers", isAuthed, zValidator("query", z.object({
    appName: z.string().min(1).regex(containerIdRegex, "Invalid app name."),
    serverId: z.string().optional(),
})), async (c) => {
    const { appName, serverId } = c.req.valid("query");
    const session = c.get("session");

    await validateServerAccess(serverId, session);
    const result = await getServiceContainersByAppName(appName, serverId);
    return c.json(result);
});

export default docker;
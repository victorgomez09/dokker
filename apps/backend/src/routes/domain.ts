import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
    createDomain,
    findApplicationById,
    findDomainById,
    findDomainsByApplicationId,
    findDomainsByComposeId,
    findPreviewDeploymentById,
    findServerById,
    generateTraefikMeDomain,
    getWebServerSettings,
    manageDomain,
    removeDomain,
    removeDomainById,
    updateDomainById,
    validateDomain,
} from "@dokploy/server";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { audit } from "@/utils/audit";
import {
    apiCreateDomain,
    apiFindCompose,
    apiFindDomain,
    apiFindOneApplication,
    apiUpdateDomain,
} from "@/db/schema";
import { isAuthed } from "@/middlewares/guards";

const domain = new Hono<{ Variables: { session: any } }>();

const getCtx = (c: any) => ({
    session: c.get("session"),
    user: c.get("session").user
});

/**
 * RUTAS
 */

// POST /create
domain.post("/create", isAuthed, zValidator("json", apiCreateDomain), async (c) => {
    const input = c.req.valid("json");
    const ctx = getCtx(c);

    try {
        if (input.domainType === "compose" && input.composeId) {
            await checkServicePermissionAndAccess(ctx, input.composeId, {
                domain: ["create"],
            });
        } else if (input.domainType === "application" && input.applicationId) {
            await checkServicePermissionAndAccess(ctx, input.applicationId, {
                domain: ["create"],
            });
        }

        const newDomain = await createDomain(input);

        await audit(ctx, {
            action: "create",
            resourceType: "domain",
            resourceId: newDomain.domainId,
            resourceName: newDomain.host,
        });

        return c.json(newDomain);
    } catch (error: any) {
        throw new HTTPException(400, {
            message: error instanceof Error ? error.message : "Error creating the domain",
            cause: error
        });
    }
});

// GET /by-application/:applicationId
domain.get("/by-application/:applicationId", isAuthed, async (c) => {
    const applicationId = c.req.param("applicationId");
    const ctx = getCtx(c);

    await checkServicePermissionAndAccess(ctx, applicationId, {
        domain: ["read"],
    });

    const result = await findDomainsByApplicationId(applicationId);
    return c.json(result);
});

// GET /by-compose/:composeId
domain.get("/by-compose/:composeId", isAuthed, async (c) => {
    const composeId = c.req.param("composeId");
    const ctx = getCtx(c);

    await checkServicePermissionAndAccess(ctx, composeId, {
        domain: ["read"],
    });

    const result = await findDomainsByComposeId(composeId);
    return c.json(result);
});

// POST /generate
domain.post("/generate", isAuthed, zValidator("json", z.object({
    appName: z.string(),
    serverId: z.string().optional()
})), async (c) => {
    const { appName, serverId } = c.req.valid("json");
    const ctx = getCtx(c);

    const result = await generateTraefikMeDomain(
        appName,
        ctx.user.ownerId,
        serverId,
    );
    return c.json(result);
});

// GET /can-generate-traefik-me
domain.get("/can-generate-traefik-me", isAuthed, zValidator("query", z.object({
    serverId: z.string().optional()
})), async (c) => {
    const { serverId } = c.req.valid("query");

    if (serverId) {
        const server = await findServerById(serverId);
        return c.json(server.ipAddress);
    }

    const settings = await getWebServerSettings();
    return c.json(settings?.serverIp || "");
});

// POST /update
domain.post("/update", isAuthed, zValidator("json", apiUpdateDomain), async (c) => {
    const input = c.req.valid("json");
    const ctx = getCtx(c);

    const currentDomain = await findDomainById(input.domainId);
    const serviceId = currentDomain.applicationId || currentDomain.composeId;

    if (serviceId) {
        await checkServicePermissionAndAccess(ctx, serviceId, {
            domain: ["create"],
        });
    } else if (currentDomain.previewDeploymentId) {
        const preview = await findPreviewDeploymentById(currentDomain.previewDeploymentId);
        await checkServicePermissionAndAccess(ctx, preview.applicationId, {
            domain: ["create"],
        });
    }

    await updateDomainById(input.domainId, input);
    const updatedDomain = await findDomainById(input.domainId);

    await audit(ctx, {
        action: "update",
        resourceType: "domain",
        resourceId: updatedDomain.domainId,
        resourceName: updatedDomain.host,
    });

    // Lógica de Traefik
    if (updatedDomain.applicationId) {
        const application = await findApplicationById(updatedDomain.applicationId);
        await manageDomain(application, updatedDomain);
    } else if (updatedDomain.previewDeploymentId) {
        const previewDeployment = await findPreviewDeploymentById(updatedDomain.previewDeploymentId);
        const application = await findApplicationById(previewDeployment.applicationId);
        application.appName = previewDeployment.appName;
        await manageDomain(application, updatedDomain);
    }

    return c.json(updatedDomain);
});

// GET /one/:domainId
domain.get("/one/:domainId", isAuthed, async (c) => {
    const domainId = c.req.param("domainId");
    const ctx = getCtx(c);

    const domainData = await findDomainById(domainId);
    const serviceId = domainData.applicationId || domainData.composeId;

    if (serviceId) {
        await checkServicePermissionAndAccess(ctx, serviceId, { domain: ["read"] });
    } else if (domainData.previewDeploymentId) {
        const preview = await findPreviewDeploymentById(domainData.previewDeploymentId);
        await checkServicePermissionAndAccess(ctx, preview.applicationId, { domain: ["read"] });
    }

    return c.json(domainData);
});

// DELETE /remove/:domainId
domain.delete("/remove/:domainId", isAuthed, async (c) => {
    const domainId = c.req.param("domainId");
    const ctx = getCtx(c);

    const domainData = await findDomainById(domainId);
    const serviceId = domainData.applicationId || domainData.composeId;

    if (serviceId) {
        await checkServicePermissionAndAccess(ctx, serviceId, { domain: ["delete"] });
    } else if (domainData.previewDeploymentId) {
        const preview = await findPreviewDeploymentById(domainData.previewDeploymentId);
        await checkServicePermissionAndAccess(ctx, preview.applicationId, { domain: ["delete"] });
    }

    const result = await removeDomainById(domainId);

    await audit(ctx, {
        action: "delete",
        resourceType: "domain",
        resourceId: domainData.domainId,
        resourceName: domainData.host,
    });

    if (domainData.applicationId) {
        const application = await findApplicationById(domainData.applicationId);
        await removeDomain(application, domainData.uniqueConfigKey);
    }

    return c.json(result);
});

// POST /validate
domain.post("/validate", isAuthed, zValidator("json", z.object({
    domain: z.string(),
    serverIp: z.string().optional(),
})), async (c) => {
    const { domain: host, serverIp } = c.req.valid("json");
    const result = await validateDomain(host, serverIp);
    return c.json(result);
});

export default domain;
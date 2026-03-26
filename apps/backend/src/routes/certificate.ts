import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import {
    createCertificate,
    findCertificateById,
    IS_CLOUD,
    removeCertificateById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { audit } from "@/utils/audit";
import {
    apiCreateCertificate,
    apiFindCertificate,
    certificates,
} from "@/db/schema";
import { isAuthed } from "@/middlewares/guards";

const certificate = new Hono<{ Variables: { session: any } }>();

// Helper para el contexto de auditoría y servicios
const getCtx = (c: any) => ({ session: c.get("session") });

/**
 * RUTAS
 */

// POST /create
certificate.post("/create", isAuthed, zValidator("json", apiCreateCertificate), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");
    const ctx = getCtx(c);

    if (IS_CLOUD && !input.serverId) {
        throw new HTTPException(401, {
            message: "Please set a server to create a certificate"
        });
    }

    try {
        const cert = await createCertificate(
            input,
            session.activeOrganizationId,
        );

        await audit(ctx, {
            action: "create",
            resourceType: "certificate",
            resourceId: cert.certificateId,
            resourceName: cert.name,
        });

        return c.json(cert);
    } catch (error: any) {
        throw new HTTPException(400, { message: error.message || "Error creating certificate" });
    }
});

// GET /one/:certificateId
certificate.get("/one/:certificateId", isAuthed, async (c) => {
    const certificateId = c.req.param("certificateId");
    const session = c.get("session");

    const cert = await findCertificateById(certificateId);

    if (cert.organizationId !== session.activeOrganizationId) {
        throw new HTTPException(401, {
            message: "You are not allowed to access this certificate"
        });
    }

    return c.json(cert);
});

// DELETE /remove/:certificateId
certificate.delete("/remove/:certificateId", isAuthed, async (c) => {
    const certificateId = c.req.param("certificateId");
    const session = c.get("session");
    const ctx = getCtx(c);

    const cert = await findCertificateById(certificateId);

    if (cert.organizationId !== session.activeOrganizationId) {
        throw new HTTPException(401, {
            message: "You are not allowed to delete this certificate"
        });
    }

    await audit(ctx, {
        action: "delete",
        resourceType: "certificate",
        resourceId: cert.certificateId,
        resourceName: cert.name,
    });

    await removeCertificateById(certificateId);

    return c.json({ success: true });
});

// GET /all
certificate.get("/all", isAuthed, async (c) => {
    const session = c.get("session");

    const result = await db.query.certificates.findMany({
        where: eq(certificates.organizationId, session.activeOrganizationId),
    });

    return c.json(result);
});

export default certificate;
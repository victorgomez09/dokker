import { createAuditLog } from "@dokploy/server/services/proprietary/audit-log";
import type { AuditAction, AuditResourceType } from "@dokploy/server/db/schema";

interface AuditCtx {
    session: {
        activeOrganizationId: string;
        user: {
            id: string;
            email: string;
            role: string;
        };
    };
}

interface AuditEvent {
    action: AuditAction;
    resourceType: AuditResourceType;
    resourceId?: string;
    resourceName?: string;
    metadata?: Record<string, unknown>;
}

/**
 * Crea una entrada en el log de auditoría desde el contexto de Hono.
 * Extrae automáticamente userId, userEmail, userRole y organizationId.
 * * Uso en Hono:
 * const ctx = { session: c.get("session") };
 * await audit(ctx, { action: "create", resourceType: "project" });
 */
export const audit = async (ctx: AuditCtx, event: AuditEvent) => {
    // Verificación de seguridad por si la sesión es nula
    if (!ctx.session || !ctx.session.user) {
        console.error("Audit failed: No session found in context");
        return;
    }

    return await createAuditLog({
        organizationId: ctx.session.activeOrganizationId,
        userId: ctx.session.user.id,
        userEmail: ctx.session.user.email,
        userRole: ctx.session.user.role,
        ...event,
    });
};
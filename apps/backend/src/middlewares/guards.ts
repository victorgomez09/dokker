import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { hasValidLicense } from "@dokploy/server/index";
import { checkPermission } from "@dokploy/server/services/permission";
import { HonoEnv } from '../types/hono';
import type { statements } from "@dokploy/server/lib/access-control";

type Resource = keyof typeof statements;
type ActionOf<R extends Resource> = (typeof statements)[R][number];

// Middleware equivalente a protectedProcedure
export const isAuthed = createMiddleware<HonoEnv>(async (c, next) => {
    const user = c.get('user');
    const session = c.get('session');

    if (!session || !user) {
        throw new HTTPException(401, { message: 'UNAUTHORIZED' });
    }
    await next();
});

// Middleware equivalente a adminProcedure / cliProcedure
export const isAdmin = createMiddleware<HonoEnv>(async (c, next) => {
    const user = c.get('user');
    const session = c.get('session');

    if (!session || !user || (user.role !== "owner" && user.role !== "admin")) {
        throw new HTTPException(401, { message: 'UNAUTHORIZED' });
    }
    await next();
});

// Middleware equivalente a enterpriseProcedure
export const isEnterprise = createMiddleware<HonoEnv>(async (c, next) => {
    // Primero verificamos que sea admin
    const user = c.get('user');
    const session = c.get('session');

    if (!session || !user || (user.role !== "owner" && user.role !== "admin")) {
        throw new HTTPException(401, { message: 'UNAUTHORIZED' });
    }

    const validLicense = await hasValidLicense(session.activeOrganizationId);
    if (!validLicense) {
        throw new HTTPException(403, { message: 'Valid enterprise license required' });
    }
    await next();
});

// Factory equivalente a withPermission
export const withPermission = <R extends Resource>(resource: R, action: ActionOf<R>) =>
    createMiddleware<HonoEnv>(async (c, next) => {
        const user = c.get('user');
        const session = c.get('session');
        const db = c.get('db');

        // Reconstruimos el objeto ctx que espera checkPermission
        const ctx = { user, session, db };

        await checkPermission(ctx as any, { [resource]: [action] } as any);
        await next();
    });
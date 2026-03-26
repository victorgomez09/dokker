import { createMiddleware } from 'hono/factory';
import { validateRequest } from "@dokploy/server/lib/auth";
import { db } from "@dokploy/server/db";
import { HonoEnv } from '../types/hono';
import { HTTPException } from 'hono/http-exception';

export const contextMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
    const { session, user } = await validateRequest(c.req.raw as any);

    c.set('db', db);

    c.set('session', session ? {
        ...session,
        activeOrganizationId: session.activeOrganizationId || "",
    } : null);

    c.set('user', user ? {
        ...user,
        role: user.role as "owner" | "member" | "admin",
        ownerId: user.ownerId,
    } : null);

    await next();
});

export const getCtx = (c: any) => {
    const user = c.get("user");
    const session = c.get("session");

    if (!user || !session) {
        throw new HTTPException(401, { message: "UNAUTHORIZED" });
    }

    return { user, session };
};
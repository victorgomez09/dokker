import {
    apiCreateEnvironment,
    apiDuplicateEnvironment,
    apiUpdateEnvironment,
    environments,
    projects
} from "@/db/schema";
import { isAuthed } from "@/middlewares/guards";
import { audit } from "@/utils/audit";
import {
    createEnvironment,
    deleteEnvironment,
    duplicateEnvironment,
    findEnvironmentById,
    findEnvironmentsByProjectId,
    updateEnvironmentById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import {
    addNewEnvironment,
    checkEnvironmentAccess,
    checkEnvironmentCreationPermission,
    checkEnvironmentDeletionPermission,
    checkPermission,
    findMemberByUserId,
} from "@dokploy/server/services/permission";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

const environment = new Hono<{ Variables: { session: any } }>();

// Helper para replicar el contexto de tRPC
const getCtx = (c: any) => ({
    session: c.get("session"),
    user: c.get("session").user
});

/**
 * Lógica de negocio para filtrar servicios basada en permisos del miembro
 */
const filterEnvironmentServices = (
    environment: any,
    accessedServices: string[],
) => ({
    ...environment,
    applications: environment.applications.filter((app: any) =>
        accessedServices.includes(app.applicationId),
    ),
    compose: environment.compose.filter((comp: any) =>
        accessedServices.includes(comp.composeId),
    ),
    libsql: environment.libsql.filter((db: any) =>
        accessedServices.includes(db.libsqlId),
    ),
    mariadb: environment.mariadb.filter((db: any) =>
        accessedServices.includes(db.mariadbId),
    ),
    mongo: environment.mongo.filter((db: any) =>
        accessedServices.includes(db.mongoId),
    ),
    mysql: environment.mysql.filter((db: any) =>
        accessedServices.includes(db.mysqlId),
    ),
    postgres: environment.postgres.filter((db: any) =>
        accessedServices.includes(db.postgresId),
    ),
    redis: environment.redis.filter((db: any) =>
        accessedServices.includes(db.redisId),
    ),
});

/**
 * RUTAS
 */

// POST /create
environment.post("/create", isAuthed, zValidator("json", apiCreateEnvironment), async (c) => {
    const input = c.req.valid("json");
    const ctx = getCtx(c);

    try {
        await checkEnvironmentCreationPermission(ctx, input.projectId);

        if (input.name === "production") {
            throw new HTTPException(400, { message: "You cannot create a environment with the name 'production'" });
        }

        const newEnv = await createEnvironment(input);

        await addNewEnvironment(ctx, newEnv.environmentId);
        await audit(ctx, {
            action: "create",
            resourceType: "environment",
            resourceId: newEnv.environmentId,
            resourceName: newEnv.name,
        });

        return c.json(newEnv);
    } catch (error: any) {
        if (error instanceof HTTPException) throw error;
        throw new HTTPException(400, {
            message: `Error creating the environment: ${error instanceof Error ? error.message : error}`,
        });
    }
});

// GET /one/:environmentId
environment.get("/one/:environmentId", isAuthed, async (c) => {
    const environmentId = c.req.param("environmentId");
    const ctx = getCtx(c);

    const env = await findEnvironmentById(environmentId);

    if (env.project.organizationId !== ctx.session.activeOrganizationId) {
        throw new HTTPException(403, { message: "You are not allowed to access this environment" });
    }

    if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
        const { accessedEnvironments, accessedServices } = await findMemberByUserId(
            ctx.user.id,
            ctx.session.activeOrganizationId,
        );

        if (!accessedEnvironments.includes(env.environmentId)) {
            throw new HTTPException(403, { message: "You are not allowed to access this environment" });
        }

        return c.json(filterEnvironmentServices(env, accessedServices));
    }

    return c.json(env);
});

// GET /by-project/:projectId
environment.get("/by-project/:projectId", isAuthed, async (c) => {
    const projectId = c.req.param("projectId");
    const ctx = getCtx(c);

    try {
        const envs = await findEnvironmentsByProjectId(projectId);

        if (envs.some((e) => e.project.organizationId !== ctx.session.activeOrganizationId)) {
            throw new HTTPException(403, { message: "You are not allowed to access this environment" });
        }

        if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
            const { accessedEnvironments, accessedServices } = await findMemberByUserId(
                ctx.user.id,
                ctx.session.activeOrganizationId,
            );

            const filtered = envs
                .filter((e) => accessedEnvironments.includes(e.environmentId))
                .map((e) => filterEnvironmentServices(e, accessedServices));

            return c.json(filtered);
        }

        return c.json(envs);
    } catch (error: any) {
        if (error instanceof HTTPException) throw error;
        throw new HTTPException(400, { message: "Error fetching environments" });
    }
});

// DELETE /remove/:environmentId
environment.delete("/remove/:environmentId", isAuthed, async (c) => {
    const environmentId = c.req.param("environmentId");
    const ctx = getCtx(c);

    const env = await findEnvironmentById(environmentId);

    if (env.project.organizationId !== ctx.session.activeOrganizationId) {
        throw new HTTPException(403, { message: "You are not allowed to access this environment" });
    }

    if (env.isDefault) {
        throw new HTTPException(400, { message: "You cannot delete the default environment" });
    }

    await checkEnvironmentDeletionPermission(ctx, env.projectId);
    await checkEnvironmentAccess(ctx, environmentId, "read");

    const deleted = await deleteEnvironment(environmentId);

    await audit(ctx, {
        action: "delete",
        resourceType: "environment",
        resourceId: deleted?.environmentId,
        resourceName: deleted?.name,
    });

    return c.json(deleted);
});

// POST /update
environment.post("/update", isAuthed, zValidator("json", apiUpdateEnvironment), async (c) => {
    const { environmentId, ...updateData } = c.req.valid("json");
    const ctx = getCtx(c);

    await checkEnvironmentAccess(ctx, environmentId, "read");

    if (updateData.env !== undefined) {
        await checkPermission(ctx, { environmentEnvVars: ["write"] });
    }

    const currentEnv = await findEnvironmentById(environmentId);

    if (currentEnv.isDefault && updateData.name !== undefined) {
        throw new HTTPException(400, { message: "You cannot rename the default environment" });
    }

    if (currentEnv.project.organizationId !== ctx.session.activeOrganizationId) {
        throw new HTTPException(403, { message: "You are not allowed to access this environment" });
    }

    if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
        const { accessedEnvironments } = await findMemberByUserId(
            ctx.user.id,
            ctx.session.activeOrganizationId,
        );

        if (!accessedEnvironments.includes(currentEnv.environmentId)) {
            throw new HTTPException(403, { message: "You are not allowed to update this environment" });
        }
    }

    const updated = await updateEnvironmentById(environmentId, updateData);

    if (updated) {
        await audit(ctx, {
            action: "update",
            resourceType: "environment",
            resourceId: updated.environmentId,
            resourceName: updated.name,
        });
    }

    return c.json(updated);
});

// POST /duplicate
environment.post("/duplicate", isAuthed, zValidator("json", apiDuplicateEnvironment), async (c) => {
    const input = c.req.valid("json");
    const ctx = getCtx(c);

    await checkEnvironmentAccess(ctx, input.environmentId, "read");
    const env = await findEnvironmentById(input.environmentId);

    if (env.project.organizationId !== ctx.session.activeOrganizationId) {
        throw new HTTPException(403, { message: "You are not allowed to access this environment" });
    }

    if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
        const { accessedEnvironments } = await findMemberByUserId(
            ctx.user.id,
            ctx.session.activeOrganizationId,
        );

        if (!accessedEnvironments.includes(env.environmentId)) {
            throw new HTTPException(403, { message: "You are not allowed to duplicate this environment" });
        }
    }

    const duplicated = await duplicateEnvironment(input);

    await audit(ctx, {
        action: "create",
        resourceType: "environment",
        resourceId: duplicated.environmentId,
        resourceName: duplicated.name,
        metadata: { duplicatedFrom: input.environmentId },
    });

    return c.json(duplicated);
});

// GET /search (con soporte para paginación y filtros)
environment.get("/search", isAuthed, zValidator("query", z.object({
    q: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    projectId: z.string().optional(),
    limit: z.coerce.number().min(1).max(100).default(20),
    offset: z.coerce.number().min(0).default(0),
})), async (c) => {
    const input = c.req.valid("query");
    const ctx = getCtx(c);

    const baseConditions = [
        eq(projects.organizationId, ctx.session.activeOrganizationId),
    ];

    if (input.projectId) {
        baseConditions.push(eq(environments.projectId, input.projectId));
    }

    if (input.q?.trim()) {
        const term = `%${input.q.trim()}%`;
        baseConditions.push(
            or(
                ilike(environments.name, term),
                ilike(environments.description ?? "", term),
            )!
        );
    }

    if (input.name?.trim()) {
        baseConditions.push(ilike(environments.name, `%${input.name.trim()}%`));
    }

    if (input.description?.trim()) {
        baseConditions.push(ilike(environments.description ?? "", `%${input.description.trim()}%`));
    }

    if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
        const { accessedEnvironments } = await findMemberByUserId(
            ctx.user.id,
            ctx.session.activeOrganizationId,
        );
        if (accessedEnvironments.length === 0) return c.json({ items: [], total: 0 });

        baseConditions.push(
            sql`${environments.environmentId} IN (${sql.join(
                accessedEnvironments.map((id) => sql`${id}`),
                sql`, `,
            )})`
        );
    }

    const where = and(...baseConditions);

    const [items, countResult] = await Promise.all([
        db
            .select({
                environmentId: environments.environmentId,
                name: environments.name,
                description: environments.description,
                createdAt: environments.createdAt,
                env: environments.env,
                projectId: environments.projectId,
                isDefault: environments.isDefault,
            })
            .from(environments)
            .innerJoin(projects, eq(environments.projectId, projects.projectId))
            .where(where)
            .orderBy(desc(environments.createdAt))
            .limit(input.limit)
            .offset(input.offset),
        db
            .select({ count: sql<number>`count(*)::int` })
            .from(environments)
            .innerJoin(projects, eq(environments.projectId, projects.projectId))
            .where(where),
    ]);

    return c.json({
        items,
        total: countResult[0]?.count ?? 0,
    });
});

export default environment;
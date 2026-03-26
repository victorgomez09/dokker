import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import {
    createBitbucket,
    findBitbucketById,
    getBitbucketBranches,
    getBitbucketRepositories,
    testBitbucketConnection,
    updateBitbucket,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { audit } from "@/utils/audit";
import {
    apiBitbucketTestConnection,
    apiCreateBitbucket,
    apiFindBitbucketBranches,
    apiFindOneBitbucket,
    apiUpdateBitbucket,
} from "@/db/schema";
import { isAuthed } from "@/middlewares/guards";

const bitbucket = new Hono<{ Variables: { session: any } }>();

// Helper para emular el 'ctx' compatible con audit y otros servicios
const getCtx = (c: any) => ({ session: c.get("session") });

/**
 * RUTAS
 */

// POST /create
bitbucket.post("/create", isAuthed, zValidator("json", apiCreateBitbucket), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");
    const ctx = getCtx(c);

    try {
        const result = await createBitbucket(
            input,
            session.activeOrganizationId,
            session.user.id,
        );

        await audit(ctx, {
            action: "create",
            resourceType: "gitProvider",
            resourceName: input.name,
        });

        return c.json(result);
    } catch (error: any) {
        throw new HTTPException(400, {
            message: "Error creating this Bitbucket provider",
            cause: error
        });
    }
});

// GET /one/:bitbucketId
bitbucket.get("/one/:bitbucketId", isAuthed, async (c) => {
    const bitbucketId = c.req.param("bitbucketId");
    // Validamos el input si es necesario con el schema
    apiFindOneBitbucket.parse({ bitbucketId });

    const result = await findBitbucketById(bitbucketId);
    return c.json(result);
});

// GET /providers
bitbucket.get("/providers", isAuthed, async (c) => {
    const session = c.get("session");

    let result = await db.query.bitbucket.findMany({
        with: {
            gitProvider: true,
        },
        columns: {
            bitbucketId: true,
        },
    });

    // Filtramos por organización y usuario actual
    const filteredResults = result.filter((provider) => {
        return (
            provider.gitProvider.organizationId === session.activeOrganizationId &&
            provider.gitProvider.userId === session.user.id
        );
    });

    return c.json(filteredResults);
});

// GET /repositories/:bitbucketId
bitbucket.get("/repositories/:bitbucketId", isAuthed, async (c) => {
    const bitbucketId = c.req.param("bitbucketId");
    const result = await getBitbucketRepositories(bitbucketId);
    return c.json(result);
});

// GET /branches (Usa query params)
bitbucket.get("/branches", isAuthed, async (c) => {
    const query = c.req.query();
    const input = apiFindBitbucketBranches.parse(query);

    const result = await getBitbucketBranches(input);
    return c.json(result);
});

// POST /test-connection
bitbucket.post("/test-connection", isAuthed, zValidator("json", apiBitbucketTestConnection), async (c) => {
    const input = c.req.valid("json");
    try {
        const result = await testBitbucketConnection(input);
        return c.json(`Found ${result} repositories`);
    } catch (error: any) {
        throw new HTTPException(400, {
            message: error instanceof Error ? error.message : `Error: ${error}`
        });
    }
});

// POST /update
bitbucket.post("/update", isAuthed, zValidator("json", apiUpdateBitbucket), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");
    const ctx = getCtx(c);

    try {
        const result = await updateBitbucket(input.bitbucketId, {
            ...input,
            organizationId: session.activeOrganizationId,
        });

        await audit(ctx, {
            action: "update",
            resourceType: "gitProvider",
            resourceId: input.bitbucketId,
            resourceName: input.name,
        });

        return c.json(result);
    } catch (error: any) {
        throw new HTTPException(400, { message: "Error updating Bitbucket provider" });
    }
});

export default bitbucket;
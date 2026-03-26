import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import { desc, eq } from "drizzle-orm";
import {
    createDestintation,
    execAsync,
    execAsyncRemote,
    findDestinationById,
    IS_CLOUD,
    removeDestinationById,
    updateDestinationById,
} from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { audit } from "@/utils/audit";
import {
    apiCreateDestination,
    apiFindOneDestination,
    apiRemoveDestination,
    apiUpdateDestination,
    destinations,
} from "@/db/schema";
import { isAuthed } from "@/middlewares/guards";

const destination = new Hono<{ Variables: { session: any } }>();

const getCtx = (c: any) => ({ session: c.get("session") });

/**
 * RUTAS
 */

// POST /create
destination.post("/create", isAuthed, zValidator("json", apiCreateDestination), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");
    const ctx = getCtx(c);

    try {
        const result = await createDestintation(
            input,
            session.activeOrganizationId,
        );

        await audit(ctx, {
            action: "create",
            resourceType: "destination",
            resourceId: result.destinationId,
            resourceName: input.name,
        });

        return c.json(result);
    } catch (error: any) {
        throw new HTTPException(400, {
            message: "Error creating the destination",
            cause: error
        });
    }
});

// POST /test-connection
destination.post("/test-connection", isAuthed, zValidator("json", apiCreateDestination), async (c) => {
    const input = c.req.valid("json");
    const { secretAccessKey, bucket, region, endpoint, accessKey, provider, serverId } = input;

    try {
        const rcloneFlags = [
            `--s3-access-key-id="${accessKey}"`,
            `--s3-secret-access-key="${secretAccessKey}"`,
            `--s3-region="${region}"`,
            `--s3-endpoint="${endpoint}"`,
            "--s3-no-check-bucket",
            "--s3-force-path-style",
            "--retries 1",
            "--low-level-retries 1",
            "--timeout 10s",
            "--contimeout 5s",
        ];

        if (provider) {
            rcloneFlags.unshift(`--s3-provider="${provider}"`);
        }

        const rcloneDestination = `:s3:${bucket}`;
        const rcloneCommand = `rclone ls ${rcloneFlags.join(" ")} "${rcloneDestination}"`;

        if (IS_CLOUD && !serverId) {
            throw new HTTPException(404, { message: "Server not found" });
        }

        if (IS_CLOUD) {
            await execAsyncRemote(serverId || "", rcloneCommand);
        } else {
            await execAsync(rcloneCommand);
        }

        return c.json({ success: true });
    } catch (error: any) {
        throw new HTTPException(400, {
            message: error instanceof Error ? error.message : "Error connecting to bucket",
            cause: error
        });
    }
});

// GET /one/:destinationId
destination.get("/one/:destinationId", isAuthed, async (c) => {
    const destinationId = c.req.param("destinationId");
    const session = c.get("session");

    const dest = await findDestinationById(destinationId);

    if (dest.organizationId !== session.activeOrganizationId) {
        throw new HTTPException(401, { message: "You are not allowed to access this destination" });
    }

    return c.json(dest);
});

// GET /all
destination.get("/all", isAuthed, async (c) => {
    const session = c.get("session");

    const result = await db.query.destinations.findMany({
        where: eq(destinations.organizationId, session.activeOrganizationId),
        orderBy: [desc(destinations.createdAt)],
    });

    return c.json(result);
});

// DELETE /remove/:destinationId
destination.delete("/remove/:destinationId", isAuthed, async (c) => {
    const destinationId = c.req.param("destinationId");
    const session = c.get("session");
    const ctx = getCtx(c);

    const dest = await findDestinationById(destinationId);

    if (dest.organizationId !== session.activeOrganizationId) {
        throw new HTTPException(401, { message: "You are not allowed to delete this destination" });
    }

    const result = await removeDestinationById(destinationId, session.activeOrganizationId);

    await audit(ctx, {
        action: "delete",
        resourceType: "destination",
        resourceId: destinationId,
        resourceName: dest.name,
    });

    return c.json(result);
});

// POST /update
destination.post("/update", isAuthed, zValidator("json", apiUpdateDestination), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");
    const ctx = getCtx(c);

    const dest = await findDestinationById(input.destinationId);

    if (dest.organizationId !== session.activeOrganizationId) {
        throw new HTTPException(401, { message: "You are not allowed to update this destination" });
    }

    const result = await updateDestinationById(input.destinationId, {
        ...input,
        organizationId: session.activeOrganizationId,
    });

    await audit(ctx, {
        action: "update",
        resourceType: "destination",
        resourceId: input.destinationId,
        resourceName: input.name,
    });

    return c.json(result);
});

export default destination;
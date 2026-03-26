import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamText } from "hono/streaming";
import { HTTPException } from "hono/http-exception";
import {
    createBackup,
    findBackupById,
    findComposeByBackupId,
    findComposeById,
    findLibsqlByBackupId,
    findLibsqlById,
    findMariadbByBackupId,
    findMariadbById,
    findMongoByBackupId,
    findMongoById,
    findMySqlByBackupId,
    findMySqlById,
    findPostgresByBackupId,
    findPostgresById,
    findServerById,
    IS_CLOUD,
    keepLatestNBackups,
    removeBackupById,
    removeScheduleBackup,
    runLibsqlBackup,
    runMariadbBackup,
    runMongoBackup,
    runMySqlBackup,
    runPostgresBackup,
    runWebServerBackup,
    scheduleBackup,
    updateBackupById,
} from "@dokploy/server";
import { findDestinationById } from "@dokploy/server/services/destination";
import { runComposeBackup } from "@dokploy/server/utils/backups/compose";
import { getS3Credentials, normalizeS3Path } from "@dokploy/server/utils/backups/utils";
import { execAsync, execAsyncRemote } from "@dokploy/server/utils/process/execAsync";
import {
    restoreComposeBackup,
    restoreLibsqlBackup,
    restoreMariadbBackup,
    restoreMongoBackup,
    restoreMySqlBackup,
    restorePostgresBackup,
    restoreWebServerBackup,
} from "@dokploy/server/utils/restore";
import { checkServicePermissionAndAccess } from "@dokploy/server/services/permission";
import { audit } from "@/utils/audit";
import {
    apiCreateBackup,
    apiFindOneBackup,
    apiRemoveBackup,
    apiRestoreBackup,
    apiUpdateBackup,
} from "@/db/schema";
import { removeJob, schedule, updateJob } from "@/utils/backup";
import { isAuthed } from "@/middlewares/guards";
import { getCtx } from "@/middlewares/auth";

// Tipos rclone
interface RcloneFile {
    Path: string;
    Name: string;
    Size: number;
    IsDir: boolean;
}

const backup = new Hono<{ Variables: { session: any } }>();

/**
 * RUTAS
 */

// POST /create
backup.post("/create", isAuthed, zValidator("json", apiCreateBackup), async (c) => {
    const input = c.req.valid("json");
    const ctx = getCtx(c);

    try {
        const serviceId = input.postgresId || input.mysqlId || input.mariadbId || input.mongoId || input.libsqlId || input.composeId;
        if (serviceId) {
            await checkServicePermissionAndAccess(ctx, serviceId, { backup: ["create"] });
        }

        const newBackup = await createBackup(input);
        const backupData = await findBackupById(newBackup.backupId);

        if (IS_CLOUD && backupData.enabled) {
            let serverId = "";
            const dbType = backupData.databaseType;
            if (dbType === "postgres") serverId = backupData.postgres?.serverId || "";
            else if (dbType === "mysql") serverId = backupData.mysql?.serverId || "";
            else if (dbType === "mongo") serverId = backupData.mongo?.serverId || "";
            else if (dbType === "mariadb") serverId = backupData.mariadb?.serverId || "";
            else if (dbType === "libsql") serverId = backupData.libsql?.serverId || "";
            else if (backupData.backupType === "compose") serverId = backupData.compose?.serverId || "";

            const server = await findServerById(serverId);
            if (server.serverStatus === "inactive") {
                throw new Error("Server is inactive");
            }
            await schedule({ cronSchedule: backupData.schedule, backupId: backupData.backupId, type: "backup" });
        } else if (backupData.enabled) {
            scheduleBackup(backupData);
        }

        await audit(ctx, { action: "create", resourceType: "backup", resourceId: backupData.backupId });
        return c.json(backupData);
    } catch (error: any) {
        throw new HTTPException(400, { message: error.message || "Error creating backup" });
    }
});

// GET /one/:backupId
backup.get("/one/:backupId", isAuthed, async (c) => {
    const backupId = c.req.param("backupId");
    const ctx = getCtx(c);
    const backupData = await findBackupById(backupId);

    const serviceId = backupData.postgresId || backupData.mysqlId || backupData.mariadbId || backupData.mongoId || backupData.libsqlId || backupData.composeId;
    if (serviceId) {
        await checkServicePermissionAndAccess(ctx, serviceId, { backup: ["read"] });
    }
    return c.json(backupData);
});

// POST /update
backup.post("/update", isAuthed, zValidator("json", apiUpdateBackup), async (c) => {
    const input = c.req.valid("json");
    const ctx = getCtx(c);

    try {
        const existing = await findBackupById(input.backupId);
        const serviceId = existing.postgresId || existing.mysqlId || existing.mariadbId || existing.mongoId || existing.libsqlId || existing.composeId;
        if (serviceId) {
            await checkServicePermissionAndAccess(ctx, serviceId, { backup: ["update"] });
        }

        await updateBackupById(input.backupId, input);
        const updated = await findBackupById(input.backupId);

        if (IS_CLOUD) {
            if (updated.enabled) {
                await updateJob({ cronSchedule: updated.schedule, backupId: updated.backupId, type: "backup" });
            } else {
                await removeJob({ cronSchedule: updated.schedule, backupId: updated.backupId, type: "backup" });
            }
        } else {
            removeScheduleBackup(input.backupId);
            if (updated.enabled) scheduleBackup(updated);
        }

        await audit(ctx, { action: "update", resourceType: "backup", resourceId: updated.backupId });
        return c.json(updated);
    } catch (error: any) {
        throw new HTTPException(400, { message: error.message });
    }
});

// DELETE /remove/:backupId
backup.delete("/remove/:backupId", isAuthed, async (c) => {
    const backupId = c.req.param("backupId");
    const ctx = getCtx(c);

    try {
        const backupData = await findBackupById(backupId);
        const serviceId = backupData.postgresId || backupData.mysqlId || backupData.mariadbId || backupData.mongoId || backupData.libsqlId || backupData.composeId;
        if (serviceId) {
            await checkServicePermissionAndAccess(ctx, serviceId, { backup: ["delete"] });
        }

        const value = await removeBackupById(backupId);
        if (IS_CLOUD && value) {
            removeJob({ backupId, cronSchedule: value.schedule, type: "backup" });
        } else if (!IS_CLOUD) {
            removeScheduleBackup(backupId);
        }

        await audit(ctx, { action: "delete", resourceType: "backup", resourceId: backupId });
        return c.json(value);
    } catch (error: any) {
        throw new HTTPException(400, { message: error.message });
    }
});

// Manual Backups (POST /run/:type/:backupId)
const manualRun = async (c: any, type: string) => {
    const backupId = c.req.param("backupId");
    const ctx = getCtx(c);
    const b = await findBackupById(backupId);

    if (b[`${type}Id` as keyof typeof b]) {
        await checkServicePermissionAndAccess(ctx, b[`${type}Id` as keyof typeof b] as string, { backup: ["create"] });
    }

    let service: any;
    switch (type) {
        case "postgres": service = await findPostgresByBackupId(backupId); await runPostgresBackup(service, b); break;
        case "mysql": service = await findMySqlByBackupId(backupId); await runMySqlBackup(service, b); break;
        case "mariadb": service = await findMariadbByBackupId(backupId); await runMariadbBackup(service, b); break;
        case "mongo": service = await findMongoByBackupId(backupId); await runMongoBackup(service, b); break;
        case "libsql": service = await findLibsqlByBackupId(backupId); await runLibsqlBackup(service, b); break;
        case "compose": service = await findComposeByBackupId(backupId); await runComposeBackup(service, b); break;
    }

    await keepLatestNBackups(b, service?.serverId);
    await audit(ctx, { action: "run", resourceType: "backup", resourceId: backupId });
    return c.json({ success: true });
};

backup.post("/run/postgres/:backupId", isAuthed, (c) => manualRun(c, "postgres"));
backup.post("/run/mysql/:backupId", isAuthed, (c) => manualRun(c, "mysql"));
backup.post("/run/mariadb/:backupId", isAuthed, (c) => manualRun(c, "mariadb"));
backup.post("/run/mongo/:backupId", isAuthed, (c) => manualRun(c, "mongo"));
backup.post("/run/libsql/:backupId", isAuthed, (c) => manualRun(c, "libsql"));
backup.post("/run/compose/:backupId", isAuthed, (c) => manualRun(c, "compose"));

// GET /list-files
backup.get("/list-files", isAuthed, async (c) => {
    const { destinationId, search, serverId } = c.req.query();

    try {
        const destination = await findDestinationById(destinationId!);
        const rcloneFlags = getS3Credentials(destination);
        const bucketPath = `:s3:${destination.bucket}`;

        const lastSlashIndex = search!.lastIndexOf("/");
        const baseDir = lastSlashIndex !== -1 ? normalizeS3Path(search!.slice(0, lastSlashIndex + 1)) : "";
        const searchTerm = lastSlashIndex !== -1 ? search!.slice(lastSlashIndex + 1) : search;

        const searchPath = baseDir ? `${bucketPath}/${baseDir}` : bucketPath;
        const listCommand = `rclone lsjson ${rcloneFlags.join(" ")} "${searchPath}" --no-mimetype --no-modtime 2>/dev/null`;

        let stdout = "";
        if (serverId) {
            const result = await execAsyncRemote(serverId, listCommand);
            stdout = result.stdout;
        } else {
            const result = await execAsync(listCommand);
            stdout = result.stdout;
        }

        const files = JSON.parse(stdout) as RcloneFile[];
        const results = baseDir ? files.map(f => ({ ...f, Path: `${baseDir}${f.Path}` })) : files;

        const filtered = searchTerm
            ? results.filter(f => f.Path.toLowerCase().includes(searchTerm.toLowerCase()))
            : results;

        return c.json(filtered.slice(0, 100));
    } catch (error: any) {
        throw new HTTPException(400, { message: error.message });
    }
});

// SSE /restore-logs (Sustituye a Subscription)
backup.get("/restore-logs", isAuthed, async (c) => {
    const query = c.req.query();
    // Validamos el input manualmente ya que es un GET para SSE
    const input = apiRestoreBackup.parse(JSON.parse(query.data || "{}"));
    const ctx = getCtx(c);

    if (input.databaseId) {
        await checkServicePermissionAndAccess(ctx, input.databaseId, { backup: ["restore"] });
    }

    return streamText(c, async (stream) => {
        const destination = await findDestinationById(input.destinationId);
        const logQueue: string[] = [];
        let isDone = false;

        const callback = (log: string) => { logQueue.push(log); };

        // Lanzamos la restauración (Promesa sin await para no bloquear el stream)
        const runRestore = async () => {
            try {
                if (input.backupType === "database") {
                    if (input.databaseType === "postgres") await restorePostgresBackup(await findPostgresById(input.databaseId), destination, input, callback);
                    if (input.databaseType === "mysql") await restoreMySqlBackup(await findMySqlById(input.databaseId), destination, input, callback);
                    if (input.databaseType === "mariadb") await restoreMariadbBackup(await findMariadbById(input.databaseId), destination, input, callback);
                    if (input.databaseType === "mongo") await restoreMongoBackup(await findMongoById(input.databaseId), destination, input, callback);
                    if (input.databaseType === "libsql") await restoreLibsqlBackup(await findLibsqlById(input.databaseId), destination, input, callback);
                    if (input.databaseType === "web-server") await restoreWebServerBackup(destination, input.backupFile, callback);
                } else if (input.backupType === "compose") {
                    await restoreComposeBackup(await findComposeById(input.databaseId), destination, input, callback);
                }
            } catch (e: any) {
                callback(`ERROR: ${e.message}`);
            } finally {
                isDone = true;
            }
        };

        runRestore();

        // Loop de streaming
        while (!isDone || logQueue.length > 0) {
            if (logQueue.length > 0) {
                const log = logQueue.shift()!;
                await stream.writeln(log);
            } else {
                await stream.sleep(100);
            }
        }
    });
});

export default backup;
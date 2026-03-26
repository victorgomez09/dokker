import { apiUpdateWebServerMonitoring } from "@/db/schema";
import { isAdmin } from "@/middlewares/guards";
import { HonoEnv } from "@/types/hono";
import {
    getWebServerSettings,
    IS_CLOUD,
    setupWebMonitoring,
    updateWebServerSettings,
} from "@dokploy/server";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const admin = new Hono<HonoEnv>();

/**
 * POST /api/admin/setup-monitoring
 * Equivalente a: adminProcedure.input(apiUpdateWebServerMonitoring).mutation(...)
 */
admin.post(
    "/setup-monitoring",
    isAdmin, // Protegemos la ruta: solo dueños/admins con sesión válida
    zValidator("json", apiUpdateWebServerMonitoring), // Validación de esquema idéntica a tRPC
    async (c) => {
        try {
            const input = c.req.valid("json");

            if (IS_CLOUD) {
                // En Hono usamos HTTPException para errores con código de estado
                throw new HTTPException(401, {
                    message: "Feature disabled on cloud"
                });
            }

            // Mantenemos la lógica de mapeo exactamente igual
            await updateWebServerSettings({
                metricsConfig: {
                    server: {
                        type: "Dokploy",
                        refreshRate: input.metricsConfig.server.refreshRate,
                        port: input.metricsConfig.server.port,
                        token: input.metricsConfig.server.token,
                        cronJob: input.metricsConfig.server.cronJob,
                        urlCallback: input.metricsConfig.server.urlCallback,
                        retentionDays: input.metricsConfig.server.retentionDays,
                        thresholds: {
                            cpu: input.metricsConfig.server.thresholds.cpu,
                            memory: input.metricsConfig.server.thresholds.memory,
                        },
                    },
                    containers: {
                        refreshRate: input.metricsConfig.containers.refreshRate,
                        services: {
                            include: input.metricsConfig.containers.services.include || [],
                            exclude: input.metricsConfig.containers.services.exclude || [],
                        },
                    },
                },
            });

            await setupWebMonitoring();

            const settings = await getWebServerSettings();

            return c.json(settings);
        } catch (error) {
            // Si ya es una HTTPException, la relanzamos para que Hono la maneje
            if (error instanceof HTTPException) {
                throw error;
            }

            // Para cualquier otro error inesperado, lanzamos un 500
            console.error("Error in setup-monitoring:", error);
            throw new HTTPException(500, {
                message: error instanceof Error ? error.message : "Internal Server Error"
            });
        }
    }
);

export default admin;
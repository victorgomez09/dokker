import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
    createDefaultMiddlewares,
    createDefaultServerTraefikConfig,
    createDefaultTraefikConfig,
    initCancelDeployments,
    initCronJobs,
    initEnterpriseBackupCronJobs,
    initializeNetwork,
    initSchedules,
    initVolumeBackupsCronJobs,
    IS_CLOUD,
    sendDokployRestartNotifications,
    setupDirectories,
} from "@dokploy/server";
import { Server as HttpServer } from "node:http";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupTerminalWebSocketServer } from "./wss/terminal";
import packageInfo from "../package.json";
import adminRoutes from "@/routes/admin";
import aiRoutes from "@/routes/ai";
import applicationRoutes from "@/routes/application";
import backupRoutes from "@/routes/backup";
import bitbucketRoutes from "@/routes/bitbucket";
import certificateRoutes from "@/routes/bitbucket";
import clusterRoutes from "@/routes/cluster";
import composeRoutes from "@/routes/compose";
import deploymentRoutes from "@/routes/deployment";
import destinationRoutes from "@/routes/destination";
import dockerRoutes from "@/routes/docker";
import domainRoutes from "@/routes/domain";
import environmentRoutes from "@/routes/environment";

// 1. Configuración Inicial
config({ path: ".env" });

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Inicialización crítica de directorios y Traefik (Antes del arranque)
if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
    setupDirectories();
    createDefaultTraefikConfig();
    createDefaultServerTraefikConfig();
    console.log("✅ System directories & Traefik initialized");
}

const startServer = async () => {
    try {
        console.log("🚀 Starting Dokploy API - Version:", packageInfo.version);

        // 2. Instancia de Hono
        const app = new Hono();

        // Middlewares Globales
        app.use("*", logger());
        app.use("*", cors());

        // 3. Definición de Rutas REST
        app.get("/", (c) => c.json({
            status: "running",
            version: packageInfo.version,
            service: "Dokploy API"
        }));

        // Ejemplo de agrupación de rutas (Deberás importar tus archivos de rutas)
        app.route('/api/admin', adminRoutes);
        app.route('/api/ai', aiRoutes);
        app.route('/api/application', applicationRoutes);
        app.route('/api/backup', backupRoutes);
        app.route('/api/bitbucket', bitbucketRoutes);
        app.route('/api/certificate', certificateRoutes);
        app.route('/api/cluster', clusterRoutes);
        app.route('/api/compose', composeRoutes);
        app.route('/api/deployment', deploymentRoutes);
        app.route('/api/destination', destinationRoutes);
        app.route('/api/docker', dockerRoutes);
        app.route('/api/domain', domainRoutes);
        app.route('/api/environment', environmentRoutes);

        // 4. Arrancar Servidor usando @hono/node-server
        // Esto nos permite obtener la instancia de 'server' para los WebSockets
        const serverInstance = serve({
            fetch: app.fetch,
            port: PORT,
            hostname: HOST,
        }) as unknown as HttpServer;

        serverInstance.on("listening", async () => {
            const info = serverInstance.address();
            const address = typeof info === 'string' ? info : info?.address;
            const port = typeof info === 'string' ? null : info?.port;

            console.log(`📡 API REST running on http://${address}:${port}`);

            // 5. Inicialización de servicios de fondo (Cron/Schedules)
            await initEnterpriseBackupCronJobs();

            if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
                createDefaultMiddlewares();
                await initializeNetwork();
                await initCronJobs();
                await initSchedules();
                await initCancelDeployments();
                await initVolumeBackupsCronJobs();
                await sendDokployRestartNotifications();
                console.log("📅 Background services initialized");
            }

            // 6. Arrancar Worker de Despliegue (Queue)
            if (!IS_CLOUD) {
                console.log("👷 Starting Deployment Worker...");
                const { deploymentWorker } = await import("./queues/deployments-queue");
                await deploymentWorker.run();
            }
        });

        // 7. Configuración de WebSockets
        // Pasamos la instancia del servidor nativo de Node.js a cada setup
        setupDrawerLogsWebSocketServer(serverInstance);
        setupDeploymentLogsWebSocketServer(serverInstance);
        setupDockerContainerLogsWebSocketServer(serverInstance);
        setupDockerContainerTerminalWebSocketServer(serverInstance);
        setupTerminalWebSocketServer(serverInstance);

        if (!IS_CLOUD) {
            setupDockerStatsMonitoringSocketServer(serverInstance);
        }

    } catch (e) {
        console.error("❌ Critical Server Error:", e);
        process.exit(1);
    }
};

void startServer();
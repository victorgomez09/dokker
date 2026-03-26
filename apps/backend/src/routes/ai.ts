import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { IS_CLOUD } from "@dokploy/server/constants";
import {
    apiCreateAi,
    apiUpdateAi,
    deploySuggestionSchema,
} from "@dokploy/server/db/schema/ai";
import {
    createDomain,
    createMount,
    findEnvironmentById,
} from "@dokploy/server/index";
import {
    deleteAiSettings,
    getAiSettingById,
    getAiSettingsByOrganizationId,
    saveAiSettings,
    suggestVariants,
} from "@dokploy/server/services/ai";
import { createComposeByTemplate } from "@dokploy/server/services/compose";
import { findProjectById } from "@dokploy/server/services/project";
import {
    addNewService,
    checkServiceAccess,
} from "@dokploy/server/services/permission";
import {
    getProviderHeaders,
    getProviderName,
    type Model,
} from "@dokploy/server/utils/ai/select-ai-provider";
import { slugify } from "@/utils/slug";
import { generatePassword } from "@/utils/templates";
import { HTTPException } from "hono/http-exception";
import { isAdmin, isAuthed } from "@/middlewares/guards";

// Tipado para el contexto de Hono (ajustar según tu middleware de auth)
type Bindings = {
    session: {
        activeOrganizationId: string;
        user: { role: string };
    };
};

const app = new Hono<{ Variables: Bindings }>();

/**
 * Router: AI
 */

// GET /one/:aiId
app.get(
    "/one/:aiId",
    isAdmin,
    zValidator("param", z.object({ aiId: z.string() })),
    async (c) => {
        const { aiId } = c.req.valid("param");
        const result = await getAiSettingById(aiId);
        return c.json(result);
    }
);

// GET /get-models
app.get(
    "/get-models",
    isAuthed,
    zValidator("query", z.object({ apiUrl: z.string().min(1), apiKey: z.string() })),
    async (c) => {
        const input = c.req.valid("query");
        try {
            const providerName = getProviderName(input.apiUrl);
            const headers = getProviderHeaders(input.apiUrl, input.apiKey);
            let response: Response | null = null;

            switch (providerName) {
                case "ollama":
                    response = await fetch(`${input.apiUrl}/api/tags`, { headers });
                    break;
                case "gemini":
                    response = await fetch(
                        `${input.apiUrl}/models?key=${encodeURIComponent(input.apiKey)}`,
                        { headers: {} }
                    );
                    break;
                case "perplexity":
                    return c.json([
                        { id: "sonar-deep-research", object: "model", created: Date.now(), owned_by: "perplexity" },
                        { id: "sonar-reasoning-pro", object: "model", created: Date.now(), owned_by: "perplexity" },
                        { id: "sonar-reasoning", object: "model", created: Date.now(), owned_by: "perplexity" },
                        { id: "sonar-pro", object: "model", created: Date.now(), owned_by: "perplexity" },
                        { id: "sonar", object: "model", created: Date.now(), owned_by: "perplexity" },
                    ] as Model[]);
                default:
                    if (!input.apiKey) {
                        throw new Error("API key must contain at least 1 character(s)");
                    }
                    response = await fetch(`${input.apiUrl}/models`, { headers });
            }

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Failed to fetch models: ${errorText}`);
            }

            const res = (await response.json()) as any;
            let models: Model[] = [];

            if (Array.isArray(res)) {
                models = res.map((m) => ({
                    id: m.id || m.name,
                    object: "model",
                    created: Date.now(),
                    owned_by: "provider",
                }));
            } else if (res.models) {
                models = res.models.map((m: any) => ({
                    id: m.id || m.name,
                    object: "model",
                    created: Date.now(),
                    owned_by: "provider",
                }));
            } else if (res.data) {
                models = res.data as Model[];
            } else {
                const possibleModels = (Object.values(res).find(Array.isArray) as any[]) || [];
                models = possibleModels.map((m) => ({
                    id: m.id || m.name,
                    object: "model",
                    created: Date.now(),
                    owned_by: "provider",
                }));
            }
            return c.json(models);
        } catch (error: any) {
            throw new HTTPException(400, { message: error.message });
        }
    }
);

// POST /create
app.post("/create", isAdmin, zValidator("json", apiCreateAi), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");
    const result = await saveAiSettings(session.activeOrganizationId, input);
    return c.json(result);
});

// POST /update
app.post("/update", isAdmin, zValidator("json", apiUpdateAi), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");
    const result = await saveAiSettings(session.activeOrganizationId, input);
    return c.json(result);
});

// GET /get-all
app.get("/get-all", isAdmin, async (c) => {
    const session = c.get("session");
    const result = await getAiSettingsByOrganizationId(session.activeOrganizationId);
    return c.json(result);
});

// GET /get/:aiId
app.get("/get/:aiId", isAdmin, zValidator("param", z.object({ aiId: z.string() })), async (c) => {
    const { aiId } = c.req.valid("param");
    const result = await getAiSettingById(aiId);
    return c.json(result);
});

// DELETE /delete/:aiId
app.delete("/delete/:aiId", isAdmin, zValidator("param", z.object({ aiId: z.string() })), async (c) => {
    const { aiId } = c.req.valid("param");
    const result = await deleteAiSettings(aiId);
    return c.json(result);
});

// POST /suggest
app.post(
    "/suggest",
    isAuthed,
    zValidator("json", z.object({ aiId: z.string(), input: z.string(), serverId: z.string().optional() })),
    async (c) => {
        try {
            const input = c.req.valid("json");
            const session = c.get("session");
            const result = await suggestVariants({
                ...input,
                organizationId: session.activeOrganizationId,
            });
            return c.json(result);
        } catch (error: any) {
            throw new HTTPException(400, { message: error.message });
        }
    }
);

// POST /deploy
app.post("/deploy", isAuthed, zValidator("json", deploySuggestionSchema), async (c) => {
    const input = c.req.valid("json");
    const session = c.get("session");

    // El objeto ctx que TRPC inyectaba, aquí lo construimos o pasamos el contexto de Hono
    const ctx = { session };

    const environment = await findEnvironmentById(input.environmentId);
    const project = await findProjectById(environment.projectId);

    // Mantenemos la lógica de permisos
    await checkServiceAccess(ctx as any, environment.projectId, "create");

    if (IS_CLOUD && !input.serverId) {
        throw new HTTPException(401, { message: "You need to use a server to create a compose" });
    }

    const projectName = slugify(`${project.name} ${input.id}`);

    const compose = await createComposeByTemplate({
        ...input,
        composeFile: input.dockerCompose,
        env: input.envVariables,
        serverId: input.serverId,
        name: input.name,
        sourceType: "raw",
        appName: `${projectName}-${generatePassword(6)}`,
        isolatedDeployment: true,
        environmentId: input.environmentId,
    });

    if (input.domains && input.domains.length > 0) {
        for (const domain of input.domains) {
            await createDomain({
                ...domain,
                domainType: "compose",
                certificateType: "none",
                composeId: compose.composeId,
            });
        }
    }

    if (input.configFiles && input.configFiles.length > 0) {
        for (const mount of input.configFiles) {
            await createMount({
                filePath: mount.filePath,
                mountPath: "",
                content: mount.content,
                serviceId: compose.composeId,
                serviceType: "compose",
                type: "file",
            });
        }
    }

    await addNewService(ctx as any, compose.composeId);

    return c.json({ success: true }, 201);
});

export default app;
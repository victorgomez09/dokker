import { Session, User } from "better-auth";
import { db } from "@dokploy/server/db";

export type HonoEnv = {
    Variables: {
        db: typeof db;
        user: (User & {
            role: "owner" | "member" | "admin";
            ownerId: string;
            // email, id, etc ya vienen en User
        }) | null;
        session: (Session & {
            activeOrganizationId: string;
            impersonatedBy?: string
        }) | null;
    };
};
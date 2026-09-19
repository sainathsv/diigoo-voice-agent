import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { appDb, account, session, user, verification } from "@jenai/db";
import { clearFailures, isLocked, recordFailure } from "./login-throttle";

/**
 * The only header trusted for the client IP. The edge proxy (Caddy/ALB) must
 * SET it (overwriting anything the client sent). X-Forwarded-For is never
 * trusted: a client can forge it and reset IP rate limits (verified 2026-09-19).
 */
export const CLIENT_IP_HEADER = "x-jenai-client-ip";

/**
 * Individual logins for everyone (Diigoo staff and client teams).
 * Public sign-up is closed: people join through an invitation, and the
 * invite flow creates the account server-side (see server/invitations.ts).
 */
export const auth = betterAuth({
  appName: "JENAI",
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(appDb(), {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 10,
    revokeSessionsOnPasswordReset: true,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: { "/sign-in/email": { window: 60, max: 5 } },
  },
  advanced: {
    cookiePrefix: "jenai",
    useSecureCookies: process.env.NODE_ENV === "production",
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      const email = String((ctx.body as { email?: string } | undefined)?.email ?? "");
      if (email && isLocked(email)) {
        throw new APIError("TOO_MANY_REQUESTS", { message: "Too many failed sign-ins for this account. Try again in 15 minutes." });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-in/email") return;
      const email = String((ctx.body as { email?: string } | undefined)?.email ?? "");
      if (!email) return;
      if (ctx.context.returned instanceof APIError) recordFailure(email);
      else if (ctx.context.newSession) clearFailures(email);
    }),
  },
  plugins: [nextCookies()],
});

export type Session = typeof auth.$Infer.Session;

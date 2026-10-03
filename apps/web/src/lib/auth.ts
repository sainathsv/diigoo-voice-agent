import "server-only";
import { networkInterfaces } from "node:os";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { appDb, account, session, twoFactor as twoFactorTable, user, verification } from "@jenai/db";
import { isLocked } from "./login-throttle";
import { recordSecurityEvent } from "./security-events";

/**
 * The only header trusted for the client IP. The edge proxy (Caddy/ALB) must
 * SET it (overwriting anything the client sent). X-Forwarded-For is never
 * trusted: a client can forge it and reset IP rate limits (verified 2026-09-19).
 */
export const CLIENT_IP_HEADER = "x-jenai-client-ip";

function meta(h: Headers | undefined) {
  return { ip: h?.get(CLIENT_IP_HEADER) ?? null, userAgent: h?.get("user-agent") ?? null };
}

const configuredOrigins = (process.env.JENAI_TRUSTED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);

/**
 * This server's own addresses today (office network, Tailscale). A department's server can
 * be given a new office address by its router; signing in keeps working on the new one.
 */
function ownOrigins(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === "IPv4" && !a.internal)
    .map((a) => `https://${a!.address}`);
}

/**
 * Individual logins for everyone (Diigoo staff and client teams).
 * Public sign-up is closed: people join through an invitation, and the
 * invite flow creates the account server-side (see server/invitations.ts).
 */
export const auth = betterAuth({
  appName: "JENAI",
  baseURL: process.env.BETTER_AUTH_URL,
  // Other addresses this server is opened on, comma-separated: an office server is
  // reached on its office network address and on its Tailscale address, whichever it has now.
  trustedOrigins: process.env.JENAI_EDITION === "police" ? () => [...configuredOrigins, ...ownOrigins()] : configuredOrigins,
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(appDb(), {
    provider: "pg",
    schema: { user, session, account, verification, twoFactor: twoFactorTable },
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
      if (ctx.path === "/sign-out") {
        // Read the session before it is gone, so the event names who signed out.
        const s = await getSessionFromCtx(ctx).catch(() => null);
        if (s) await recordSecurityEvent("signout", { userId: s.user.id, email: s.user.email, ...meta(ctx.headers) });
        return;
      }
      if (ctx.path !== "/sign-in/email") return;
      const email = String((ctx.body as { email?: string } | undefined)?.email ?? "");
      if (email && (await isLocked(email))) {
        await recordSecurityEvent("signin_locked", { email, ...meta(ctx.headers) });
        throw new APIError("TOO_MANY_REQUESTS", { message: "Too many failed sign-ins for this account. Try again in 15 minutes." });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      const failed = ctx.context.returned instanceof APIError;
      if (ctx.path === "/sign-in/email") {
        const email = String((ctx.body as { email?: string } | undefined)?.email ?? "");
        if (!email) return;
        if (failed) {
          await recordSecurityEvent("signin_failed", { email, detail: { status: (ctx.context.returned as APIError).status }, ...meta(ctx.headers) });
          return;
        }
        // The password was right (this also resets the lockout count). With two-step
        // sign-in on, no session exists until the code is checked.
        const ns = ctx.context.newSession;
        const pending = !ns || Boolean((ns.user as { twoFactorEnabled?: boolean }).twoFactorEnabled);
        await recordSecurityEvent("signin_ok", { email, userId: ns?.user.id ?? null, detail: pending ? { stage: "password", twoStep: "pending" } : undefined, ...meta(ctx.headers) });
        return;
      }
      if (ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code") {
        const method = ctx.path.endsWith("backup-code") ? "backup_code" : "authenticator";
        if (failed) {
          await recordSecurityEvent("mfa_failed", { detail: { method }, ...meta(ctx.headers) });
          return;
        }
        // Signed in already = confirming a new authenticator; otherwise this finishes a sign-in.
        const before = await getSessionFromCtx(ctx).catch(() => null);
        const ns = ctx.context.newSession;
        if (before && !(before.user as { twoFactorEnabled?: boolean }).twoFactorEnabled) {
          await recordSecurityEvent("mfa_enabled", { userId: before.user.id, email: before.user.email, ...meta(ctx.headers) });
        } else if (ns) {
          await recordSecurityEvent("signin_ok", { userId: ns.user.id, email: ns.user.email, detail: { stage: "two_step", method }, ...meta(ctx.headers) });
        }
        return;
      }
      if (ctx.path === "/two-factor/disable" && !failed) {
        const s = await getSessionFromCtx(ctx).catch(() => null);
        if (s) await recordSecurityEvent("mfa_disabled", { userId: s.user.id, email: s.user.email, ...meta(ctx.headers) });
      }
    }),
  },
  plugins: [
    // Authenticator-app codes. Wrong codes lock the challenge after a few tries (plugin default).
    twoFactor({ issuer: "JENAI", backupCodeOptions: { amount: 10, length: 10 } }),
    nextCookies(), // must stay last
  ],
});

export type Session = typeof auth.$Infer.Session;

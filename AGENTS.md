# JENAI Platform: rules for humans and coding agents

JENAI is a multi-tenant AI-calling ERP. Two sides share one system:
- **Platform** (Diigoo Tech, the company running JENAI): an organization with `kind = platform`.
- **Clients** (clinics, hospitals, GHMC, ...): organizations with `kind = client`, each with branches, teams and users.

Blueprint: `docs/blueprint.html` (source of every architectural decision). Decisions are recorded in `docs/adr/`.

## Layout
- `apps/web` Next.js 16 app: client workspace (`/w/[org]/...`), Diigoo console (`/console/...`), auth, public API.
- `packages/db` Drizzle schema, SQL migrations (including row-level security), DB clients, seed.
- `packages/authz` permission catalog, role templates, `can()` checks, PII masking. Pure TypeScript, no I/O.

## Commands
- `pnpm install`
- `pnpm db:setup` once (creates roles and database; needs a local Postgres superuser)
- `pnpm db:migrate` then `pnpm db:seed`
- `pnpm dev` (web on http://localhost:3100)
- `pnpm typecheck` and `pnpm test` must pass before any merge request

## Invariants (never break these)
1. **Every tenant-owned table has `tenant_id uuid not null`**, it is the first column of the primary key or leading index, and the table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with the standard tenant policy. Add the policy in the same migration that creates the table.
2. **Client data is only read through `withTenant(tenantId, fn)`** on the app pool (role `jenai_app`, no BYPASSRLS). Never pass a tenant id taken from the request body or query string; it comes from the verified membership.
3. **The platform pool (`jenai_platform`, BYPASSRLS) is used only in `apps/web/src/server/platform/*`**, and only after `requirePlatform(permission)` succeeded. Every platform read of client personal data needs an active support grant and writes an audit event.
4. **Every mutation writes an audit event** (`audit()`), recording both the acting user and the impersonator when present. `audit_events` is append-only (no UPDATE/DELETE grants).
5. **Permissions are checked with `can()` from `@jenai/authz`**, never by comparing role names.
6. **Phone numbers are masked** in any response unless the viewer has `contacts:reveal_phone`; use `maskPhone()`.
7. Migrations are plain SQL files, forward-only, expand/contract. Never edit a migration that has been applied anywhere.
8. No secrets in code or git. No production credentials in any environment an agent runs in.

## Definition of done
Typecheck and tests green, a test for new behaviour (bug fixes start with a failing test), cross-tenant isolation still passing, audit events for new mutations, no em dashes in user-facing copy.

# ADR 0001: Tenancy, identity and access model

- Status: accepted
- Date: 2026-09-19
- Context: Blueprint Parts 2, 3 and 6; research reports 01 (roles) and 04 (architecture).

## Decision
1. **One `organizations` table** with `kind` (platform, partner, client) and `parent_id`. Diigoo is the single platform organization, so staff use the same membership and role machinery as clients. A client organization's id is its tenant id.
2. **Branches are a separate tenant-owned table**, not organizations: they carry operational data (numbers, hours, agents) and are never billing or isolation boundaries. Teams exist for routing and bulk grants, never as a security wall.
3. **Users are global; memberships are per organization.** One person can hold different roles in different clients (avoids the GoHighLevel "same permissions everywhere" limitation).
4. **Authorization = role + scope.** `role_bindings(membership, role, scope org|branch, expires_at)`. Rights are the union of live bindings. Checks go through `can()` in `@jenai/authz`; permissions are typed `module:action` strings.
5. **Isolation is enforced twice:** application code always derives the tenant from the verified membership, and Postgres row-level security (`tenant_id = app_tenant_id()`, set per transaction with `set_config(..., true)`) blocks everything else. The app role has no BYPASSRLS. Cross-tenant reads happen only through three SECURITY DEFINER functions in schema `lookup`.
6. **Platform staff have no standing access to client data.** Access is a `support_grants` row: client consent (or standing consent for read-only), second Diigoo approver for write, super-admin break-glass with a 15-minute cap. Every action is audited with the acting staff member.
7. **Better Auth** (MIT, runs in our Postgres) for authentication. Public sign-up is disabled; accounts are created only through invitations.
8. **Client IP** for rate limiting comes only from `x-jenai-client-ip`, set by our edge proxy. X-Forwarded-For is never trusted (a forged value reset the IP limit in testing on 2026-09-19). A per-account failure limit backs it up.

## Consequences
- Every new tenant-owned table must ship with its RLS policy in the same migration, and the isolation suite must be extended.
- The in-memory per-account throttle is single-instance; move it to Redis before scaling the web tier horizontally.
- OpenFGA or Cerbos can replace the in-code `can()` later if record-level sharing or a deep partner tier arrives, without changing the data model.

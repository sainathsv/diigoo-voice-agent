# JENAI Platform

The new JENAI: a multi-tenant AI-calling ERP for Indian businesses, built by Diigoo Tech.
It replaces the `panel.json` control panel step by step (Blueprint Part 13), without touching live clients until each piece is proven.

## What works today (Phase 1 foundation)
- **Two sides, one system.** Diigoo staff work in the console (`/console`); each client works in its own workspace (`/w/<client>`).
- **Individual logins** for everyone (no shared passwords), invitation-only, sign-in throttled per IP (trusted edge header) and per account.
- **Roles with branch scope.** 9 client role templates (Owner, Admin, Branch manager, Front desk, Marketing, Supervisor/QA, Practitioner, Analyst, Billing contact) and 9 Diigoo roles. Clients clone templates into custom roles. Nobody can hand out access they do not hold; the last Owner cannot be removed.
- **Database-enforced isolation.** Every client table has row-level security; the app connects as a role that cannot bypass it.
- **Support access by consent.** Diigoo staff have no standing access to client data. Read access needs client approval (or the client's standing consent); change access also needs a second Diigoo approver; break-glass is super-admin only, 15 minutes, loudly logged.
- **Append-only activity log** on both sides, including every support action.
- **Go-live gate.** New clients start in onboarding with a 10-step checklist (KYC, own telephony account, number, A2P declaration, agent, test calls, write-back, wallet, DPA); "Go live" stays disabled until all pass.

## Block 2 (calls, leads, agents, numbers, dialer, plans)
- **Calls and leads:** calls sync from the voice engine (read-only), filtered by each person's branches; phone numbers masked by role; recordings play through an authorised, audited proxy; the post-call analyzer (Bedrock, Mumbai) turns transcripts into leads, validated by schema.
- **AI agents:** live agents are imported unchanged as version 1; new versions pass pre-publish checks (AI disclosure required), maker-checker approval, and one publish updates inbound AND outbound together with verification and rollback. A live check flags any drift.
- **Phone numbers:** each client's own carrier account with KYC status; numbers carry series, purpose and the A2P (AI calling) declaration required by TRAI from 18 Sep 2026; one number belongs to one client platform-wide.
- **Dialer:** every attempt passes the compliance gate (opt-out, DND for promotional, declared caller ID, 140-series for promotional, consent, 09:00-21:00 hours, daily cap); campaigns need approval by someone other than the creator; the simulated carrier is the default.
- **Plans:** Trial, Front Desk, Growth, Business, Enterprise (contract) and Government (postpaid monthly invoice against a PO); limits enforced; monthly usage statement for raising the invoice. No payments yet.
- **Safety:** the live engine stays read-only per client until Diigoo switches it to managed; real calls need `JENAI_REAL_DIALS=true` as well.

Worker: `pnpm --filter @jenai/worker start` (see the switches in `.env.example`).

## Run it
```bash
pnpm install
cp .env.example .env        # then set BETTER_AUTH_SECRET
pnpm db:setup               # creates roles jenai_owner / jenai_app / jenai_platform and the database
pnpm db:migrate
pnpm db:seed
pnpm dev                    # http://localhost:3100
```
Seeded logins (development only, password = `SEED_PASSWORD` in `.env`):

| Who | Email |
|---|---|
| Diigoo super admin | founder@diigoo.test |
| Diigoo ops / BD / customer success / support / finance | ops@, bd@, success@, support@, finance@diigoo.test |
| Zennara owner, admin, branch manager, front desk, marketing, doctor | owner@, admin@, manager@, frontdesk@, marketing@, doctor@zennara.test |
| LBR owner, front desk | owner@lbr.test, frontdesk@lbr.test |
| GHMC owner, supervisor | owner@ghmc.test, qa@ghmc.test |
| Consultant in two clients | consultant@jenai.test |

## Checks
```bash
pnpm typecheck
pnpm test                   # permission rules + cross-tenant isolation against real Postgres
bash scripts/smoke-access.sh   # with pnpm dev running: every role's page access
```

## Layout
See `AGENTS.md` for the rules every change must follow, `docs/blueprint.html` for the plan, `docs/adr/` for decisions.

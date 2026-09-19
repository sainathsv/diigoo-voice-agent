# Threat model

What we protect, from whom, and where each defence lives. Written for a fleet
of tens of thousands of client workspaces on shared infrastructure: the worst
outcomes are the ones that cross from one client to another, or that one
mistake repeats across every client at once.

## What matters most

1. **Callers' personal data** (names, numbers, recordings, transcripts, health
   concerns): owned by our clients, processed by us.
2. **Clients' ability to take calls**: an outage or a misbehaving agent hits
   their business directly.
3. **Control of the fleet**: Diigoo staff access, the console, the voice
   engine credentials, the carrier accounts that can place calls (and cost money).
4. **The evidence**: audit log and sign-in history, needed for CERT-In, DPDP
   and client trust.

## Who attacks

| Actor | Wants | Most likely route |
|---|---|---|
| Opportunist on the internet | Any account, any data | Password guessing and spraying, known CVEs in dependencies |
| A client's own user | Other clients' data, more rights than given | Changing IDs in URLs and forms (IDOR), replaying requests, role escalation |
| A caller | Free services, other people's data, embarrassing output | Talking the AI agent into it: jailbreaks, fake "system notes", regional-language tricks |
| A departing or careless Diigoo employee | Client data, cover tracks | Standing access, editing logs |
| Someone with a stolen staff password | The whole fleet | Console, support access, voice engine credentials |

## Threats and defences

| Threat | Defence | Where |
|---|---|---|
| One client reads another's data | Row-level security on every tenant table, tenant id only from the verified membership, never from the URL; the bypass pool is barred from workspace code by a CI rule | `packages/db` migrations, `server/access.ts`, `security/opengrep/jenai.yml`, isolation tests |
| Role escalation inside a client | Permission checks per action and branch; you cannot grant access you do not hold; admin-level grants raise an alert | `packages/authz`, `server/actions/workspace.ts`, detector |
| Password guessing and spraying | Per-address limit at sign-in, per-account lockout counted in the database, alerts, 2-step sign-in | `lib/auth.ts`, `lib/login-throttle.ts`, detector |
| Stolen staff password | 2-step required for staff in production; staff have no standing access to client data (consented, time-boxed grants); break-glass always alerts | `lib/mfa-policy.ts`, support grants, detector |
| Forged client address resets limits | Only the edge-set header is trusted; CI rule forbids reading X-Forwarded-For | `lib/auth.ts`, code rules |
| Cross-site attacks (XSS, CSRF, clickjacking) | React escaping, nonce CSP with strict-dynamic, frame-ancestors none, server-action origin checks, SameSite cookies | `proxy.ts`, attack suite |
| Server-side request forgery via the engine address | Engine and media addresses resolved and refused if private or cloud-metadata; redirects not followed | `packages/voice/src/net-guard.ts` |
| Voice engine or carrier credentials leak | Encrypted per tenant (AES-256-GCM, tenant-bound), never sent to the browser; changes alert | `packages/db/src/secrets.ts`, detector |
| The AI agent is talked into harm | Platform guardrails in every prompt, publish gate on the red-team suite, fleet sweep, alert on unsafe live agents | `docs/security/ai-safety.md` |
| Bulk data theft by an insider | Recording plays and exports audited and alerted on volume; phone numbers masked unless the role may reveal them | recording route, detector, `mask.ts` |
| Covering tracks | Audit log append-only for every role including the owner, hash-chained per workspace, verified hourly, fingerprint shipped off the database | migrations 0009 and 0012, worker |
| Vulnerable dependency | Lockfile pinned, OSV scan on every change, secrets scan | `.gitlab-ci.yml` |
| One bad change reaches every client | Maker-checker on agent publishes, safety gate, drift detection against the live engine, CI attack suite | engine, CI |

## Known gaps (tracked)

- **Edge protections not yet in place.** Web firewall rate rules, GuardDuty and
  180-day CloudWatch retention on the live AWS account need approval.
- **Live server hardening.** Items found on the current voice server wait for
  approval one at a time (runbook: cert renewal and hardening).
- **Rate-limited sign-in attempts are not all logged.** Once the per-address
  limit trips, further attempts are refused before they are recorded. The
  detector still sees the first ones; the web firewall should log the rest.
- **The AI check uses a stand-in model**, not the live voice model. See ai-safety.md.
- **Annual external penetration test** by a CERT-In empanelled auditor before
  government go-lives; most government contracts require it.

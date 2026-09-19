# Security

How JENAI stays safe for every client at once. Start here.

| Document | For |
|---|---|
| [threat-model.md](threat-model.md) | What we protect, from whom, and where each defence lives |
| [incident-response.md](incident-response.md) | What to do when something happens (CERT-In 6 hours, DPDP 72 hours) |
| [detection-rules.md](detection-rules.md) | Every alert the detector raises and the first response to it |
| [ai-safety.md](ai-safety.md) | Guardrails, the publish gate and the fleet sweep for AI agents |

## Checks that run by themselves

| When | What | Where |
|---|---|---|
| Every change | Type checks, unit tests, secrets scan, dependency CVEs, code rules for the tenancy invariants | CI verify stage |
| Every change | Tenant isolation tests, engine tests (publish gate included) | CI integration stage |
| Every change | 18 attacks, blue-team drills, two-step sign-in, against the built app | CI attack stage (`pnpm --filter @jenai/security attack`) |
| Staging exists | OWASP ZAP baseline scan | CI `dast-baseline` (set `STAGING_URL`) |
| Every minute | Detector over sign-in and audit events | worker security loop |
| Every hour | Audit-log anchor and incremental chain check; weekly full walk in shards | worker security loop |
| Every agent publish | AI red-team suite on the exact prompts | worker safety loop |
| Suite or model change, or 90 days | AI re-check of live agents | worker safety loop |

## By hand

```bash
pnpm --filter @jenai/security attack
```

```bash
pnpm --filter @jenai/security ai-redteam -- --agent <agent id> --preview
```

The second one tries today's template and guardrails on an agent's real facts
without saving or publishing anything.

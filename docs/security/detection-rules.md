# Detection rules

The worker's detector (`packages/engine/src/security/detect.ts`) reads new
sign-in events and audit events every minute and raises alerts on the console
Security page. High and critical alerts also go to the on-call email (SNS).
One alert per subject stays open; repeats add to its count.

Thresholds live in `THRESHOLDS` in the same file. Change them there, with a
test.

## Sign-in and access

| Rule | Fires when | Severity | First response |
|---|---|---|---|
| `signin.account_guessing` | 5+ wrong passwords on one account in 15 min; high at 10 or on lockout | medium, high | Check the addresses. If one person forgot, nothing to do. If many addresses, force a password reset and ask them to turn on 2-step |
| `signin.password_spray` | One address fails on 5+ accounts in 15 min | high | Block the address at the edge (WAF). Check for any `success_after_failures` from it |
| `signin.success_after_failures` | A sign-in succeeds after 5+ failures in 30 min | high | Treat as a possible takeover: call the person, revoke sessions, reset the password |
| `signin.two_step_failing` | 3+ wrong 2-step codes from one address in 15 min, after a right password | high | The password is known to someone else. Reset it now |
| `signin.two_step_disabled` | Someone turns 2-step off; high for Diigoo staff | medium, high | Ask why. Staff must turn it back on |
| `access.probing` | One person refused 10+ times in 10 min (other clients' records, pages beyond their role, malformed IDs) | high | Look at what they tried (Security page, "Recent problems"). A curious user or a script; suspend if deliberate |

## Administrative and data

| Rule | Fires when | Severity | First response |
|---|---|---|---|
| `support.breakglass` | Any break-glass use | critical | Confirm it was one of us and why. Review everything done in that session (client's Activity log, JENAI support filter) |
| `support.off_hours` | A support session opens outside 08:00 to 21:00 IST | medium | Confirm with the staff member |
| `admin.off_hours` | Plan, staff, role, number or voice-connection changes outside 08:00 to 21:00 IST | low, medium | Confirm with the person |
| `roles.privilege_granted` | Someone is given admin-level permissions, or a role gains them | medium, high (Diigoo staff) | Confirm with the client owner or the super admin |
| `voice.connection_changed` | A client's voice engine credentials are saved, or it is switched to managed mode | medium, high | Confirm the change was planned |
| `data.mass_recording_plays` | 20+ recordings played by one person in 10 min | high | Ask the client owner whether this is expected (QA review) or scraping |
| `data.mass_export` | 3+ exports in an hour or 1,000+ rows | high | Same. Fires once export features exist |

## Integrity and AI

| Rule | Fires when | Severity | First response |
|---|---|---|---|
| `audit.chain_broken` | Hourly check finds an activity-log event changed, removed or out of order | critical | SEV1. Preserve evidence, compare with the shipped anchor fingerprints, start the incident runbook |
| `ai.live_agent_unsafe` | The fleet sweep finds a live agent failing a critical or high safety case | critical, high | Open the client's agent page, read the failed conversations, publish a fixed version (new versions carry the current guardrails) |

## Scale notes

- Each rule is one grouped query per batch of up to 5,000 events, and a pass
  drains up to 20 batches, so a burst across thousands of workspaces is caught
  within the minute.
- Sign-in events are partitioned by month; the detector's window queries hit
  the current month's partition through the time indexes.
- The detector keeps a watermark per source, so each event is judged once,
  and alerts are raised before the watermark moves (at least once).

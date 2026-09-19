# Incident response

For anyone at Diigoo who sees a security alert, a customer report, or anything
that looks like someone got in. Read the first section now; the rest when it
happens.

## The two clocks

| Law | Who we tell | Deadline | Starts when |
|---|---|---|---|
| CERT-In Directions, 28 April 2022 (IT Act s.70B) | CERT-In | **6 hours** | We *notice* a reportable incident (not when we confirm it) |
| DPDP Act 2023 and DPDP Rules 2025 | Data Protection Board, and every affected person | Board: without delay, **detailed report within 72 hours**. People: without delay | We become aware of a personal data breach |

JENAI is usually a **processor** for our clients' callers' data (the clinic,
school or department is the fiduciary). Tell the affected client the same hour
so they can meet their own duties; our contracts (DPA) promise this. For our own
users' data (client staff, Diigoo staff) JENAI is the fiduciary and reports
itself.

When unsure whether something is reportable: **report**. A report that turns
out minor costs nothing; a late one is a violation.

CERT-In reportable types include: unauthorised access to systems or data, data
breach or leak, compromise of servers or applications, malicious code, identity
theft and phishing, denial of service, targeted scanning of critical systems,
and attacks on AI/ML systems (a jailbroken agent that exposed data counts).

Contacts (check cert-in.org.in for current details before relying on these):
- CERT-In: incident@cert-in.org.in, +91 1800 11 4949 (toll free)
- Data Protection Board: through its portal once operational; until then, as the Board directs
- Diigoo incident lead: the on-call founder (SNS alert topic `jenai-alerts`)
- Legal counsel: (fill in before go-live)

## Severity

| Level | Examples | Response |
|---|---|---|
| SEV1 | Client data seen by another client or outsider; audit chain broken; break-glass not by us; live agent leaking data | Incident lead now, all hands, CERT-In clock running |
| SEV2 | Confirmed account takeover; live agent failing a critical safety case; password spraying that got a success | Incident lead within 30 min, likely reportable |
| SEV3 | Blocked attack (guessing, probing, spraying without success); one user's stolen password caught by 2-step | Security page, same day |

The console Security page ranks alerts the same way: critical ~ SEV1, high ~ SEV2.

## First hour

1. **Acknowledge** the alert on the Security page so others know you have it.
   Write the time you noticed: it starts the 6-hour clock.
2. **Open an incident note** (one shared doc, timestamps in IST): what was seen,
   who knows, every action taken. This becomes the CERT-In and Board report.
3. **Preserve evidence before changing anything.** Do not delete, restart or
   "clean up" first:
   - EBS snapshot of affected servers (the DLM policy takes daily ones; take a fresh one now)
   - export the relevant audit events, security events and alerts
   - note the current audit anchor fingerprint (worker log line `audit_anchor`)
4. **Contain** (smallest step that stops the harm):
   - one account: revoke its sessions (Sign-in and security page, or delete its `session` rows), force a password reset, require 2-step
   - staff account: remove its platform roles in the console (Diigoo team page)
   - support access: revoke the grant on the client's Support access page
   - a client's voice engine credentials: rotate them at the engine, then save the new ones in the console
   - a live AI agent misbehaving: switch the client back to read-only, or publish the last good version
   - platform-wide: take the web app offline behind the edge proxy; the voice engine keeps answering calls
5. **Decide reportability** with the incident lead by hour 2. If reportable,
   send CERT-In the initial report **by hour 5** (leave margin). A short
   initial report with "investigation continuing" is acceptable; details follow.

## Within 72 hours

- Tell each affected client in writing: what happened, what data, what we did, what they should do.
- If personal data was breached: the detailed report to the Board (nature, extent, timing, likely consequences, measures taken, and what affected people should do).
- Root cause found and fixed, or a mitigation in place with a date for the fix.

## After

- Post-incident review within 7 days, blameless. Add a detection rule or an
  attack-suite case so the same thing is caught automatically next time.
- Keep the incident note, evidence and reports for at least 180 days (CERT-In)
  and for the life of any legal proceeding.

## Things that must already be true (CERT-In Directions)

- [ ] Logs of all ICT systems kept for a rolling **180 days, in India**
      (security events: 365 days, monthly partitions in Mumbai; audit log: kept for good;
      server and CloudWatch logs: set retention to at least 180 days in ap-south-1)
- [ ] Server clocks synchronised to NTP of NIC or NPL (`samay1.nic.in`, `samay2.nic.in`) or a source traceable to them
- [ ] A named point of contact registered with CERT-In
- [ ] This runbook rehearsed once a quarter (tabletop: "an attacker has the founder's password")

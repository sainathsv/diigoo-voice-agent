# Putting JENAI live

Three scripts, in order. Run them from this repository on a machine logged in
to AWS account 198146918643.

```bash
bash deploy/01-provision.sh                 # the server, its address and DNS
bash deploy/02-setup-server.sh <server ip>  # Node, nginx, HTTPS, services
bash deploy/03-deploy.sh <server ip> --first-run --admin you@company.com --name "Your Name"
```

The last one prints a link. Open it once, choose your password, and turn on
two-step sign-in when asked: staff cannot open the console in production
without it.

Every release after that is one command:

```bash
bash deploy/03-deploy.sh <server ip>
```

It copies the code, builds it, applies new migrations and restarts both
services. Running it twice is safe.

## What is already made

| Thing | Name | Notes |
|---|---|---|
| Database | `jenai-prod-db` | Postgres 17.11, db.t4g.small, encrypted, 7-day backups, private. Deletion protection on. |
| App firewall | `jenai-app-sg` | 80 and 443 open to the internet |
| Database firewall | `jenai-db-sg` | 5432 open only to the app server |
| Database subnets | `jenai-db-subnets` | the three Mumbai zones |
| Master password | `/jenai/prod/db_master_password` | AWS parameter store, encrypted |

`01-provision.sh` adds the rest: the server role (certificates, alerts, AI in
Mumbai, parameter store, logs), a t4g.medium, a fixed address and the DNS
record for `app.jenai.in`.

## What runs on the server

- **jenai-web**: the Next.js app on 127.0.0.1:3000, behind nginx with TLS.
- **jenai-worker**: the dialer, call sync, the security detector, AI safety
  checks and write-backs to clients' own systems.
- **nginx**: TLS, and it sets `x-jenai-client-ip`, the only address header
  JENAI trusts.
- **certbot**: renews the certificate through DNS and reloads nginx.
- **logrotate**: keeps 200 days of logs, above the 180 days CERT-In expects.

## Settings that matter

In `/etc/jenai/env` on the server (0640, root and the jenai account only):

| Setting | Starts as | Meaning |
|---|---|---|
| `JENAI_STAFF_MFA` | `required` | Diigoo staff need two-step sign-in |
| `JENAI_REAL_DIALS` | `false` | **No real calls are placed.** Turn on only when a client is ready |
| `JENAI_SYNC` | `false` | Not pulling calls from any voice engine yet |
| `JENAI_ANALYZE` | `true` | Read finished calls and record outcomes |
| `JENAI_SAFETY` | `true` | AI red-team checks before an agent goes live |
| `JENAI_SECURITY` | `true` | Detector, audit-log checks, log retention |
| `JENAI_INTEGRATIONS` | `true` | Hand results back to clients' own systems |

Change one and restart: `sudo systemctl restart jenai-web jenai-worker`.

## First checks after it is up

```bash
curl -I https://app.jenai.in/login                     # 200, with HSTS
ssh -i ~/.ssh/jenai-saas.pem ubuntu@<ip> 'tail -20 /var/log/jenai/worker.log'
```

The worker should print `worker.started`, then an `audit_anchor` line within
the hour. On the Security page, the detector should show as having run.

## Rolling back

```bash
git checkout <previous commit>
bash deploy/03-deploy.sh <server ip>
```

Database migrations only go forward. If one needs undoing, restore the
database from its automatic backup (point in time, last 7 days) and deploy the
matching code.

#!/usr/bin/env bash
# JENAI SaaS: put the code on the server and start it.
#
#   bash deploy/03-deploy.sh <server ip> [--first-run --admin you@company.com --name "Your Name"]
#
# Safe to run again for every release: it copies the code, builds it, applies
# any new database migrations and restarts the two services. --first-run also
# creates the database roles and prints the link for the first admin.
set -euo pipefail

IP=${1:?"usage: bash deploy/03-deploy.sh <server ip> [--first-run --admin you@company.com]"}
shift || true
KEY=${KEY:-$HOME/.ssh/jenai-saas.pem}
HOST=${HOST:-app.jenai.in}
REGION=ap-south-1
DB_HOST=${DB_HOST:-jenai-prod-db.cf46u2kmklqx.ap-south-1.rds.amazonaws.com}
REPO=$(cd "$(dirname "$0")/.." && pwd)
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new ubuntu@$IP"

FIRST_RUN=no
ADMIN=""
ADMIN_NAME="Founder"
while [ $# -gt 0 ]; do
  case "$1" in
    --first-run) FIRST_RUN=yes ;;
    --admin) ADMIN=$2; shift ;;
    --name) ADMIN_NAME=$2; shift ;;
  esac
  shift
done

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
pw() { openssl rand -base64 30 | tr -d '/@" =+' | cut -c1-28; }
onserver() { $SSH "sudo -u jenai bash -c 'set -a; . /etc/jenai/env; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /opt/jenai/app && $1'"; }

say "1. Copying the code"
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude .next --exclude .env \
  --exclude 'packages/security/reports' --exclude '*.log' \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  "$REPO/" "ubuntu@$IP:/tmp/jenai-app/"
$SSH 'sudo rsync -a --delete --exclude node_modules /tmp/jenai-app/ /opt/jenai/app/ && sudo chown -R jenai:jenai /opt/jenai/app && rm -rf /tmp/jenai-app'

if [ "$FIRST_RUN" = "yes" ]; then
  say "2. Secrets (made here, kept on the server and in the AWS parameter store)"
  OWNER_PW=$(pw); APP_PW=$(pw); PLATFORM_PW=$(pw)
  AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  DATA_KEY=$(openssl rand -hex 32)
  MASTER_PW=$(aws ssm get-parameter --region $REGION --name /jenai/prod/db_master_password --with-decryption --query Parameter.Value --output text)
  for kv in "db_owner_password=$OWNER_PW" "db_app_password=$APP_PW" "db_platform_password=$PLATFORM_PW" "auth_secret=$AUTH_SECRET" "data_key=$DATA_KEY"; do
    aws ssm put-parameter --region $REGION --name "/jenai/prod/${kv%%=*}" --type SecureString --value "${kv#*=}" --overwrite >/dev/null
  done
  echo "   stored under /jenai/prod/"

  $SSH "sudo tee /etc/jenai/env >/dev/null <<ENVFILE
# JENAI production. Written by deploy/03-deploy.sh.
# sslmode=require: the database refuses unencrypted connections.
DATABASE_ADMIN_URL=postgres://jenai_root:${MASTER_PW}@${DB_HOST}:5432/postgres?sslmode=require
DATABASE_OWNER_URL=postgres://jenai_owner:${OWNER_PW}@${DB_HOST}:5432/jenai?sslmode=require
DATABASE_URL=postgres://jenai_app:${APP_PW}@${DB_HOST}:5432/jenai?sslmode=require
DATABASE_PLATFORM_URL=postgres://jenai_platform:${PLATFORM_PW}@${DB_HOST}:5432/jenai?sslmode=require
BETTER_AUTH_SECRET=${AUTH_SECRET}
BETTER_AUTH_URL=https://${HOST}
JENAI_PUBLIC_URL=https://${HOST}
JENAI_DATA_KEY=${DATA_KEY}
JENAI_STAFF_MFA=required
JENAI_SECURITY=true
JENAI_SAFETY=true
JENAI_INTEGRATIONS=true
JENAI_ANALYZE=true
JENAI_SYNC=false
JENAI_REAL_DIALS=false
JENAI_ANALYZER_REGION=ap-south-1
JENAI_SAFETY_REGION=ap-south-1
JENAI_ALERT_SNS_TOPIC_ARN=arn:aws:sns:ap-south-1:198146918643:jenai-alerts
AWS_REGION=ap-south-1
NODE_ENV=production
ENVFILE
sudo chown root:jenai /etc/jenai/env && sudo chmod 640 /etc/jenai/env"
fi

say "3. Installing and building"
# The build reads the database settings while it collects page data, so the
# settings file is loaded here too.
onserver "pnpm install --frozen-lockfile --silent"
onserver "pnpm --filter @jenai/web build 2>&1 | tail -5"

say "4. Completing the standalone server (static files and the public folder)"
onserver "cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/ && cp -r apps/web/public apps/web/.next/standalone/apps/web/ 2>/dev/null; echo ok"

if [ "$FIRST_RUN" = "yes" ]; then
  say "5. Database roles and tables"
  onserver "pnpm db:setup"
  onserver "pnpm db:migrate"
  if [ -n "$ADMIN" ]; then
    say "6. The first super admin"
    onserver "pnpm db:seed:platform -- --admin $ADMIN --name \"$ADMIN_NAME\""
  fi
else
  say "5. Applying any new migrations"
  onserver "pnpm db:migrate"
fi

say "7. Starting"
$SSH 'sudo systemctl enable --now jenai-web jenai-worker >/dev/null 2>&1; sudo systemctl restart jenai-web jenai-worker; sleep 4; systemctl is-active jenai-web jenai-worker'

say "8. Checking it answers"
CODE=000
for _ in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/login" || echo 000)
  [ "$CODE" = "200" ] && break || sleep 3
done
echo "   https://$HOST/login -> $CODE"
$SSH 'tail -4 /var/log/jenai/web.log 2>/dev/null; echo; tail -4 /var/log/jenai/worker.log 2>/dev/null' || true

say "Done."

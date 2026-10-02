#!/usr/bin/env bash
# JENAI on an office server (Ubuntu), reachable on the local network at https://<server IP>.
# Mirrors deploy/02-setup-server.sh + deploy/03-deploy.sh --first-run, without AWS:
# local PostgreSQL, a self-signed certificate, no Bedrock/SNS (those loops stay off).
#
#   bash setup-fusionstor.sh you@company.com "Your Name"
#
# Safe to run again: it keeps the existing database, passwords and settings.
set -euo pipefail

# The admin email is only needed on the first install; updates run without it.
ADMIN_EMAIL=${1:-}
ADMIN_NAME=${2:-Founder}
SRC=${SRC:-$HOME/diigoo-voice-agent}
APP=/opt/jenai/app
ENVF=/etc/jenai/env
IP=$(hostname -I | awk '{print $1}')

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
pw() { openssl rand -base64 30 | tr -d '/@" =+' | cut -c1-28; }
asjenai() { sudo -u jenai bash -c "set -o pipefail; set -a; . $ENVF; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd $APP && $1"; }

[ -f "$SRC/package.json" ] || { echo "Code not found at $SRC (unpack diigoo-voice-agent.tar.gz in your home folder first)"; exit 1; }
echo "Server address: $IP. You will be asked for your sudo password once."
sudo -v

say "1. System packages (PostgreSQL, nginx, openssl, curl)"
sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql nginx openssl curl ca-certificates rsync >/dev/null
sudo systemctl enable --now postgresql >/dev/null 2>&1
echo ok

say "2. Node 22 and pnpm"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
  sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi
sudo corepack enable && sudo COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack prepare pnpm@10.18.0 --activate >/dev/null 2>&1
echo "node $(node -v), pnpm $(COREPACK_ENABLE_DOWNLOAD_PROMPT=0 pnpm -v)"

say "3. App account and folders"
id jenai >/dev/null 2>&1 || sudo useradd --system --create-home --home-dir /opt/jenai --shell /usr/sbin/nologin jenai
sudo mkdir -p $APP /var/log/jenai /etc/jenai
sudo rsync -a --delete --exclude node_modules --exclude .next "$SRC/" "$APP/"
sudo chown -R jenai:jenai /opt/jenai /var/log/jenai
echo ok

say "4. Settings and secrets (made here, never printed)"
if sudo test -f $ENVF; then
  echo "keeping existing $ENVF"
else
  OWNER_PW=$(pw); APP_PW=$(pw); PLATFORM_PW=$(pw)
  sudo tee $ENVF >/dev/null <<ENVFILE
# JENAI on the office server. Written by setup-fusionstor.sh.
DATABASE_OWNER_URL=postgres://jenai_owner:${OWNER_PW}@127.0.0.1:5432/jenai
DATABASE_URL=postgres://jenai_app:${APP_PW}@127.0.0.1:5432/jenai
DATABASE_PLATFORM_URL=postgres://jenai_platform:${PLATFORM_PW}@127.0.0.1:5432/jenai
BETTER_AUTH_SECRET=$(openssl rand -base64 48 | tr -d '\n')
BETTER_AUTH_URL=https://${IP}
JENAI_PUBLIC_URL=https://${IP}
JENAI_DATA_KEY=$(openssl rand -hex 32)
JENAI_STAFF_MFA=required
JENAI_SECURITY=true
# These need AWS (Bedrock in Mumbai) or a live voice engine; switched on later.
JENAI_SAFETY=false
JENAI_ANALYZE=false
JENAI_SYNC=false
JENAI_REAL_DIALS=false
JENAI_INTEGRATIONS=true
NODE_ENV=production
ENVFILE
  sudo chown root:jenai $ENVF && sudo chmod 640 $ENVF
  echo "written to $ENVF (readable only by root and the app)"
fi
# Hardened servers create folders root-only (umask 077); the app must be able to reach its settings.
sudo chmod 755 /etc/jenai && sudo chown root:jenai $ENVF && sudo chmod 640 $ENVF
sudo -u jenai test -r $ENVF || { echo "the app account cannot read $ENVF"; exit 1; }
sudo find $APP -type d -exec chmod u+rwx,g+rx,o+rx {} + && sudo chmod -R u+rw,g+r,o+r $APP

say "5. Database roles and the jenai database"
get() { sudo grep "^$1=" $ENVF | cut -d= -f2- | sed -E 's#^postgres://([^:]+):([^@]+)@.*#\1 \2#'; }
read -r OU OP <<<"$(get DATABASE_OWNER_URL)"; read -r AU AP <<<"$(get DATABASE_URL)"; read -r PU PP <<<"$(get DATABASE_PLATFORM_URL)"
role() { sudo -u postgres psql -qtAc "do \$\$ begin if exists (select 1 from pg_roles where rolname='$1') then alter role \"$1\" with login $3 password '$2'; else create role \"$1\" with login $3 password '$2'; end if; end \$\$;"; }
role "$OU" "$OP" nobypassrls; role "$AU" "$AP" nobypassrls; role "$PU" "$PP" bypassrls
sudo -u postgres psql -qtAc "grant \"$PU\" to \"$OU\";"
sudo -u postgres psql -qtAc "select 1 from pg_database where datname='jenai'" | grep -q 1 || sudo -u postgres psql -qtAc "create database jenai owner \"$OU\";"
sudo -u postgres psql -q -d jenai -c "alter schema public owner to \"$OU\"; revoke create on schema public from public;" >/dev/null
echo "roles ready: $OU (owner), $AU (row-level security), $PU (console)"

say "6. Installing and building (a few minutes)"
asjenai "pnpm install --frozen-lockfile --silent"
asjenai "pnpm --filter @jenai/web build 2>&1 | tail -3"
asjenai "cp -r apps/web/.next/static apps/web/.next/standalone/apps/web/.next/ && (cp -r apps/web/public apps/web/.next/standalone/apps/web/ 2>/dev/null || true)"
sudo mkdir -p $APP/apps/web/.next/cache && sudo chown -R jenai:jenai $APP/apps/web/.next/cache

say "7. Tables, catalogue and the first admin"
asjenai "pnpm db:migrate"
asjenai "pnpm --filter @jenai/db catalog"
INVITE=""
if [ -n "$ADMIN_EMAIL" ]; then
  INVITE=$(asjenai "pnpm --silent db:seed:platform -- --admin '$ADMIN_EMAIL' --name '$ADMIN_NAME'" 2>&1 | tee /dev/stderr | grep -Eo 'https?://[^ ]+/invite/[A-Za-z0-9_-]+' | tail -1 || true)
else
  echo "no admin email given: update only, first-admin step skipped"
fi

say "8. The two services"
sudo tee /etc/systemd/system/jenai-web.service >/dev/null <<'UNIT'
[Unit]
Description=JENAI web
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=jenai
WorkingDirectory=/opt/jenai/app/apps/web
EnvironmentFile=/etc/jenai/env
Environment=NODE_ENV=production PORT=3000 HOSTNAME=127.0.0.1
ExecStart=/usr/bin/node .next/standalone/apps/web/server.js
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/log/jenai /opt/jenai/app/apps/web/.next/cache
StandardOutput=append:/var/log/jenai/web.log
StandardError=append:/var/log/jenai/web.log

[Install]
WantedBy=multi-user.target
UNIT
sudo tee /etc/systemd/system/jenai-worker.service >/dev/null <<'UNIT'
[Unit]
Description=JENAI worker
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=jenai
WorkingDirectory=/opt/jenai/app
EnvironmentFile=/etc/jenai/env
Environment=NODE_ENV=production
ExecStart=/opt/jenai/app/apps/worker/node_modules/.bin/tsx apps/worker/src/index.ts
Restart=always
RestartSec=5
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/log/jenai
StandardOutput=append:/var/log/jenai/worker.log
StandardError=append:/var/log/jenai/worker.log

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now jenai-web jenai-worker >/dev/null 2>&1
sudo systemctl restart jenai-web jenai-worker

say "9. HTTPS on the office network (self-signed certificate)"
if [ ! -f /etc/jenai/tls.crt ]; then
  sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 -subj "/CN=$IP" -addext "subjectAltName=IP:$IP" \
    -keyout /etc/jenai/tls.key -out /etc/jenai/tls.crt >/dev/null 2>&1
  sudo chmod 600 /etc/jenai/tls.key
fi
sudo tee /etc/nginx/sites-available/jenai >/dev/null <<NGINX
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }
server { listen 80 default_server; location / { return 301 https://\$host\$request_uri; } }
server {
  listen 443 ssl default_server;
  ssl_certificate /etc/jenai/tls.crt;
  ssl_certificate_key /etc/jenai/tls.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 25m;
  proxy_read_timeout 300s;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header x-jenai-client-ip \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  }
}
NGINX
# Another web server (e.g. Apache for an existing app) may already own port 80: then serve HTTPS only.
if sudo ss -ltnp | grep -E ':80 ' | grep -vq nginx; then
  sudo sed -i '/listen 80 default_server/d' /etc/nginx/sites-available/jenai
  echo "port 80 is used by another program; JENAI serves HTTPS on 443 only"
fi
sudo ln -sf /etc/nginx/sites-available/jenai /etc/nginx/sites-enabled/jenai
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
command -v ufw >/dev/null && sudo ufw status | grep -q active && sudo ufw allow 80,443/tcp >/dev/null || true

say "10. Checking it answers"
CODE=000
for _ in $(seq 1 30); do CODE=$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1/login" || echo 000); [ "$CODE" = "200" ] && break; sleep 2; done
echo "https://$IP/login -> $CODE"
systemctl is-active jenai-web jenai-worker | paste -sd' ' | sed 's/^/services: /'

say "Done."
echo "Open on any computer in the office:  https://$IP"
echo "(The browser warns about the certificate the first time: click Advanced, then Proceed.)"
[ -n "$INVITE" ] && echo "First admin, open once to set your password:  $(echo "$INVITE" | sed "s#^https\?://[^/]*#https://$IP#")"

#!/usr/bin/env bash
# JENAI SaaS: prepare a fresh server to run app.jenai.in.
#
#   bash deploy/02-setup-server.sh <server ip>
#
# Installs Node, pnpm, nginx and certbot; creates the app user and folders;
# gets the HTTPS certificate through DNS (no port 80 juggling); writes the
# service files. It does not deploy the code: that is 03-deploy.sh.
set -euo pipefail

IP=${1:?"usage: bash deploy/02-setup-server.sh <server ip>"}
KEY=${KEY:-$HOME/.ssh/jenai-saas.pem}
HOST=${HOST:-app.jenai.in}
SSH="ssh -i $KEY -o StrictHostKeyChecking=accept-new ubuntu@$IP"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

say "1. Waiting for the server to answer"
for i in $(seq 1 30); do $SSH true 2>/dev/null && break || sleep 5; done

say "2. Base packages"
$SSH 'sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get update -qq && \
  sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  nginx certbot python3-certbot-dns-route53 postgresql-client unzip git ca-certificates curl >/dev/null && echo ok'

say "3. Node 22 and pnpm"
$SSH 'if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" -lt 22 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
    sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  fi
  sudo corepack enable && sudo corepack prepare pnpm@10.18.0 --activate >/dev/null 2>&1
  node -v && pnpm -v'

say "4. The account the app runs as, and where it lives"
$SSH 'sudo useradd -r -m -d /opt/jenai -s /usr/sbin/nologin jenai 2>/dev/null || true
  sudo mkdir -p /opt/jenai/app /etc/jenai /var/log/jenai
  sudo chown -R jenai:jenai /opt/jenai /var/log/jenai
  # Deploys run as ubuntu and step into the app folder, so it has to be traversable.
  sudo chmod 755 /opt/jenai /opt/jenai/app
  # Settings live here: readable by the app account's group, nobody else.
  sudo chown root:jenai /etc/jenai && sudo chmod 750 /etc/jenai'

say "5. HTTPS certificate for '"$HOST"' (through DNS, using the server role)"
$SSH "sudo certbot certonly --dns-route53 --cert-name $HOST -d $HOST --non-interactive --agree-tos --register-unsafely-without-email 2>&1 | tail -3"

say "6. nginx in front of the app"
$SSH "sudo tee /etc/nginx/sites-available/jenai >/dev/null <<'NGINX'
# JENAI SaaS. Everything is served by the Next.js app on 3000; nginx adds TLS,
# the real client address, and a body limit.
map \$http_upgrade \$connection_upgrade { default upgrade; '' close; }

server {
  listen 80;
  server_name HOSTNAME;
  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://\$host\$request_uri; }
}

server {
  # nginx 1.24 (Ubuntu 24.04) takes http2 on the listen line; 1.25+ accepts it too.
  listen 443 ssl http2;
  server_name HOSTNAME;

  ssl_certificate     /etc/letsencrypt/live/HOSTNAME/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/HOSTNAME/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;
  ssl_session_cache shared:SSL:10m;

  client_max_body_size 25m;
  proxy_read_timeout 300s;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection \$connection_upgrade;
    proxy_set_header Host \$host;
    proxy_set_header X-Forwarded-Proto \$scheme;
    # The one address JENAI trusts. nginx overwrites whatever the client sent.
    proxy_set_header x-jenai-client-ip \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
  }
}
NGINX
  sudo sed -i \"s/HOSTNAME/$HOST/g\" /etc/nginx/sites-available/jenai
  sudo ln -sf /etc/nginx/sites-available/jenai /etc/nginx/sites-enabled/jenai
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx && echo 'nginx ready'"

say "7. Renewal keeps working by itself"
$SSH "sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy && sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'HOOK'
#!/bin/sh
nginx -t && systemctl reload nginx
HOOK
  sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
  sudo systemctl enable --now certbot.timer >/dev/null 2>&1; echo ok"

say "8. The two services"
$SSH "sudo tee /etc/systemd/system/jenai-web.service >/dev/null <<'UNIT'
[Unit]
Description=JENAI web
After=network-online.target
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
Description=JENAI worker (dialer, calls sync, security, AI safety, integrations)
After=network-online.target
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
sudo tee /etc/logrotate.d/jenai >/dev/null <<'ROT'
/var/log/jenai/*.log {
  daily
  rotate 200
  compress
  missingok
  notifempty
  copytruncate
}
ROT
sudo systemctl daemon-reload && echo 'services defined (not started: no code yet)'"

say "Ready. Next: bash deploy/03-deploy.sh $IP"

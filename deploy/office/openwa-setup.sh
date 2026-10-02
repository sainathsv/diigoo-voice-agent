#!/usr/bin/env bash
# WhatsApp for the CY Police portal through OpenWA, on this server only (not Meta's cloud).
# Run on the office/police server after office-update.sh and police-mode.sh (safe to run again):
#
#   bash ~/Desktop/openwa-setup.sh
#
#   1. Installs Docker if it is missing.
#   2. Runs OpenWA 0.23.7 (whatsapp-web.js engine), reachable only from this server.
#   3. Lets OpenWA hand WhatsApp messages to the portal (nginx port 8086, Docker networks only).
#   4. Connects the cy-police workspace to it. The gateway key is made here and never shown.
# Then open the portal's WhatsApp page and scan the QR code with the police phone.
set -euo pipefail
ENVF=/etc/jenai/env
OW=/opt/openwa
VERSION=0.23.7
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
apt_install() { sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@" >/dev/null; }
sudo -v
sudo test -f $ENVF || { echo "JENAI is not installed on this server yet (run setup-fusionstor.sh first)."; exit 1; }
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
[ "$MEM_GB" -ge 4 ] || echo "Note: this server has ${MEM_GB} GB of memory; OpenWA needs about 0.5 GB more."

say "1. Docker"
if ! command -v docker >/dev/null; then
  sudo NEEDRESTART_MODE=a DEBIAN_FRONTEND=noninteractive apt-get update -qq
  apt_install docker.io
fi
sudo docker compose version >/dev/null 2>&1 || apt_install docker-compose-v2 2>/dev/null || apt_install docker-compose-plugin
sudo systemctl enable --now docker >/dev/null 2>&1
sudo docker compose version

say "2. OpenWA $VERSION"
sudo mkdir -p $OW && sudo chmod 700 $OW
if ! sudo test -f $OW/.env; then
  sudo tee $OW/.env >/dev/null <<ENVFILE
API_MASTER_KEY=$(openssl rand -hex 32)
ENGINE_TYPE=whatsapp-web.js
SEND_PACING_ENABLED=true
SSRF_ALLOWED_HOSTS=host.docker.internal
UPDATE_CHECK_ENABLED=false
ENABLE_SWAGGER=false
LOG_LEVEL=info
ENVFILE
  sudo chmod 600 $OW/.env
  echo "gateway key made and kept in $OW/.env (root only)"
fi
sudo tee $OW/docker-compose.yml >/dev/null <<COMPOSE
services:
  openwa:
    image: ghcr.io/rmyndharis/openwa:$VERSION
    container_name: openwa
    restart: unless-stopped
    env_file: .env
    environment:
      - NODE_ENV=production
      - PORT=2785
      - HOME=/tmp
      - XDG_CONFIG_HOME=/tmp/.config
      - XDG_CACHE_HOME=/tmp/.cache
    ports:
      - "127.0.0.1:2785:2785"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - openwa-data:/app/data
    security_opt:
      - no-new-privileges:true
    tmpfs:
      - /tmp
    mem_limit: 2g
    pids_limit: 2048
volumes:
  openwa-data:
COMPOSE
sudo docker compose --project-directory $OW -f $OW/docker-compose.yml pull -q && sudo docker compose --project-directory $OW -f $OW/docker-compose.yml up -d
printf "waiting for OpenWA"
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:2785/api/health/ready >/dev/null && break; printf "."; sleep 3; done
echo
curl -sf http://127.0.0.1:2785/api/health/ready >/dev/null && echo "OpenWA is running" || { echo "OpenWA did not start; see: sudo docker logs openwa --tail 50"; exit 1; }

say "3. Delivery from OpenWA to the portal"
sudo tee /etc/nginx/sites-available/jenai-openwa >/dev/null <<'NGINX'
# OpenWA (in Docker on this server) delivers WhatsApp events here. Only this server and its
# Docker networks may connect, and only the webhook address is served.
server {
  listen 8086;
  allow 127.0.0.1;
  allow 172.16.0.0/12;
  deny all;
  client_max_body_size 25m;
  location = /api/whatsapp/openwa {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header x-jenai-client-ip $remote_addr;
  }
  location / { return 404; }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/jenai-openwa /etc/nginx/sites-enabled/jenai-openwa
sudo nginx -t && sudo systemctl reload nginx
if command -v ufw >/dev/null && sudo ufw status | grep -q active; then
  sudo ufw allow from 172.16.0.0/12 to any port 8086 proto tcp >/dev/null
  echo "firewall: port 8086 open to Docker networks only"
fi

say "4. Connecting the CY Police workspace"
sudo grep '^API_MASTER_KEY=' $OW/.env | cut -d= -f2- |
  sudo -u jenai bash -c "set -a; . $ENVF; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /opt/jenai/app && pnpm --silent --filter @jenai/db whatsapp --slug cy-police --openwa http://127.0.0.1:2785"

say "Done."
echo "Next, in the portal (signed in as CY_Police):"
echo "  1. Open WhatsApp in the menu and click 'Link the WhatsApp number'."
echo "  2. On the police phone: WhatsApp > Settings > Linked devices > Link a device, and scan the QR code."
echo "  3. On the same page, paste the cyber team's complaint form link (for complaints without money lost)."

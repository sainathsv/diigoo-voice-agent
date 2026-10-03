#!/usr/bin/env bash
# The complaint status lookup at the start of each call (CY Police). Run on the police
# server, after the cloud voice server has joined this server's Tailscale network:
#
#   bash ~/Desktop/voice-status-setup.sh
#
#   1. Lets the voice engine ask this server, over Tailscale only, whether the number calling
#      has a complaint in progress (nginx port 8087: Tailscale addresses only, one address served).
#   2. Puts the lookup on phone agent #18, with a fresh token the engine keeps as a credential.
# The answer is the status alone ("In Progress" or "none"), never anything from a complaint.
set -euo pipefail
ENVF=/etc/jenai/env
WORKFLOW="${WORKFLOW:-18}"
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
sudo -v
sudo test -f $ENVF || { echo "JENAI is not installed on this server yet."; exit 1; }
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
[ -n "$TS_IP" ] || { echo "Tailscale is not running on this server."; exit 1; }

say "1. The lookup address, for the Tailscale network only"
sudo tee /etc/nginx/sites-available/jenai-voice-status >/dev/null <<'NGINX'
# The voice engine (on this server's Tailscale network) asks here whether the number calling
# has a complaint in progress. Only Tailscale addresses may connect, and only this address is served.
server {
  listen 8087;
  allow 100.64.0.0/10;
  allow 127.0.0.1;
  deny all;
  client_max_body_size 16k;
  location = /api/voice/precall {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header x-jenai-client-ip $remote_addr;
    proxy_read_timeout 8s;
  }
  location / { return 404; }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/jenai-voice-status /etc/nginx/sites-enabled/jenai-voice-status
sudo nginx -t && sudo systemctl reload nginx
if command -v ufw >/dev/null && sudo ufw status | grep -q active; then
  sudo ufw allow from 100.64.0.0/10 to any port 8087 proto tcp >/dev/null
  echo "firewall: port 8087 open to Tailscale addresses only"
fi
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$TS_IP:8087/api/voice/precall")
[ "$code" = "401" ] && echo "lookup answers on http://$TS_IP:8087 (and refuses requests without the token)" || { echo "lookup did not answer as expected (HTTP $code)"; exit 1; }

say "2. Phone agent #$WORKFLOW"
sudo -u jenai bash -c "set -a; . $ENVF; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /opt/jenai/app && pnpm --silent --filter @jenai/db cy-agent --workflow $WORKFLOW --slug cy-police --status-url http://$TS_IP:8087/api/voice/precall"

say "Done."
echo "Call 92621 02414 from a number that has a complaint in progress: the agent tells you its status."

#!/usr/bin/env bash
# Turns the office JENAI into the CY Police portal that needs no AWS. Run on the server
# after office-update.sh (safe to run again):
#
#   bash ~/Desktop/police-mode.sh
#
#   1. Shows this server's memory, processor, graphics card and free disk.
#   2. Installs Ollama (AI that runs on this server) and a model that fits, so calls are
#      read here. If the server is too small for it, calls still work without that step.
#   3. Switches the portal to the police edition: only Analytics, Calls, Team, Roles,
#      Branches and Activity log; every recording kept here; new calls copied every minute.
#   4. Removes the AWS keys from the settings file.
#   5. Lets the portal open on every address of this server (office network and Tailscale), and shows the
#      government telephone line status (cable, address, telecom system) on the home page.
#   6. Copies the recordings of earlier calls to this server.
set -euo pipefail
ENVF=/etc/jenai/env
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
setenv() { if sudo grep -q "^$1=" $ENVF; then sudo sed -i "s#^$1=.*#$1=$2#" $ENVF; else echo "$1=$2" | sudo tee -a $ENVF >/dev/null; fi; }
sudo -v
sudo test -f $ENVF || { echo "JENAI is not installed on this server yet (run setup-fusionstor.sh first)."; exit 1; }

say "1. This server"
MEM_GB=$(awk '/MemTotal/ {printf "%d", $2/1048576}' /proc/meminfo)
CPUS=$(nproc)
GPU_GB=0
command -v nvidia-smi >/dev/null 2>&1 && GPU_GB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | awk '{printf "%d", $1/1024}')
DISK_GB=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
echo "memory ${MEM_GB} GB, ${CPUS} processor cores, graphics card ${GPU_GB:-0} GB, free disk ${DISK_GB} GB"
# gemma3 reads Hindi, English and Nepali well. 12b is better; 4b fits a small server.
MODEL=""
if [ "${GPU_GB:-0}" -ge 10 ] || { [ "$MEM_GB" -ge 24 ] && [ "$CPUS" -ge 8 ]; }; then MODEL=gemma3:12b; NEED_GB=12
elif [ "$MEM_GB" -ge 10 ]; then MODEL=gemma3:4b; NEED_GB=6
fi
if [ -n "$MODEL" ] && [ "$DISK_GB" -lt "$NEED_GB" ]; then echo "not enough free disk for $MODEL (needs ${NEED_GB} GB)"; MODEL=""; fi

if [ -n "$MODEL" ]; then
  say "2. Local AI: Ollama with $MODEL (the download is several GB, it can take a while)"
  command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh
  sudo systemctl enable --now ollama >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do curl -s http://127.0.0.1:11434/api/version >/dev/null && break; sleep 1; done
  ollama pull "$MODEL"
  # Long calls need a long context; without it the model silently drops the start of the transcript.
  MF=$(mktemp)
  printf 'FROM %s\nPARAMETER num_ctx 16384\nPARAMETER temperature 0\n' "$MODEL" >"$MF"
  ollama create jenai-analyzer -f "$MF" >/dev/null && rm -f "$MF"
  echo "test question to the local AI (the first answer is the slowest)..."
  T0=$(date +%s)
  ANSWER=$(curl -s --max-time 900 http://127.0.0.1:11434/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"jenai-analyzer","temperature":0,"response_format":{"type":"json_object"},"messages":[{"role":"user","content":"A caller said: mera naam Ramesh Kumar hai, mere 40000 rupaye UPI se kat gaye. Reply only with JSON with keys caller_name and amount_lost."}]}' |
    python3 -c 'import sys,json; print(json.load(sys.stdin)["choices"][0]["message"]["content"])' 2>/dev/null || echo "no answer")
  echo "answer in $(( $(date +%s) - T0 ))s: $ANSWER"
  setenv JENAI_ANALYZE true
  setenv JENAI_ANALYZER_PROVIDER local
  setenv JENAI_ANALYZER_BASE_URL http://127.0.0.1:11434/v1
  setenv JENAI_ANALYZER_MODEL jenai-analyzer
  setenv JENAI_ANALYZER_TIMEOUT_MS 900000
else
  say "2. Local AI skipped: this server has too little memory or disk"
  echo "Calls, transcripts, recordings and the details the call agent collects all still work."
  setenv JENAI_ANALYZE false
fi

say "3. Police edition"
setenv JENAI_EDITION police
setenv JENAI_SYNC true
setenv JENAI_SYNC_SECONDS 60
setenv JENAI_STORE_RECORDINGS true
setenv JENAI_SAFETY false
setenv JENAI_INTEGRATIONS false
setenv JENAI_REAL_DIALS false
# The government telephone line status on the home page; finds the one spare Ethernet port by itself.
sudo grep -q '^JENAI_TEL_IFACE=' $ENVF || setenv JENAI_TEL_IFACE auto
echo ok

say "4. Removing the AWS keys"
N=$(sudo grep -cE '^(AWS_[A-Z_]+|JENAI_ANALYZER_REGION|JENAI_ALERT_SNS_TOPIC_ARN)=' $ENVF || true)
sudo sed -i -E '/^(AWS_[A-Z_]+|JENAI_ANALYZER_REGION|JENAI_ALERT_SNS_TOPIC_ARN)=/d' $ENVF
echo "removed ${N:-0} AWS setting(s)"

say "5. Addresses the portal opens on"
TS=$(tailscale ip -4 2>/dev/null | head -1 || true)
ADDRS=$( { hostname -I | tr ' ' '\n'; echo "$TS"; } | grep -E '^[0-9]+(\.[0-9]+){3}$' | awk '!seen[$0]++')
NEW_CERT=0
for a in $ADDRS; do sudo openssl x509 -in /etc/jenai/tls.crt -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$a\b" || NEW_CERT=1; done
if [ "$NEW_CERT" = 1 ]; then
  SAN="$(for a in $ADDRS; do printf 'IP:%s,' "$a"; done)DNS:$(hostname)"
  sudo openssl req -x509 -nodes -newkey rsa:2048 -days 825 -subj "/CN=$(hostname)" -addext "subjectAltName=$SAN" \
    -keyout /etc/jenai/tls.key -out /etc/jenai/tls.crt >/dev/null 2>&1
  sudo chmod 600 /etc/jenai/tls.key
  sudo systemctl reload nginx
  echo "new certificate for: $(echo $ADDRS)"
fi
setenv JENAI_TRUSTED_ORIGINS "$(for a in $ADDRS; do printf 'https://%s,' "$a"; done | sed 's/,$//')"
CUR=$(sudo grep '^BETTER_AUTH_URL=' $ENVF | cut -d= -f2- | sed -E 's#^https?://##; s#[:/].*##')
if ! echo "$ADDRS" | grep -qx "$CUR"; then
  MAIN=${TS:-$(echo "$ADDRS" | head -1)}
  setenv BETTER_AUTH_URL "https://$MAIN"
  setenv JENAI_PUBLIC_URL "https://$MAIN"
  echo "main address was $CUR (no longer this server), now $MAIN"
fi

say "6. Restarting and copying the recordings of earlier calls"
sudo systemctl restart jenai-web jenai-worker
sudo -u jenai bash -c "set -a; . $ENVF; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /opt/jenai/app && pnpm --silent --filter @jenai/db voice --slug cy-police --sync-only --refetch" ||
  echo "could not reach the voice engine just now; the portal keeps trying every minute"

say "Done."
sleep 3
sudo grep '"worker.started"' /var/log/jenai/worker.log | tail -1 | grep -o '"edition":"[a-z]*"' || echo "worker: check /var/log/jenai/worker.log"
echo "AWS settings left: $(sudo grep -cE '^AWS_' $ENVF || true)"
for a in $ADDRS; do echo "https://$a  -> $(curl -sk -o /dev/null -w '%{http_code}' "https://$a/login" || echo no answer)"; done
echo "Open any address above that shows 200. Sign in as CY_Police; the portal opens on Analytics."

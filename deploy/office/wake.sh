#!/usr/bin/env bash
# Wakes and checks everything the CY Police helpline needs on this server, fixing what it can:
#
#   bash ~/Desktop/wake.sh
#
#   1. WhatsApp (OpenWA): no sending limits (the department's decision: the cyber cell answers
#      every complainant), reconnecting by itself after a restart, the linked number reconnected
#      if it dropped, and the connection shown.
#   2. The AI on this server (Ollama): kept loaded all the time, restarted, and asked a question.
#   3. The portal's worker: restarted; unread WhatsApp messages read again; replies WhatsApp
#      refused are sent again by the worker within 2 minutes.
#   4. A short report. Safe to run any time.
set -uo pipefail
ENVF=/etc/jenai/env
OW=/opt/openwa
PROBLEMS=0
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok() { printf "  \033[32mOK\033[0m  %s\n" "$*"; }
bad() { printf "  \033[31mPROBLEM\033[0m  %s\n" "$*"; PROBLEMS=$((PROBLEMS + 1)); }
sudo -v
sudo test -f $ENVF || { echo "JENAI is not installed on this server yet."; exit 1; }

say "1. WhatsApp"
if sudo test -f $OW/.env; then
  CHANGED=0
  owset() {
    sudo grep -q "^$1=$2\$" $OW/.env && return 0
    CHANGED=1
    if sudo grep -q "^$1=" $OW/.env; then sudo sed -i "s#^$1=.*#$1=$2#" $OW/.env; else echo "$1=$2" | sudo tee -a $OW/.env >/dev/null; fi
  }
  owset SEND_PACING_ENABLED false
  owset AUTO_START_SESSIONS true
  owset RATE_LIMIT_SHORT_LIMIT 1000
  owset RATE_LIMIT_MEDIUM_LIMIT 20000
  owset RATE_LIMIT_LONG_LIMIT 1000000
  # Restarted only when a setting changed or it is not running: a restart drops WhatsApp for a minute.
  if [ $CHANGED = 1 ] || ! curl -sf http://127.0.0.1:2785/api/health/ready >/dev/null; then
    echo "      starting the WhatsApp gateway with the new settings..."
    sudo docker compose --project-directory $OW -f $OW/docker-compose.yml up -d --force-recreate >/dev/null 2>&1
  fi
  for _ in $(seq 1 40); do curl -sf http://127.0.0.1:2785/api/health/ready >/dev/null && break; sleep 3; done
  if curl -sf http://127.0.0.1:2785/api/health/ready >/dev/null; then
    ok "WhatsApp gateway running, with no sending limits, reconnecting by itself after a restart"
    KEY=$(sudo grep '^API_MASTER_KEY=' $OW/.env | cut -d= -f2-)
    sessions() { curl -s -H "X-API-Key: $KEY" http://127.0.0.1:2785/api/sessions; }
    pick() { python3 -c '
import sys, json
d = json.load(sys.stdin)
d = d.get("data", d) if isinstance(d, dict) else d
mode = sys.argv[1]
for s in d:
    if mode == "down" and s.get("status") in ("disconnected", "failed") and s.get("phone"): print(s["id"])
    if mode == "state": print(s.get("status"))
    if mode == "show": print("      linked number:", "+" + str(s.get("phone") or "?").lstrip("+"), "| status:", s.get("status"))' "$1" 2>/dev/null; }
    # The linked number reconnects with the login the gateway kept: no QR code needed.
    for ID in $(sessions | pick down); do
      echo "      reconnecting WhatsApp..."
      curl -s -o /dev/null -X POST -H "X-API-Key: $KEY" "http://127.0.0.1:2785/api/sessions/$ID/start"
    done
    STATE=""
    for _ in $(seq 1 40); do
      STATE=$(sessions | pick state | head -1)
      [ "$STATE" = ready ] || [ "$STATE" = qr_ready ] && break
      sleep 3
    done
    sessions | pick show
    if [ "$STATE" = ready ]; then ok "WhatsApp connected"
    elif [ "$STATE" = qr_ready ]; then bad "WhatsApp needs its QR code scanned: portal > WhatsApp > Show a new QR code, then on the helpline phone WhatsApp > Linked devices > Link a device"
    else bad "WhatsApp is not connected yet (status: ${STATE:-none}): run this again in a minute"; fi
  else
    bad "WhatsApp gateway did not start: sudo docker logs openwa --tail 50"
  fi
else
  bad "WhatsApp gateway (OpenWA) is not installed: bash ~/Desktop/openwa-setup.sh"
fi

say "2. The AI on this server"
if command -v ollama >/dev/null; then
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  printf '[Service]\nEnvironment="OLLAMA_KEEP_ALIVE=-1"\n' | sudo tee /etc/systemd/system/ollama.service.d/jenai.conf >/dev/null
  sudo systemctl daemon-reload
  sudo systemctl enable ollama >/dev/null 2>&1
  sudo systemctl restart ollama
  for _ in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/version >/dev/null && break; sleep 1; done
  MODEL=$(sudo grep '^JENAI_ANALYZER_MODEL=' $ENVF | cut -d= -f2-)
  MODEL=${MODEL:-jenai-analyzer}
  if ollama list 2>/dev/null | grep -q "^$MODEL"; then
    echo "      asking the AI a test question (the first answer after a restart is the slowest)..."
    T0=$(date +%s)
    A=$(curl -s --max-time 600 http://127.0.0.1:11434/v1/chat/completions -H 'Content-Type: application/json' \
      -d "{\"model\":\"$MODEL\",\"temperature\":0,\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"Reply with one word: ready\"}]}" |
      python3 -c 'import sys,json; print(json.load(sys.stdin)["choices"][0]["message"]["content"].strip()[:40])' 2>/dev/null)
    if [ -n "$A" ]; then ok "AI ($MODEL) answered in $(($(date +%s) - T0))s (\"$A\"), and now stays loaded"; else bad "the AI did not answer: sudo journalctl -u ollama --since '10 min ago' | tail -30"; fi
  else
    bad "the AI model $MODEL is missing: bash ~/Desktop/police-mode.sh"
  fi
else
  bad "the AI (Ollama) is not installed: bash ~/Desktop/police-mode.sh (WhatsApp still reads plain answers without it)"
fi

say "3. The portal"
# Calls are copied every 15 seconds, so WhatsApp follows a call as soon as it ends.
if sudo grep -q '^JENAI_SYNC_SECONDS=' $ENVF; then sudo sed -i 's#^JENAI_SYNC_SECONDS=.*#JENAI_SYNC_SECONDS=15#' $ENVF; else echo 'JENAI_SYNC_SECONDS=15' | sudo tee -a $ENVF >/dev/null; fi
sudo -u postgres psql -d jenai -qtAc "update whatsapp_inbox set attempts = 0, last_error = null where processed_at is null" >/dev/null && ok "unread WhatsApp messages will be read again"
sudo systemctl restart jenai-worker
sleep 5
if [ "$(systemctl is-active jenai-worker)" = active ]; then ok "worker running"; else bad "worker not running: sudo journalctl -u jenai-worker -n 50"; fi
if [ "$(systemctl is-active jenai-web)" = active ]; then ok "portal running"; else bad "portal not running: sudo systemctl restart jenai-web"; fi

say "4. Report (after 30 seconds)"
sleep 30
sudo journalctl -u jenai-worker --since "1 min ago" --no-pager -o cat | grep -E '"event":"(worker.started|whatsapp|analyze|cases|sync)' | tail -8 | cut -c1-220
sudo -u postgres psql -d jenai -qtAc "select '  unread WhatsApp messages: ' || count(*) from whatsapp_inbox where processed_at is null"
sudo -u postgres psql -d jenai -qtAc "select '  replies not delivered in the last day (sent again every 2 minutes): ' || count(*) from case_messages where direction = 'out' and status = 'failed' and at > now() - interval '1 day'"
echo
if [ $PROBLEMS -eq 0 ]; then echo "Everything is working."; else echo "$PROBLEMS problem(s) above."; fi

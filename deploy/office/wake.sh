#!/usr/bin/env bash
# Wakes and checks everything the CY Police helpline needs on this server, fixing what it can:
#
#   bash ~/Desktop/wake.sh
#
#   1. WhatsApp (OpenWA): no sending limits (the department's decision: the cyber cell answers
#      every complainant), restarted, and the linked number and connection shown.
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
  owset() { if sudo grep -q "^$1=" $OW/.env; then sudo sed -i "s#^$1=.*#$1=$2#" $OW/.env; else echo "$1=$2" | sudo tee -a $OW/.env >/dev/null; fi; }
  owset SEND_PACING_ENABLED false
  owset RATE_LIMIT_SHORT_LIMIT 1000
  owset RATE_LIMIT_MEDIUM_LIMIT 20000
  owset RATE_LIMIT_LONG_LIMIT 1000000
  sudo docker compose --project-directory $OW -f $OW/docker-compose.yml up -d --force-recreate >/dev/null 2>&1
  for _ in $(seq 1 40); do curl -sf http://127.0.0.1:2785/api/health/ready >/dev/null && break; sleep 3; done
  if curl -sf http://127.0.0.1:2785/api/health/ready >/dev/null; then
    ok "WhatsApp gateway running, with no sending limits"
    KEY=$(sudo grep '^API_MASTER_KEY=' $OW/.env | cut -d= -f2-)
    S=""
    for _ in $(seq 1 30); do
      S=$(curl -s -H "X-API-Key: $KEY" http://127.0.0.1:2785/api/sessions)
      echo "$S" | grep -q '"status":"ready"' && break
      sleep 3
    done
    echo "$S" | python3 -c '
import sys, json
d = json.load(sys.stdin)
d = d.get("data", d) if isinstance(d, dict) else d
for s in d:
    print("      linked number:", "+" + str(s.get("phone") or "?").lstrip("+"), "| status:", s.get("status"))' 2>/dev/null
    echo "$S" | grep -q '"status":"ready"' && ok "WhatsApp connected" || bad "WhatsApp is not connected: open the portal's WhatsApp page and link the number again"
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

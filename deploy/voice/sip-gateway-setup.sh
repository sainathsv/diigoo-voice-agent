#!/usr/bin/env bash
# The voice server's end of the government telephone line. An Asterisk here takes the police
# server's calls (SIP over TLS with SRTP audio, from the office's internet address only), and the
# voice engine on this server answers each one with the AI agent, through Asterisk's REST interface
# (ARI) and an audio WebSocket that both stay on this server:
#
#   police server <-SIP over TLS + SRTP, internet-> this Asterisk <-ARI + audio, this server-> voice engine
#
# Run on the voice server (65.1.4.82) after sip-bridge-setup.sh on the police server, with the
# office's internet address that script printed (safe to run again; a run restarts this Asterisk):
#
#   curl -fsSL https://raw.githubusercontent.com/sainathsv/diigoo-voice-agent/main/deploy/voice/sip-gateway-setup.sh | sudo bash -s -- <office address>
#
#   1. This server: the voice engine, its database and web server, its internet address.
#   2. The bridge as the police server set it up on the voice engine (ARI user, password, Stasis app).
#   3. The web server's certificate for voice.jenai.in, which the police server checks; renewals
#      are picked up by themselves, between calls.
#   4. Asterisk 23 (Docker, this server's network): TLS from the office's address only, each call
#      to the voice engine.
#   5. Firewall on this server, if it has one. The AWS security group must also let the office in:
#      TCP 5061 and UDP 10000-10200, from the office's address only.
#   6. Checks: the certificate as the police server sees it, and the voice engine connected.
set -euo pipefail
OFFICE_IP="${1:-${OFFICE_IP:-}}"
TLS_NAME="${TLS_NAME:-voice.jenai.in}"
NAME=jenai-sip
IMAGE=andrius/asterisk:23.4.1_debian-trixie
AST=/etc/jenai-sip
BRIDGE="Police server SIP bridge"
EXTEN=1930
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok() { printf "  \033[32mOK\033[0m  %s\n" "$*"; }
note() { printf "  \033[33mNOTE\033[0m  %s\n" "$*"; }
die() { printf "  \033[31mPROBLEM\033[0m  %s\n" "$*"; exit 1; }
ast() { docker exec $NAME asterisk -rx "$1" 2>/dev/null || true; }
container() { docker ps --format '{{.Names}} {{.Image}}' | awk -v re="$1" '$0 ~ re {print $1; exit}'; }
[ "$(id -u)" = 0 ] || die "Run it with sudo: ... | sudo bash -s -- <office address>"
[[ "$OFFICE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Give the office's internet address that sip-bridge-setup.sh printed on the police server: ... | sudo bash -s -- <office address>"
case "$OFFICE_IP" in
  10.* | 127.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[01].* | 100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*)
    die "$OFFICE_IP is a private address. Give the office's internet address that sip-bridge-setup.sh printed." ;;
esac
command -v docker >/dev/null || die "Docker is not on this server: run this on the voice server."

say "1. This server"
API=$(container 'dograh-api')
PG=$(container 'postgres')
NGX=$(container ' nginx')
[ -n "$API" ] || die "The voice engine (dograh-api) is not running on this server."
[ -n "$PG" ] || die "The voice engine's database is not running on this server."
PUBLIC=$(curl -fsS --max-time 8 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
[[ "$PUBLIC" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Could not find this server's internet address."
ok "voice engine $API, database $PG; this server's internet address is $PUBLIC"

say "2. The bridge on the voice engine"
SQL="select credentials->>'ari_endpoint', credentials->>'app_name', coalesce(nullif(credentials->>'stasis_app_name', ''), credentials->>'app_name'), credentials->>'app_password', coalesce(nullif(credentials->>'ws_client_name', ''), 'dograh') from telephony_configurations where name = '$BRIDGE' and provider = 'ari' order by id desc limit 1"
ROW=$(docker exec "$PG" psql -U postgres -d postgres -At -F ' ' -c "$SQL" 2>/dev/null || true)
read -r ARI_URL ARI_USER STASIS ARI_PASS WS_CLIENT <<<"$ROW" || true
[ -n "${ARI_PASS:-}" ] || die "The voice engine has no bridge from the police server yet: run sip-bridge-setup.sh on the police server first."
[[ "$ARI_URL" =~ ^http://([0-9.]+):([0-9]+)$ ]] || die "The bridge's ARI address ($ARI_URL) is not http://<address>:<port>: run sip-bridge-setup.sh on the police server again."
ARI_HOST=${BASH_REMATCH[1]}
ARI_PORT=${BASH_REMATCH[2]}
[[ "$ARI_USER$STASIS$WS_CLIENT" =~ ^[A-Za-z0-9_.-]+$ ]] && [[ "$ARI_PASS" =~ ^[A-Za-z0-9]+$ ]] || die "The bridge's settings on the voice engine are not as sip-bridge-setup.sh makes them: run it on the police server again."
if ! ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx "$ARI_HOST"; then
  D0=$(ip -4 -o addr show docker0 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
  die "The bridge sends the voice engine to $ARI_URL, which is not on this server. On the police server run: ARI_URL=http://${D0:-172.17.0.1}:8088 bash ~/Desktop/sip-bridge-setup.sh"
fi
ok "ARI user $ARI_USER at $ARI_URL; calls go to the Stasis application $STASIS"

say "3. The certificate for $TLS_NAME"
if [ -z "${CERT:-}" ] && [ -n "$NGX" ]; then
  CERTDIR=$(docker inspect "$NGX" -f '{{range .Mounts}}{{if eq .Destination "/etc/nginx/certs"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
  KEYS=""
  for p in $(docker exec "$NGX" sh -c "grep -rhoE 'ssl_certificate(_key)?[[:space:]]+[^;]+' /etc/nginx/conf.d 2>/dev/null" | awk '{print $2}' | sort -u); do
    case "$p" in /etc/nginx/certs/*) h="$CERTDIR/${p#/etc/nginx/certs/}" ;; *) continue ;; esac
    [ -n "$CERTDIR" ] && [ -f "$h" ] || continue
    if openssl x509 -in "$h" -noout 2>/dev/null; then
      openssl x509 -in "$h" -noout -text | grep -q "DNS:$TLS_NAME" && CERT="$h"
    else
      KEYS="$KEYS $h"
    fi
  done
  if [ -n "${CERT:-}" ]; then
    PUB=$(openssl x509 -in "$CERT" -noout -pubkey)
    for k in $KEYS; do [ "$(openssl pkey -in "$k" -pubout 2>/dev/null)" = "$PUB" ] && KEY="$k"; done
  fi
fi
[ -n "${CERT:-}" ] && [ -f "$CERT" ] && [ -n "${KEY:-}" ] && [ -f "$KEY" ] || die "Could not find the web server's certificate for $TLS_NAME. Give it: CERT=/path/to/fullchain.pem KEY=/path/to/key.pem (with sudo -E)."
openssl x509 -in "$CERT" -noout -text | grep -q "DNS:$TLS_NAME" || die "$CERT is not a certificate for $TLS_NAME."
openssl x509 -in "$CERT" -noout -checkend 86400 >/dev/null || die "The certificate $CERT has expired or expires within a day: renew it first."
ok "$CERT, valid until $(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)"
id jenaisip >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin jenaisip
mkdir -p $AST/keys
install -o jenaisip -g jenaisip -m 640 "$CERT" $AST/keys/sip.crt
install -o jenaisip -g jenaisip -m 600 "$KEY" $AST/keys/sip.key
# Renewals: every hour, a renewed certificate is copied in and Asterisk restarted, only between calls.
cat > /usr/local/sbin/jenai-sip-cert <<SCRIPT
#!/bin/sh
# Gives the government line's Asterisk the renewed $TLS_NAME certificate, between calls (sip-gateway-setup.sh).
cmp -s "$CERT" $AST/keys/sip.crt && cmp -s "$KEY" $AST/keys/sip.key && exit 0
calls=\$(docker exec $NAME asterisk -rx "core show channels count" 2>/dev/null | awk '/active call/ {print \$1}')
[ "\${calls:-0}" = 0 ] || exit 0
install -o jenaisip -g jenaisip -m 640 "$CERT" $AST/keys/sip.crt
install -o jenaisip -g jenaisip -m 600 "$KEY" $AST/keys/sip.key
docker restart $NAME >/dev/null
SCRIPT
chmod 755 /usr/local/sbin/jenai-sip-cert
echo "23 * * * * root /usr/local/sbin/jenai-sip-cert" > /etc/cron.d/jenai-sip-cert
ok "renewals are picked up by themselves, between calls"

say "4. Asterisk"
w() { tee "$AST/$1" >/dev/null; }
# Each call's audio: to the voice engine on this server directly, else through its web address.
if curl -fsS --max-time 5 http://127.0.0.1:8000/api/v1/health >/dev/null 2>&1; then
  MEDIA="ws://127.0.0.1:8000/api/v1/telephony/ws/ari"; MEDIA_TLS=no
else
  MEDIA="wss://$TLS_NAME/api/v1/telephony/ws/ari"; MEDIA_TLS=yes
fi
w modules.conf <<'CONF'
[modules]
autoload = yes
; Not used here, so nothing else listens.
noload = chan_iax2.so
noload = chan_unistim.so
noload = chan_mgcp.so
noload = chan_skinny.so
noload = res_pjsip_phoneprov.so
CONF
w logger.conf <<'CONF'
[general]
[logfiles]
console => notice,warning,error
messages => notice,warning,error
CONF
w pjsip.conf <<CONF
; The police server's calls, over the internet: TLS only, from the office's address only, SRTP audio.
[transport-tls]
type = transport
protocol = tls
bind = 0.0.0.0:5061
cert_file = /etc/asterisk/keys/sip.crt
priv_key_file = /etc/asterisk/keys/sip.key
method = tlsv1_2
external_signaling_address = $PUBLIC
external_media_address = $PUBLIC
local_net = 10.0.0.0/8
local_net = 172.16.0.0/12
local_net = 192.168.0.0/16
local_net = 127.0.0.0/8

[police]
type = endpoint
transport = transport-tls
context = from-police
disallow = all
allow = ulaw,alaw
media_encryption = sdes
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
dtmf_mode = rfc4733

[police]
type = identify
endpoint = police
match = $OFFICE_IP
CONF
w extensions.conf <<CONF
[general]
static = yes
writeprotect = yes

; The police server's calls go to the AI: extension $EXTEN, answered by the voice engine.
[from-police]
exten => _X.,1,Goto(jenai-ai,$EXTEN,1)
exten => _+X.,1,Goto(jenai-ai,$EXTEN,1)
exten => s,1,Goto(jenai-ai,$EXTEN,1)

[jenai-ai]
exten => $EXTEN,1,Stasis($STASIS)
 same => n,Hangup()
CONF
w ari.conf <<CONF
[general]
enabled = yes
pretty = no

[$ARI_USER]
type = user
read_only = no
password = $ARI_PASS
CONF
w http.conf <<CONF
; ARI, for the voice engine only: on Docker's address for this server, which only containers here reach.
[general]
enabled = yes
bindaddr = $ARI_HOST
bindport = $ARI_PORT
CONF
w websocket_client.conf <<CONF
; Each call's audio goes to the voice engine on this server.
[$WS_CLIENT]
type = websocket_client
uri = $MEDIA
protocols = media
tls_enabled = $MEDIA_TLS
ca_list_file = /etc/ssl/certs/ca-certificates.crt
CONF
w rtp.conf <<'CONF'
[general]
rtpstart = 10000
rtpend = 10200
CONF
chown -R jenaisip:jenaisip $AST
find $AST -type d -exec chmod 750 {} +
find $AST -type f -exec chmod 640 {} +
chmod 600 $AST/keys/sip.key
if docker ps -a --format '{{.Names}}' | grep -qx $NAME; then
  echo "      restarting Asterisk with the settings above..."
  docker restart $NAME >/dev/null
else
  echo "      starting Asterisk (the first download takes a minute)..."
  docker pull -q $IMAGE >/dev/null
  docker run -d --name $NAME --restart unless-stopped --network host \
    -e PUID="$(id -u jenaisip)" -e PGID="$(id -g jenaisip)" -e ASTERISK_TERMINAL_OPTS="-n" \
    -v $AST:/etc/asterisk \
    -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro \
    --memory 1g --log-opt max-size=10m --log-opt max-file=3 \
    $IMAGE >/dev/null
fi
for _ in $(seq 1 30); do ast "core show version" | grep -q Asterisk && break; sleep 2; done
ast "core show version" | grep -q Asterisk || die "Asterisk did not start: docker logs $NAME --tail 50"
ok "$(ast 'core show version' | head -1 | cut -c1-40) is running"
for mod in res_pjsip chan_pjsip res_srtp res_ari res_http_websocket chan_websocket res_websocket_client; do
  ast "module show like $mod" | grep -q Running || die "Asterisk's $mod module is not running: docker logs $NAME --tail 50"
done
ast "pjsip show transports" | grep -q transport-tls || die "Asterisk's encrypted connection (TLS) did not start: docker logs $NAME --tail 50"
ok "Asterisk takes the police server's calls on TCP 5061 (TLS), audio on UDP 10000-10200 (SRTP)"

say "5. Firewall"
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow from "$OFFICE_IP" to any port 5061 proto tcp >/dev/null
  ufw allow from "$OFFICE_IP" to any port 10000:10200 proto udp >/dev/null
  ufw allow from 172.16.0.0/12 to "$ARI_HOST" port "$ARI_PORT" proto tcp >/dev/null
  ok "this server's firewall lets the office in, and the voice engine reach ARI"
else
  note "this server has no firewall of its own: its AWS security group decides who reaches it (see below)"
fi

say "6. Checks"
if echo | openssl s_client -connect 127.0.0.1:5061 -servername "$TLS_NAME" -verify_hostname "$TLS_NAME" -CAfile /etc/ssl/certs/ca-certificates.crt 2>/dev/null | grep -q "Verify return code: 0 (ok)"; then
  ok "the police server will find a valid certificate for $TLS_NAME"
else
  die "Asterisk's certificate does not check out for $TLS_NAME: docker logs $NAME --tail 50"
fi
if docker exec "$API" python -c "import socket; socket.create_connection(('$ARI_HOST', $ARI_PORT), 3)" >/dev/null 2>&1; then
  ok "the voice engine reaches Asterisk's REST interface"
else
  die "The voice engine cannot reach $ARI_HOST:$ARI_PORT: send me: docker logs $NAME --tail 30"
fi
echo "      waiting for the voice engine to connect (it looks every minute)..."
for _ in $(seq 1 30); do ast "ari show apps" | grep -qw "$STASIS" && break; sleep 5; done
if ast "ari show apps" | grep -qw "$STASIS"; then
  ok "the voice engine is connected: calls from the police server go to the AI"
else
  note "the voice engine has not connected yet: docker logs $API --since 5m 2>&1 | grep -i ari | tail"
fi

say "Done."
cat <<TEXT
In AWS, this server's security group must allow, from $OFFICE_IP/32 only:
  - TCP 5061          (the police server's calls, SIP over TLS)
  - UDP 10000-10200   (call audio, SRTP)
Then on the police server: bash ~/Desktop/sip-bridge-setup.sh   (it ends with "the voice server answers, encrypted")
TEXT

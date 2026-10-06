#!/usr/bin/env bash
# The bridge between the department's SIP server and the AI on the voice engine (AWS):
#
#   SIP server (192.168.1.34) <-SIP + audio-> this server (Asterisk) <-ARI + audio WebSocket-> voice engine
#
# SIP and its audio stay on the office network. The voice engine controls each call through
# Asterisk's REST interface (ARI), over Tailscale, and gets only the call's audio, over an
# encrypted WebSocket that this server opens to it. Its replies come back the same way and
# Asterisk hands them to the SIP server. Run on the police server once the voice engine's server
# is on this server's Tailscale network (safe to run again; a run restarts Asterisk):
#
#   bash ~/Desktop/sip-bridge-setup.sh                               (port enp5s0, SIP server 192.168.1.34)
#   IFACE=enp5s0 SIP_SERVER=192.168.1.34 bash ~/Desktop/sip-bridge-setup.sh
#
#   1. Network: the government line's port, its address, the way to the SIP server, Tailscale.
#   2. The voice engine: an Asterisk connection on it; extension 1930 is answered by agent #18.
#   3. Asterisk 23 (Docker, this server's network), taking calls only from the SIP server.
#   4. Firewall: SIP and audio from the SIP server only; ARI on Tailscale only.
#   5. The home page's line status watches the port, the SIP server and Asterisk.
#   6. Checks: the SIP server answering Asterisk, and the voice engine connected to it.
set -euo pipefail
IFACE="${IFACE:-enp5s0}"
SIP_SERVER="${SIP_SERVER:-192.168.1.34}"
WORKFLOW="${WORKFLOW:-18}"
EXTEN=1930
ENVF=/etc/jenai/env
AST=/etc/jenai/asterisk
IMAGE=andrius/asterisk:23.4.1_debian-trixie
NAME=jenai-asterisk
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
ok() { printf "  \033[32mOK\033[0m  %s\n" "$*"; }
note() { printf "  \033[33mNOTE\033[0m  %s\n" "$*"; }
die() { printf "  \033[31mPROBLEM\033[0m  %s\n" "$*"; exit 1; }
setenv() { if sudo grep -q "^$1=" $ENVF; then sudo sed -i "s#^$1=.*#$1=$2#" $ENVF; else echo "$1=$2" | sudo tee -a $ENVF >/dev/null; fi; }
ast() { sudo docker exec $NAME asterisk -rx "$1" 2>/dev/null || true; }
sudo -v
sudo test -f $ENVF || die "JENAI is not installed on this server yet."
command -v docker >/dev/null || die "Docker is not installed: bash ~/Desktop/openwa-setup.sh installs it."
[[ "$SIP_SERVER" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "SIP_SERVER must be an IPv4 address, like 192.168.1.34."

say "1. The network"
[ -e "/sys/class/net/$IFACE" ] || die "There is no port $IFACE on this server. Its ports: $(ls /sys/class/net | tr '\n' ' ')"
[ "$(cat "/sys/class/net/$IFACE/carrier" 2>/dev/null || echo 0)" = 1 ] || die "No cable link on $IFACE: push the cable in at both ends, and check the other end is switched on."
PORT_IP=$(ip -4 -o addr show dev "$IFACE" | awk '{print $4}' | cut -d/ -f1 | head -1)
[ -n "$PORT_IP" ] || die "$IFACE has no network address yet."
ok "$IFACE is connected and has $PORT_IP"
ROUTE=$(ip -4 route get "$SIP_SERVER" 2>/dev/null || true)
VIA=$(echo "$ROUTE" | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1)
SRC=$(echo "$ROUTE" | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
[ -n "$SRC" ] || die "This server has no way to the SIP server $SIP_SERVER."
if [ "$VIA" = "$IFACE" ]; then
  ok "the SIP server $SIP_SERVER is reached through $IFACE"
else
  note "this server reaches $SIP_SERVER through $VIA ($SRC), not $IFACE (both ports are on the same address range); Asterisk uses $SRC. If calls do not arrive, send me: ip -4 -br addr; ip route"
fi
if ping -c 2 -W 1 "$SIP_SERVER" >/dev/null 2>&1; then ok "the SIP server answers on the network"; else note "the SIP server does not answer pings (it may block them); carrying on"; fi
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
[ -n "$TS_IP" ] || die "Tailscale is not running on this server."
ok "Tailscale address $TS_IP: the voice engine controls calls through it"
# The home page's line status watches this port and the SIP server from now on.
setenv JENAI_TEL_IFACE "$IFACE"
setenv JENAI_TEL_SIP_PEER "$SIP_SERVER"
sudo systemctl restart jenai-worker

say "2. The voice engine"
id jenaiast >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin jenaiast
sudo mkdir -p $AST
# The ARI password is made once and kept here (root and Asterisk only), never shown.
ARIPASS=$(sudo sed -n 's/^password *= *//p' "$AST/ari.conf" 2>/dev/null | head -1 || true)
[ -n "$ARIPASS" ] || ARIPASS=$(openssl rand -hex 24)
OUT=$(printf '%s' "$ARIPASS" | sudo -u jenai bash -c "set -a; . $ENVF; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /opt/jenai/app && pnpm --silent --filter @jenai/db sip-bridge --slug cy-police --workflow $WORKFLOW --ari http://$TS_IP:8088 --extension $EXTEN" 2>&1 || true)
STASIS=$(echo "$OUT" | sed -n 's/^stasis=//p' | head -1)
MEDIA=$(echo "$OUT" | sed -n 's/^media=//p' | head -1)
{ [ -n "$STASIS" ] && [ -n "$MEDIA" ]; } || die "The voice engine did not take the bridge: $(echo "$OUT" | tail -3)"
ok "the voice engine knows the bridge; extension $EXTEN is answered by agent #$WORKFLOW"

say "3. Asterisk"
w() { sudo tee "$AST/$1" >/dev/null; }
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
; The department's SIP server sends calls here; only calls from its address are taken.
[transport-udp]
type = transport
protocol = udp
bind = $SRC:5060

[gov]
type = endpoint
transport = transport-udp
context = from-gov
disallow = all
allow = ulaw,alaw
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
media_address = $SRC
dtmf_mode = rfc4733
aors = gov

[gov]
type = aor
contact = sip:$SIP_SERVER:5060
qualify_frequency = 60

[gov]
type = identify
endpoint = gov
match = $SIP_SERVER
CONF
w extensions.conf <<CONF
[general]
static = yes
writeprotect = yes

; Every call from the department's SIP server goes to the AI (extension $EXTEN on the voice engine).
[from-gov]
exten => _X.,1,NoOp(Government line: \${CALLERID(num)} called \${EXTEN})
 same => n,Goto(jenai-ai,$EXTEN,1)
exten => _+X.,1,Goto(from-gov,\${EXTEN:1},1)
exten => s,1,Goto(jenai-ai,$EXTEN,1)

[jenai-ai]
exten => $EXTEN,1,Stasis($STASIS)
 same => n,Hangup()
CONF
w ari.conf <<CONF
[general]
enabled = yes
pretty = no

[jenai]
type = user
read_only = no
password = $ARIPASS
CONF
w http.conf <<CONF
; ARI, for the voice engine only: on this server's Tailscale address, nowhere else.
[general]
enabled = yes
bindaddr = $TS_IP
bindport = 8088
CONF
w websocket_client.conf <<CONF
; Each call's audio goes to the voice engine over this encrypted WebSocket.
[dograh]
type = websocket_client
uri = $MEDIA
protocols = media
tls_enabled = yes
ca_list_file = /etc/ssl/certs/ca-certificates.crt
CONF
w rtp.conf <<'CONF'
[general]
rtpstart = 10000
rtpend = 10200
CONF
sudo chown -R jenaiast:jenaiast $AST && sudo chmod 750 $AST && sudo chmod 640 $AST/*
if sudo docker ps -a --format '{{.Names}}' | grep -qx $NAME; then
  echo "      restarting Asterisk with the settings above..."
  sudo docker restart $NAME >/dev/null
else
  echo "      starting Asterisk (the first download takes a minute)..."
  sudo docker pull -q $IMAGE >/dev/null
  sudo docker run -d --name $NAME --restart unless-stopped --network host \
    -e PUID="$(id -u jenaiast)" -e PGID="$(id -g jenaiast)" -e ASTERISK_TERMINAL_OPTS="-n" \
    -v $AST:/etc/asterisk \
    -v /etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro \
    --memory 1g --log-opt max-size=10m --log-opt max-file=3 \
    $IMAGE >/dev/null
fi
for _ in $(seq 1 30); do ast "core show version" | grep -q Asterisk && break; sleep 2; done
ast "core show version" | grep -q Asterisk || die "Asterisk did not start: sudo docker logs $NAME --tail 50"
ok "$(ast 'core show version' | head -1 | cut -c1-40) is running"
for mod in chan_websocket res_websocket_client res_ari res_pjsip; do
  ast "module show like $mod" | grep -q Running || die "Asterisk's $mod module is not running: sudo docker logs $NAME --tail 50"
done
ok "Asterisk's modules for the voice engine are running"

say "4. Firewall"
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow from "$SIP_SERVER" to any port 5060 proto udp >/dev/null
  sudo ufw allow from "$SIP_SERVER" to any port 10000:10200 proto udp >/dev/null
  sudo ufw allow from 100.64.0.0/10 to any port 8088 proto tcp >/dev/null
  ok "SIP and audio from $SIP_SERVER only; ARI from Tailscale only"
else
  note "no firewall is switched on here; Asterisk still takes calls only from $SIP_SERVER and serves ARI only on Tailscale"
fi

say "5. The home page's line status"
setenv JENAI_TEL_GATEWAY_HEALTH_URL "tcp://$TS_IP:8088"
sudo systemctl restart jenai-worker
ok "it checks $IFACE, the SIP server $SIP_SERVER and Asterisk every minute"

say "6. Checks"
sleep 3
ast "pjsip qualify gov" >/dev/null
sleep 3
if ast "pjsip show contacts" | grep -qw "Avail"; then ok "the SIP server $SIP_SERVER answers Asterisk"; else note "the SIP server $SIP_SERVER does not answer Asterisk yet: its IT adds the trunk below"; fi
echo "      waiting for the voice engine to connect (it looks every minute)..."
for _ in $(seq 1 24); do ast "ari show apps" | grep -q "$STASIS" && break; sleep 5; done
if ast "ari show apps" | grep -q "$STASIS"; then
  ok "the voice engine is connected to Asterisk"
else
  note "the voice engine has not connected yet: its server must be on this server's Tailscale network (tailscale status lists it). Wait a minute and run this again."
fi

say "Done."
cat <<TEXT
On the SIP server ($SIP_SERVER), the department's IT adds a trunk to this server:
  - a SIP trunk (peer, no registration) to $SRC, port 5060, UDP: this server trusts $SIP_SERVER by its address
  - codecs G.711: PCMU (u-law) and PCMA (a-law)
  - the helpline's calls routed to this trunk; whatever number is sent, the AI answers
Then a call to the helpline is answered by the AI, carries on WhatsApp as now, and shows under Calls.
TEXT

#!/usr/bin/env bash
# The government telephone line to the AI, with no VPN. The department's SIP server sends the
# helpline's calls to this server; Asterisk here passes each call on to the cloud voice server
# over the internet, encrypted (SIP over TLS, audio over SRTP), and the AI's voice comes back
# the same way:
#
#   SIP server (192.168.1.34) <-SIP + audio, office network-> this server (Asterisk)
#     <-SIP over TLS + SRTP audio, internet-> voice server (Asterisk <-> voice engine, agent #18)
#
# Nothing here listens to the internet: this server opens the connection to the voice server.
# Run on the police server (safe to run again; a run restarts Asterisk), then the command it
# prints on the voice server:
#
#   bash ~/Desktop/sip-bridge-setup.sh                               (port enp5s0, SIP server 192.168.1.34)
#   IFACE=enp5s0 SIP_SERVER=192.168.1.34 UCM_EXT=1007 bash ~/Desktop/sip-bridge-setup.sh
#
# Asterisk signs in to the SIP server as the extension made for JENAI (1007 on the UCM6308,
# a member of the helpline queue): its password is asked once, hidden, and kept here (root only).
# Calls to that extension, or sent to this server by a peer trunk, are answered by the AI.
#
#   1. Network: the government line's port, its address, the way to the SIP server, the internet.
#   2. The voice engine: the voice server's Asterisk as a connection on it; extension 1930 is
#      answered by agent #18.
#   3. Asterisk 23 (Docker, this server's network): calls from the SIP server only, on to the
#      voice server only.
#   4. Firewall: SIP and audio from the SIP server only.
#   5. The home page's line status watches the port, the SIP server, Asterisk and the voice server.
#   6. Checks, and what to set up on the voice server and the SIP server.
set -euo pipefail
IFACE="${IFACE:-enp5s0}"
SIP_SERVER="${SIP_SERVER:-192.168.1.34}"
WORKFLOW="${WORKFLOW:-18}"
VOICE_HOST="${VOICE_HOST:-voice.jenai.in}"
# Asterisk's REST interface on the voice server, as the voice engine there reaches it (Docker's
# address for the server itself). sip-gateway-setup.sh on the voice server serves it there.
ARI_URL="${ARI_URL:-http://172.17.0.1:8088}"
UCM_EXT="${UCM_EXT:-1007}"
EXTEN=1930
ENVF=/etc/jenai/env
AST=/etc/jenai/asterisk
SECRET=/etc/jenai/sip-bridge.secret
UCM_SECRET=/etc/jenai/sip-extension.secret
STATUS=/var/lib/jenai/line-status
IMAGE=andrius/asterisk:23.4.1_debian-trixie
NAME=jenai-asterisk
GATEWAY_SCRIPT=https://raw.githubusercontent.com/sainathsv/diigoo-voice-agent/main/deploy/voice/sip-gateway-setup.sh
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
[[ "$VOICE_HOST" =~ ^[A-Za-z0-9.-]+$ ]] || die "VOICE_HOST must be a host name, like voice.jenai.in."
[[ "$ARI_URL" =~ ^http://[0-9.]+:[0-9]+$ ]] || die "ARI_URL must look like http://172.17.0.1:8088."
[[ "$UCM_EXT" =~ ^[0-9A-Za-z]+$ ]] || die "UCM_EXT must be the extension number, like 1007."

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
  note "this server reaches $SIP_SERVER through $VIA ($SRC), not $IFACE; Asterisk uses $SRC. If calls do not arrive, send me: ip -4 -br addr; ip route"
fi
if ping -c 2 -W 1 "$SIP_SERVER" >/dev/null 2>&1; then ok "the SIP server answers on the network"; else note "the SIP server does not answer pings (it may block them); carrying on"; fi
PUBLIC_IP=$(curl -fsS --max-time 8 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
[[ "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "This server cannot reach the internet: it could not find this office's internet address."
ok "this office's internet address is $PUBLIC_IP: the voice server takes calls from it only"
VOICE_IP=$(getent ahostsv4 "$VOICE_HOST" | awk '{print $1; exit}' || true)
[ -n "$VOICE_IP" ] || die "This server cannot look up $VOICE_HOST."
ok "the voice server $VOICE_HOST is at $VOICE_IP"
# The home page's line status watches this port and the SIP server from now on.
setenv JENAI_TEL_IFACE "$IFACE"
setenv JENAI_TEL_SIP_PEER "$SIP_SERVER"
sudo systemctl restart jenai-worker

# The SIP server's extension for JENAI: its password, asked once (hidden) and kept here, root only.
UCM_PASS=$(sudo cat $UCM_SECRET 2>/dev/null || true)
if [ -z "$UCM_PASS" ] && [ -t 0 ] || [ -z "$UCM_PASS" ] && [ -e /dev/tty ]; then
  printf "\n  Password of extension %s on the SIP server (UCM: Extension/Trunk > Extensions > %s > edit > SIP/IAX Password).\n  It is not shown while you type; press Enter alone to skip signing in: " "$UCM_EXT" "$UCM_EXT"
  read -rs UCM_PASS </dev/tty || true
  echo
fi
case "$UCM_PASS" in *[[:space:]]*) die "The extension's password has a space in it: give it a password without spaces on the SIP server, then run this again." ;; esac
if [ -n "$UCM_PASS" ]; then
  printf '%s\n' "$UCM_PASS" | sudo sh -c "umask 077; cat > $UCM_SECRET"
  ok "Asterisk signs in to $SIP_SERVER as extension $UCM_EXT"
else
  note "not signing in as an extension: the SIP server must send calls by a peer trunk to $SRC"
fi

say "2. The voice engine"
id jenaiast >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin jenaiast
sudo mkdir -p $AST/keys
# The password the voice engine signs in to the voice server's Asterisk with: made once, kept
# here (root only) and on the voice engine, never shown. The voice server's setup reads it from
# the voice engine. A password kept by an earlier version of this bridge is used again.
ARIPASS=$(sudo cat $SECRET 2>/dev/null || true)
[ -n "$ARIPASS" ] || ARIPASS=$(sudo sed -n 's/^password *= *//p' "$AST/ari.conf" 2>/dev/null | head -1 || true)
[ -n "$ARIPASS" ] || ARIPASS=$(openssl rand -hex 24)
printf '%s\n' "$ARIPASS" | sudo sh -c "umask 077; cat > $SECRET"
OUT=$(printf '%s' "$ARIPASS" | sudo -u jenai bash -c "set -a; . $ENVF; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /opt/jenai/app && pnpm --silent --filter @jenai/db sip-bridge --slug cy-police --workflow $WORKFLOW --ari $ARI_URL --extension $EXTEN" 2>&1 || true)
STASIS=$(echo "$OUT" | sed -n 's/^stasis=//p' | head -1)
WHY=$(echo "$OUT" | sed -n 's/^error=//p' | head -1)
[ -n "$WHY" ] || WHY=$(echo "$OUT" | grep -m1 -E '^(Error|[A-Za-z]*Error):' || echo "$OUT" | grep -v '^ *at ' | tail -2)
[ -n "$STASIS" ] || die "The voice engine did not take the bridge: $WHY"
ok "the voice engine knows the bridge; extension $EXTEN is answered by agent #$WORKFLOW"

say "3. Asterisk"
w() { sudo tee "$AST/$1" >/dev/null; }
# The voice server serves ARI and the audio WebSocket now, not this server.
sudo rm -f $AST/ari.conf $AST/websocket_client.conf
# This server's own certificate for its end of the encrypted connection (the voice server does
# not check it: it takes calls from this office's internet address only).
if ! sudo test -s $AST/keys/bridge.key; then
  sudo openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=jenai-police-bridge" \
    -keyout $AST/keys/bridge.key -out $AST/keys/bridge.crt >/dev/null 2>&1 || die "Could not make this server's certificate (openssl)."
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
# Signed in to the SIP server as extension $UCM_EXT: calls to it, and from the helpline queue, come here.
REG_BLOCK=""
STATUS_USER=""
if [ -n "$UCM_PASS" ]; then
  STATUS_USER=$UCM_EXT
  REG_BLOCK=$(printf '%s\n' "" \
    "; Signed in to the SIP server as extension $UCM_EXT: calls to it, and from the helpline queue, come here." \
    "[gov-reg]" "type = registration" "transport = transport-udp" "outbound_auth = gov-auth" \
    "server_uri = sip:$SIP_SERVER" "client_uri = sip:$UCM_EXT@$SIP_SERVER" "contact_user = $UCM_EXT" \
    "expiration = 300" "retry_interval = 20" "forbidden_retry_interval = 60" "fatal_retry_interval = 60" \
    "auth_rejection_permanent = no" "max_retries = 1000000" "" \
    "[gov-auth]" "type = auth" "auth_type = userpass" "username = $UCM_EXT" "password = ${UCM_PASS//;/\\;}")
fi
w pjsip.conf <<CONF
; Calls come from the department's SIP server (office network, UDP) and go on to the voice
; server (internet, TLS with SRTP audio). Nothing else is accepted.
[transport-udp]
type = transport
protocol = udp
bind = $SRC:5060

[transport-tls]
type = transport
protocol = tls
bind = 0.0.0.0:5061
cert_file = /etc/asterisk/keys/bridge.crt
priv_key_file = /etc/asterisk/keys/bridge.key
; The voice server must show a valid certificate for $VOICE_HOST.
ca_list_file = /etc/ssl/certs/ca-certificates.crt
verify_server = yes
method = tlsv1_2

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
$REG_BLOCK

[voice]
type = endpoint
transport = transport-tls
context = from-voice
disallow = all
allow = ulaw,alaw
media_encryption = sdes
direct_media = no
rtp_symmetric = yes
; Audio leaves this side at once, so the voice server finds its way back through the office's router.
rtp_keepalive = 1
dtmf_mode = rfc4733
aors = voice

[voice]
type = aor
contact = sip:$VOICE_HOST:5061;transport=tls
qualify_frequency = 60
CONF
w extensions.conf <<CONF
[general]
static = yes
writeprotect = yes

; Every call from the department's SIP server goes to the AI, through the voice server.
[from-gov]
exten => _X.,1,NoOp(Government line: \${CALLERID(num)} called \${EXTEN})
 same => n,Goto(to-ai,s,1)
exten => _+X.,1,Goto(from-gov,\${EXTEN:1},1)
exten => s,1,Goto(to-ai,s,1)

[to-ai]
exten => s,1,Dial(PJSIP/$EXTEN@voice,30)
 same => n,Hangup()

; Nothing calls in from the voice server.
[from-voice]
exten => _[0-9a-zA-Z+*#].,1,Hangup()
exten => s,1,Hangup()
CONF
w http.conf <<'CONF'
; No web interface here: the voice server has the one the voice engine uses.
[general]
enabled = no
CONF
w rtp.conf <<'CONF'
[general]
rtpstart = 10000
rtpend = 10200
CONF
sudo chown -R jenaiast:jenaiast $AST
sudo find $AST -type d -exec chmod 750 {} +
sudo find $AST -type f -exec chmod 640 {} +
sudo chmod 600 $AST/keys/bridge.key
# The home page reads the line as Asterisk sees it from this file, written every minute (no secrets in it).
sudo mkdir -p /var/lib/jenai && sudo chmod 755 /var/lib/jenai
sudo tee /usr/local/sbin/jenai-line-status >/dev/null <<SCRIPT
#!/bin/sh
# The government line as this server's Asterisk sees it, for the home page (sip-bridge-setup.sh).
A="docker exec $NAME asterisk -rx"
up=down; \$A "core show version" 2>/dev/null | grep -q Asterisk && up=up
reg=\$(\$A "pjsip show registrations" 2>/dev/null | awk '\$1 ~ /^gov-reg\// {print \$3; exit}')
contacts=\$(\$A "pjsip show contacts" 2>/dev/null)
gov=\$(echo "\$contacts" | awk '\$2 ~ /^gov\// {print \$4; exit}')
voice=\$(echo "\$contacts" | awk '\$2 ~ /^voice\// {print \$4; exit}')
{ echo "at=\$(date +%s)"; echo "asterisk=\$up"; [ -n "$STATUS_USER" ] && echo "user=$STATUS_USER"; echo "register=\$reg"; echo "gov=\$gov"; echo "voice=\$voice"; } > $STATUS.tmp && chmod 644 $STATUS.tmp && mv $STATUS.tmp $STATUS
SCRIPT
sudo chmod 755 /usr/local/sbin/jenai-line-status
echo "* * * * * root /usr/local/sbin/jenai-line-status" | sudo tee /etc/cron.d/jenai-line-status >/dev/null
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
for mod in res_pjsip chan_pjsip res_srtp; do
  ast "module show like $mod" | grep -q Running || die "Asterisk's $mod module is not running: sudo docker logs $NAME --tail 50"
done
ast "pjsip show transports" | grep -q transport-tls || die "Asterisk's encrypted connection (TLS) did not start: sudo docker logs $NAME --tail 50"
ok "Asterisk takes calls from $SIP_SERVER and sends them on encrypted (TLS, SRTP)"

say "4. Firewall"
if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow from "$SIP_SERVER" to any port 5060 proto udp >/dev/null
  sudo ufw allow from "$SIP_SERVER" to any port 10000:10200 proto udp >/dev/null
  sudo ufw delete allow from 100.64.0.0/10 to any port 8088 proto tcp >/dev/null 2>&1 || true
  ok "SIP and audio from $SIP_SERVER only; nothing open to the internet"
else
  note "no firewall is switched on here; Asterisk still takes calls only from $SIP_SERVER"
fi

say "5. The home page's line status"
setenv JENAI_TEL_GATEWAY_HEALTH_URL "tls://127.0.0.1:5061,tls://$VOICE_HOST:5061"
setenv JENAI_TEL_ASTERISK_STATUS "$STATUS"
sudo systemctl restart jenai-worker
ok "it checks $IFACE, the SIP server $SIP_SERVER, Asterisk here and the voice server every minute"

say "6. Checks"
sleep 3
ast "pjsip qualify gov" >/dev/null
ast "pjsip qualify voice" >/dev/null
[ -n "$UCM_PASS" ] && ast "pjsip send register gov-reg" >/dev/null
sleep 6
sudo /usr/local/sbin/jenai-line-status || true
CONTACTS=$(ast "pjsip show contacts")
SIGNED=0
if [ -n "$UCM_PASS" ]; then
  REG=$(ast "pjsip show registrations" | awk '$1 ~ /^gov-reg\// {print $3; exit}')
  if [ "$REG" = Registered ]; then
    SIGNED=1
    ok "extension $UCM_EXT is signed in to $SIP_SERVER: its calls come to the AI"
  else
    note "extension $UCM_EXT is not signed in to $SIP_SERVER (${REG:-no answer}): check its password on the UCM, then run this again (sudo rm $UCM_SECRET first to be asked again)"
  fi
fi
if echo "$CONTACTS" | grep "gov/" | grep -qw Avail; then
  ok "the SIP server $SIP_SERVER answers Asterisk"
elif [ $SIGNED = 0 ]; then
  note "the SIP server $SIP_SERVER does not answer Asterisk: on it, allow $SRC (its SIP security and Fail2ban whitelists)"
fi
if sudo ss -ulpn 2>/dev/null | grep -q ":5062 "; then
  note "something else on this server uses port 5062 (an older sign-in as $UCM_EXT?): $(sudo ss -ulpn | grep ':5062 ' | sed 's/.*users:((\"\([^\"]*\)\".*/\1/' | head -1)"
fi
VOICE_OK=0
if echo "$CONTACTS" | grep "voice/" | grep -qw Avail; then
  VOICE_OK=1
  ok "the voice server answers, encrypted"
else
  note "the voice server does not answer yet: set it up as below, then run this again"
fi

say "Done."
if [ $VOICE_OK = 0 ]; then
  cat <<TEXT
On the voice server ($VOICE_HOST, $VOICE_IP), once:
  1. In AWS, its security group: allow TCP 5061 and UDP 10000-10200 from $PUBLIC_IP/32 only.
  2. On the voice server, run:
     curl -fsSL $GATEWAY_SCRIPT | sudo bash -s -- $PUBLIC_IP

TEXT
fi
if [ $SIGNED = 1 ]; then
  cat <<TEXT
Test: from any office phone, dial $UCM_EXT. The AI answers, WhatsApp follows, and the call shows under Calls.
For every helpline call to reach the AI, on the UCM send the helpline's inbound route to extension $UCM_EXT
(in queue 6500 it is rung only after the members before it).
TEXT
else
cat <<TEXT
On the SIP server ($SIP_SERVER), a trunk to this server:
  - a SIP peer trunk (no registration) to $SRC, port 5060, UDP: this server trusts $SIP_SERVER by its address
  - codecs G.711: PCMU (u-law) and PCMA (a-law); keep the caller's own number (caller ID)
  - calls routed to this trunk; whatever number is sent, the AI answers
Then a call sent to the trunk is answered by the AI, carries on WhatsApp as now, and shows under Calls.
TEXT
fi

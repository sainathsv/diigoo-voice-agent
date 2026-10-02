#!/usr/bin/env bash
# Run on the office server to bring JENAI up to date. Needs on the Desktop:
#   diigoo-voice-agent.tar.gz, setup-fusionstor.sh   (always)
#
#   bash ~/Desktop/office-update.sh             (add "reanalyze" to read every call with the AI again)
#
# Keeps the database, passwords, settings (police edition included), CY Police and the Dograh
# connection. Then re-reads recent calls so their transcripts and recordings are filled in.
set -euo pipefail
D="$HOME/Desktop"
ENVF=/etc/jenai/env
say() { printf "\n\033[1m%s\033[0m\n" "$*"; }
[ -f "$D/diigoo-voice-agent.tar.gz" ] && [ -f "$D/setup-fusionstor.sh" ] || { echo "Copy diigoo-voice-agent.tar.gz and setup-fusionstor.sh to the Desktop first."; exit 1; }
sudo -v

say "A. New code"
cd "$HOME" && rm -rf diigoo-voice-agent && tar -xzf "$D/diigoo-voice-agent.tar.gz"
echo "version: $(cat "$HOME/diigoo-voice-agent/VERSION" 2>/dev/null || echo unknown)"
bash "$D/setup-fusionstor.sh"

say "B. Re-reading CY Police calls"
EXTRA=""
[ "${1:-}" = "reanalyze" ] && sudo grep -q '^JENAI_ANALYZE=true' $ENVF && EXTRA="--reanalyze"
sudo -u jenai bash -c "set -a; . $ENVF; set +a; export COREPACK_ENABLE_DOWNLOAD_PROMPT=0; cd /opt/jenai/app && pnpm --silent --filter @jenai/db voice --slug cy-police --sync-only --refetch $EXTRA"

say "Done."
echo "Running version: $(curl -sk https://127.0.0.1/api/version)"
echo "If it says 'transcript(s) could not be downloaded', the office address is not yet allowed on Dograh."

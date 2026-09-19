#!/usr/bin/env bash
# Signs in as each seeded role over HTTP and checks which pages each may open.
# Requires: pnpm dev running on :3100, seeded database. Uses SEED_PASSWORD from .env.
set -uo pipefail
cd "$(dirname "$0")/.."
P=$(grep '^SEED_PASSWORD=' .env | cut -d= -f2-)
BASE=${BASE:-http://localhost:3100}
email () { case $1 in owner) echo owner@zennara.test;; fd) echo frontdesk@zennara.test;; mkt) echo marketing@zennara.test;; mgr) echo manager@zennara.test;; con) echo consultant@jenai.test;; sup) echo support@diigoo.test;; lbr) echo owner@lbr.test;; founder) echo founder@diigoo.test;; esac; }
i=$((RANDOM % 200))
for r in owner fd mkt mgr con sup lbr founder; do
  i=$((i+1))
  # Each test login gets its own simulated client IP (the edge proxy sets this header in production).
  curl -s -o /dev/null -c "/tmp/jenai-jar-$r" -H "x-jenai-client-ip: 10.200.0.$i" -H "Content-Type: application/json" -H "Origin: $BASE" \
    -X POST "$BASE/api/auth/sign-in/email" -d "{\"email\":\"$(email $r)\",\"password\":\"$P\"}"
done
fail=0
expect () { # role path expected-code
  got=$(curl -s -o /dev/null -w "%{http_code}" -b "/tmp/jenai-jar-$1" "$BASE$2")
  if [ "$got" = "$3" ]; then printf "ok   %-8s %-26s %s\n" "$1" "$2" "$got"; else printf "FAIL %-8s %-26s got %s want %s\n" "$1" "$2" "$got" "$3"; fail=1; fi
}
expect owner /w/zennara 200;          expect owner /w/zennara/settings 200; expect owner /w/lbr-dental 404
expect fd /w/zennara 200;             expect fd /w/zennara/team 404;        expect fd /w/zennara/activity 404
expect mkt /w/zennara/team 404;       expect mgr /w/zennara/team 200;       expect mgr /w/zennara/settings 404
expect con /w/lbr-dental 200;         expect con /w/ghmc 404
expect sup /w/zennara 404;            expect sup /console 200;              expect sup /console/staff 307
expect lbr /w/zennara 404;            expect founder /console/staff 200;    expect founder /console/activity 200
# Module pages (block 2)
for p in calls leads campaigns campaigns/new agents numbers plan; do expect owner /w/zennara/$p 200; done
expect fd /w/zennara/calls 200;       expect fd /w/zennara/leads 200;       expect fd /w/zennara/campaigns 404
expect fd /w/zennara/plan 404;        expect mkt /w/zennara/campaigns 200;  expect mkt /w/zennara/campaigns/new 200
expect mkt /w/zennara/numbers 404;    expect mgr /w/zennara/agents 200;     expect con /w/zennara/calls 200
expect con /w/zennara/campaigns/new 404
expect founder /console/plans 200;    expect sup /console/plans 307
exit $fail

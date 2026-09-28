#!/usr/bin/env bash
# Runs every saga scenario against a running system (npm run start:all).
set -euo pipefail
API=${API:-http://localhost:3000}

run() {
  local title=$1 body=$2
  echo
  echo "━━━ $title"
  echo "    POST /shipments $body"
  curl -s -X POST "$API/shipments" -H 'content-type: application/json' -d "$body" | node -e '
    let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
      const d = JSON.parse(s);
      if (!d.timeline) return console.log(d);
      console.log(`    status: ${d.status}${d.failureReason ? "  (" + d.failureReason + ")" : ""}`);
      d.timeline.forEach(t => console.log("      " + t));
      console.log(`    details: GET /shipments/${d.id}  |  GET /shipments/${d.id}/participants`);
    });'
}

run "1. Happy path: 2x40HC Shanghai -> Rotterdam -> Duisburg" '{}'
run "2. Customs rejects weapons (fails at step 2)"            '{"hsCode":"930100","cargoDescription":"Hunting rifles"}'
run "3. Not enough trucks (fails at step 3)"                  '{"containers":6}'
run "4. No warehouse in Berlin (fails at step 4)"             '{"finalDestinationCity":"Berlin"}'
run "5. Customer credit limit (fails at the pivot, step 5)"  '{"customerId":"tiny-traders"}'
run "6. Timeout: trucking commits but replies too late"      '{"simulate":{"slowReplyAt":"trucking"}}'
run "7. Flaky compensation: customs undo fails twice"        '{"simulate":{"failAt":"billing","flakyCompensationAt":"customs"}}'

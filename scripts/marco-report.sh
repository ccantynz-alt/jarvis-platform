#!/usr/bin/env bash
# marco-report.sh — any agent mirrors one event into the Marco flywheel.
# Usage: marco-report.sh <agent> <platform> <ok|fixed|failed|blocked|noop> "<action>" ["<detail>"] ["tag1,tag2"]
# Never fails the caller: Marco being down must not break the work being reported.
set -uo pipefail
if [ $# -lt 4 ]; then
  echo "usage: marco-report.sh <agent> <platform> <outcome> \"action\" [\"detail\"] [\"tags\"]" >&2
  exit 64
fi
TOKEN=$(grep -m1 '^MARCO_INGEST_TOKEN=' /opt/jarvis/config/secrets.env 2>/dev/null | cut -d= -f2- || true)
jq -n --arg agent "$1" --arg platform "$2" --arg outcome "$3" --arg action "$4" \
      --arg detail "${5:-}" --arg tags "${6:-}" \
      '{agent:$agent, platform:$platform, outcome:$outcome, action:$action, detail:$detail, tags:$tags}' \
| curl -s -m 5 -X POST http://127.0.0.1:9200/marco/event \
    -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
    --data-binary @- || true
echo

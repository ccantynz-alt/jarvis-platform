#!/usr/bin/env bash
# fleet-check.sh — on-box fleet health probe.
# Probes every platform's public URL and writes status into Jarvis memory
# (so the dashboard shows it and any agent/session can READ it). Runs on a
# systemd timer. The off-box watcher stays as a dead-man's-switch for "is the
# box itself alive"; everything readable lives here, on Jarvis.
set -uo pipefail

MEM="http://127.0.0.1:9200/memory/platform/update"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# platform|probe-url|expected  (expected=no means known-not-deployed, won't flag red)
FLEET="
zoobicon|https://zoobicon.com|yes
vapron|https://vapron.ai|yes
gluecron|https://gluecron.com|yes
alecrae|https://alecrae.com|yes
marcoreid|https://www.marcoreid.com|yes
davenroe|https://www.davenroe.com|yes
bookaride|https://bookaride.com|yes
voxlen|https://voxlen.com|yes
gatetest|https://mcp.gatetest.ai/healthz|yes
"

summary=""
while IFS='|' read -r name url expected; do
  [ -z "$name" ] && continue
  code=$(curl -s -L -o /dev/null -w '%{http_code}' --max-time 12 "$url" 2>/dev/null)
  case "$code" in
    2*|3*) status="healthy"; score=95 ;;
    *)     status="error";   score=0  ;;
  esac
  note="fleet-check $TS: $url -> HTTP ${code:-000}"
  curl -s -X POST "$MEM" -H 'Content-Type: application/json' \
    -d "{\"platform\":\"$name\",\"status\":\"$status\",\"health_score\":$score,\"notes\":\"$note\"}" \
    -o /dev/null 2>/dev/null
  summary="$summary $name=${code:-000}"
done <<< "$FLEET"

echo "[fleet-check] $TS |$summary"

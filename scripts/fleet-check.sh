#!/usr/bin/env bash
# fleet-check.sh — on-box fleet health probe.
# Probes every platform's public URL and writes status into Jarvis memory
# (so the dashboard shows it and any agent/session can READ it). Runs on a
# systemd timer. The off-box watcher stays as a dead-man's-switch for "is the
# box itself alive"; everything readable lives here, on Jarvis.
set -uo pipefail

MEM="http://127.0.0.1:9200/memory/platform/update"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# A single failed probe is usually a transient flap (a slow site, a blip), not a
# real outage — and self-heal keys off status=error. Only report "error" after
# TWO consecutive failures. State lives in a tiny per-platform strike counter.
STATE_DIR="/var/lib/jarvis/fleet-check"
mkdir -p "$STATE_DIR"
STRIKES_TO_FAIL=2

# platform|probe-url   — probes the platform's REAL public presence (the site
# the owner cares about), so dashboard numbers match reality.
FLEET="
jarvis|http://127.0.0.1:9206/health
zoobicon|https://zoobicon.com
vapron|https://vapron.ai
gluecron|https://gluecron.com
alecrae|https://alecrae.com
marcoreid|https://www.marcoreid.com
davenroe|https://www.davenroe.com
bookaride|https://www.bookaride.co.nz
voxlen|https://voxlen.com
gatetest|https://gatetest.ai
gatetest-mcp|https://mcp.gatetest.ai/healthz
"

summary=""
while IFS='|' read -r name url expected; do
  [ -z "$name" ] && continue
  code=$(curl -s -L -o /dev/null -w '%{http_code}' --max-time 12 "$url" 2>/dev/null)
  strike_file="$STATE_DIR/${name}.strikes"
  case "$code" in
    2*|3*)
      status="healthy"; score=95
      rm -f "$strike_file"                       # recovered — clear strikes
      ;;
    *)
      strikes=$(( $(cat "$strike_file" 2>/dev/null || echo 0) + 1 ))
      echo "$strikes" > "$strike_file"
      if [ "$strikes" -ge "$STRIKES_TO_FAIL" ]; then
        status="error"; score=0                  # confirmed down (2+ in a row)
      else
        status="working"; score=60               # first miss — flag, don't fail
      fi
      ;;
  esac
  note="fleet-check $TS: $url -> HTTP ${code:-000}"
  curl -s -X POST "$MEM" -H 'Content-Type: application/json' \
    -d "{\"platform\":\"$name\",\"status\":\"$status\",\"health_score\":$score,\"notes\":\"$note\"}" \
    -o /dev/null 2>/dev/null
  summary="$summary $name=${code:-000}"
done <<< "$FLEET"

echo "[fleet-check] $TS |$summary"

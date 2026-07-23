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

# Loop/flap detection (2026-07-20, Craig's "scan for loops" ask): a platform
# that keeps oscillating healthy<->error is a DIFFERENT problem than one that's
# just down (crash-restart loop, flapping upstream dependency, etc.) — worth
# surfacing separately even while individual checks look "fine" on their own.
# Keeps the last FLAP_HISTORY statuses per platform; flags when more than
# FLAP_THRESHOLD distinct up/down transitions happened in that window.
FLAP_HISTORY=8
FLAP_THRESHOLD=3

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
voxlen|https://www.voxlen.ai
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
  # Flap history: append this check's up/down verdict, keep only the last
  # FLAP_HISTORY entries, count transitions between them.
  flap_file="$STATE_DIR/${name}.flaphist"
  updown="up"; [ "$status" = "error" ] && updown="down"
  hist="$( { [ -f "$flap_file" ] && cat "$flap_file"; echo "$updown"; } | tail -n "$FLAP_HISTORY")"
  echo "$hist" > "$flap_file"
  transitions=0
  prev=""
  while IFS= read -r h; do
    [ -n "$prev" ] && [ "$prev" != "$h" ] && transitions=$((transitions + 1))
    prev="$h"
  done <<< "$hist"
  note="fleet-check $TS: $url -> HTTP ${code:-000}"
  if [ "$transitions" -ge "$FLAP_THRESHOLD" ]; then
    note="$note | FLAPPING: $transitions transitions in last $FLAP_HISTORY checks"
  fi
  curl -s -X POST "$MEM" -H 'Content-Type: application/json' \
    -d "{\"platform\":\"$name\",\"status\":\"$status\",\"health_score\":$score,\"notes\":\"$note\"}" \
    -o /dev/null 2>/dev/null
  summary="$summary $name=${code:-000}"
done <<< "$FLEET"

echo "[fleet-check] $TS |$summary"

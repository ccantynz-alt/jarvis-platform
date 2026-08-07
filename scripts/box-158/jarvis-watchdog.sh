#!/usr/bin/env bash
# jarvis-watchdog.sh — box 158 watches the master Jarvis box (2026-08-08).
#
# THE off-box watcher (CLAUDE.md KNOWN DEBT #1's "better watcher"): always on,
# 5-minute timer, tailnet + public probes, no GitHub throttling. Standalone by
# estate doctrine — no Jarvis code on 158, same pattern as jarvis-heartbeat.sh.
#
# Probes the master's public liveness ping (:9212, the one route that exists
# for exactly this) on BOTH paths: the public IP (whole-box-or-network down)
# and the tailnet IP (box up even when its public side is broken). Three
# spaced attempts per path per run — one blip must not page anyone.
#
# Alerts via ntfy (topic in /root/.jarvis-watchdog.env, chmod 600 — the topic
# name IS the credential). Alert on the DOWN transition, re-alert every 6h
# while down, and announce recovery — never one alert per 5-minute tick.

set -u
ENV_FILE=/root/.jarvis-watchdog.env
STATE=/root/.jarvis-watchdog-state
LOG=/var/log/jarvis-watchdog.log
PUBLIC_URL="http://66.42.121.161:9212/health"
TAILNET_URL="http://100.109.131.122:9212/health"
REALERT_S=$((6 * 3600))

[ -f "$ENV_FILE" ] && . "$ENV_FILE"
log() { echo "[$(date -u +%FT%TZ)] $*" >> "$LOG"; }

probe() { # url → 0 if any of 3 spaced attempts returns HTTP 200
  local url=$1 i
  for i in 1 2 3; do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url")" = "200" ] && return 0
    [ "$i" -lt 3 ] && sleep 15
  done
  return 1
}

push() { # title, body, priority
  [ -z "${NTFY_TOPIC:-}" ] && { log "no NTFY_TOPIC — cannot push: $1"; return 1; }
  curl -s --max-time 15 -H "Title: $1" -H "Priority: $3" -H "Tags: rotating_light" \
    -d "$2" "https://ntfy.sh/${NTFY_TOPIC}" > /dev/null
}

pub_ok=0; tail_ok=0
probe "$PUBLIC_URL" && pub_ok=1
probe "$TAILNET_URL" && tail_ok=1

now=$(date +%s)
prev_status="up"; prev_alert=0
[ -f "$STATE" ] && . "$STATE"

if [ "$pub_ok" = "1" ] || [ "$tail_ok" = "1" ]; then
  status="up"
  detail="public=$pub_ok tailnet=$tail_ok"
  if [ "$prev_status" = "down" ]; then
    push "Jarvis master box RECOVERED" "The master box is answering again ($detail). Down since the last alert." "high"
    log "RECOVERED ($detail)"
  fi
  # Degraded-but-up is worth one log line, not a page: self-heal and metrics on
  # the box itself own partial failures. This watcher owns "the box is gone".
  [ "$pub_ok" != "1" ] || [ "$tail_ok" != "1" ] && log "degraded: $detail"
  echo "prev_status=up; prev_alert=0" > "$STATE"
else
  status="down"
  if [ "$prev_status" = "up" ] || [ $((now - prev_alert)) -ge $REALERT_S ]; then
    push "JARVIS MASTER BOX DOWN" "Both paths dead from box 158: public 66.42.121.161:9212 AND tailnet 100.109.131.122:9212 — 3 spaced probes each. The box or its network is gone." "max"
    log "DOWN — alert pushed"
    echo "prev_status=down; prev_alert=$now" > "$STATE"
  else
    log "still down — within re-alert window"
    echo "prev_status=down; prev_alert=$prev_alert" > "$STATE"
  fi
fi

# Manual end-to-end test: jarvis-watchdog.sh --test-alert pushes a max-priority
# test message so a human can confirm a DEVICE actually buzzes (the KNOWN DEBT
# rule: "the code exists" is not delivery).
if [ "${1:-}" = "--test-alert" ]; then
  push "Jarvis watchdog TEST" "Test alert from box 158's watchdog. If you can read this on a device, the channel is proven end-to-end." "max" \
    && log "test alert pushed" || log "test alert FAILED"
fi

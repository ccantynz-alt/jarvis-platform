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
#
# Derived from THE registry, config/platforms.json, never from a list kept here
# (2026-08-28). The list that used to live at this spot had drifted from the
# registry three ways at once — most sharply, marco-demo was registered at
# birth on 2026-08-25 and never probed once, its platform_state row still
# reading `unknown / health 0` three days later while CLAUDE.md claimed the
# fleet watches the newborn. Registered and watched are one word now. Rules,
# tests and the incidents: src/lib/fleet-targets.js, test/fleet-targets.test.js.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLEET_ERR="$(mktemp)"
FLEET="$(node "$ROOT/src/lib/fleet-targets.js" 2>"$FLEET_ERR")"
FLEET_RC=$?
FLEET_WHY="$(tr '\n"' ' ' < "$FLEET_ERR")"; rm -f "$FLEET_ERR"

# An empty target list must SHOUT, never coast. fleet-check is the only thing
# that notices a platform is down and self-heal acts solely on the status it
# writes, so probing nothing looks exactly like a fleet that is perfectly well:
# every row simply stops being updated, and an absence cannot alarm. Bail
# before the loop and file it — level `warn`, whose 10-minute dedup window
# matches this timer's cadence, because `alert` is exempt from dedup and would
# buzz Craig's phone 144 times a day over a config he must fix by hand anyway
# (LESSONS: the 235-push flood, 2026-08-10).
if [ "$FLEET_RC" -ne 0 ] || [ -z "$FLEET" ]; then
  echo "[fleet-check] $TS FATAL: no probe targets — $FLEET_WHY" >&2
  curl -s -X POST http://127.0.0.1:9200/memory/notifications \
    -H 'Content-Type: application/json' --max-time 10 \
    -d "{\"source\":\"fleet-check\",\"level\":\"warn\",\"title\":\"Fleet check has no platforms to probe\",\"body\":\"config/platforms.json yielded no probeable platform (rc=$FLEET_RC). NOTHING in the fleet is being monitored until this is fixed. $FLEET_WHY\",\"speech\":\"Fleet monitoring is down, sir. The platform registry yielded nothing to probe.\"}" \
    -o /dev/null 2>/dev/null
  exit 1
fi

summary=""
while IFS='|' read -r name url expected; do
  [ -z "$name" ] && continue
  code=$(curl -s -L -o /dev/null -w '%{http_code}' --max-time 12 "$url" 2>/dev/null)
  # Retry once before counting anything as a miss (2026-07-24): 24h of data
  # showed vapron.ai alone returning 000 on 19/144 probes (13%) — slow site,
  # transient timeouts, NOT downtime — and those misses were feeding strikes
  # → status=error → self-heal "repairing" a healthy site 4× in 12h. A real
  # outage fails the retry too; a blip almost never fails twice in a row.
  case "$code" in
    2*|3*) ;;
    *) sleep 2; code=$(curl -s -L -o /dev/null -w '%{http_code}' --max-time 20 "$url" 2>/dev/null) ;;
  esac
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
  # --max-time here as well as on the probes above (2026-07-30, found by the
  # code-health spine). The probes were bounded and this write was not, so a
  # memory-server that accepted the connection and stalled would hang this loop
  # forever — and because the unit is Type=oneshot (timeout disabled by default,
  # now set explicitly) systemd would skip every subsequent timer activation
  # while it sat there "activating". Nothing would report it: fleet-check IS the
  # thing that notices a platform is down, and self-heal only ever acts on the
  # status it writes, so the whole detect-and-repair chain would go quiet with
  # every service still showing green.
  curl -s -X POST "$MEM" -H 'Content-Type: application/json' --max-time 10 \
    -d "{\"platform\":\"$name\",\"status\":\"$status\",\"health_score\":$score,\"notes\":\"$note\"}" \
    -o /dev/null 2>/dev/null
  summary="$summary $name=${code:-000}"
done <<< "$FLEET"

echo "[fleet-check] $TS |$summary"

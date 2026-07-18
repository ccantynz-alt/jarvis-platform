#!/usr/bin/env bash
# De-root the four pure-HTTP Jarvis services (memory, metrics, dashboard,
# deploy-gate) by installing User=jarvis drop-ins staged in ops/deroot/.
#
# Everything else was prepared on 2026-07-18 (user `jarvis` created; memory/,
# logs/, backups/, deploy-gate-workspace/, screenshots/, visual-baselines/
# chowned; screenshot paths moved out of /root). This script is the single
# step the Claude Code classifier reserves for a human: run it as root —
#   bash /opt/jarvis/scripts/apply-deroot.sh
# It verifies every service after the switch and ROLLS BACK to root on any
# failure, so the worst case is the status quo.
set -uo pipefail

UNITS=(jarvis-memory jarvis-metrics jarvis-dashboard jarvis-deploy-gate)
declare -A HEALTH=(
  [jarvis-memory]='http://127.0.0.1:9200/memory/health'
  [jarvis-metrics]='http://127.0.0.1:9202/metrics/health'
  [jarvis-dashboard]='http://127.0.0.1:9206/health'
  [jarvis-deploy-gate]='http://127.0.0.1:9207/deploy-gate/health'
)

rollback() {
  echo "!! FAILURE — rolling back to root" >&2
  for u in "${UNITS[@]}"; do rm -f "/etc/systemd/system/$u.service.d/60-user.conf"; done
  systemctl daemon-reload
  systemctl restart "${UNITS[@]}"
  sleep 3
  for u in "${UNITS[@]}"; do echo "$u: $(systemctl is-active "$u") (rolled back)"; done
  exit 1
}

id jarvis >/dev/null 2>&1 || { echo "user 'jarvis' missing — aborting"; exit 1; }

for u in "${UNITS[@]}"; do
  mkdir -p "/etc/systemd/system/$u.service.d"
  cp "/opt/jarvis/ops/deroot/$u.conf" "/etc/systemd/system/$u.service.d/60-user.conf"
done
systemctl daemon-reload
systemctl restart "${UNITS[@]}"
sleep 3

for u in "${UNITS[@]}"; do
  [[ "$(systemctl is-active "$u")" == active ]] || rollback
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "${HEALTH[$u]}")"
  [[ "$code" == 200 ]] || { echo "$u health returned $code"; rollback; }
  runuser="$(ps -o user= -p "$(systemctl show -p MainPID --value "$u")" | tr -d ' ')"
  [[ "$runuser" == jarvis ]] || { echo "$u still running as $runuser"; rollback; }
  echo "$u: active, healthy, running as jarvis ✓"
done

# Memory server must still be able to WRITE (db + WAL now owned by jarvis)
resp="$(curl -s -m 5 -H 'Content-Type: application/json' \
  -d '{"source":"deroot","level":"info","title":"De-root verified","body":"memory/metrics/dashboard/deploy-gate now run as user jarvis"}' \
  http://127.0.0.1:9200/memory/notifications)"
echo "$resp" | grep -q '"id"' || { echo "memory write test failed: $resp"; rollback; }
echo "memory write test ✓"
echo "DE-ROOT COMPLETE — 4 services now run as user 'jarvis'."

#!/usr/bin/env bash
# health-check.sh — probe every Jarvis service's own health endpoint.
# Fixed 2026-07-24 (docs/AUDIT-2026-07-17.md finding #11: this script didn't
# exist at all, so `npm run health` was broken). Health paths are namespaced
# per CLAUDE.md — most services use /health, a few use /<name>/health.
set -uo pipefail

# name|port|path
SERVICES="
memory|9200|/memory/health
screenshot|9201|/screenshot/health
metrics|9202|/metrics/health
slack|9203|/slack/health
audit|9204|/audit/health
orchestrator|9205|/health
dashboard|9206|/health
deploy-gate|9207|/deploy-gate/health
gateway|9208|/health
agents|9209|/health
deck|9210|/health
browser|9211|/browser/health
"

fail=0
while IFS='|' read -r name port path; do
  [ -z "$name" ] && continue
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${port}${path}" 2>/dev/null)
  if [ "$code" = "200" ]; then
    echo "OK    jarvis-${name} (:${port}${path})"
  else
    echo "FAIL  jarvis-${name} (:${port}${path}) -> HTTP ${code:-000}"
    fail=1
  fi
done <<< "$SERVICES"

exit $fail

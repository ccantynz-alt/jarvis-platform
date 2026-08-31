#!/usr/bin/env bash
# janitor.sh — daily whitelist-only box maintenance (Marco spec §6, 2026-08-31).
# JANITOR_MODE=report (default): observe + report, delete nothing.
# JANITOR_MODE=clean: the whitelisted deletions below are allowed. Nothing else ever.
#
# Box adaptations (2026-08-31, Task 7 sanity run):
#  - no sqlite3 CLI on this box; weekly VACUUM uses node + better-sqlite3 instead.
#  - pgrep -O/--older confirmed present (procps-ng 3.3.17); kept as primary check.
#  - bak-file find wrapped in \( -o \) so -maxdepth applies to both name tests.
set -uo pipefail
MODE=$(grep -m1 '^JANITOR_MODE=' /opt/jarvis/config/marco.env 2>/dev/null | cut -d= -f2)
MODE=${MODE:-report}
ISSUES=(); ACTIONS=()

# 1. Disk
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$DISK_PCT" -ge 75 ]; then
  ISSUES+=("disk ${DISK_PCT}% (threshold 75%); top growth: $(du -xhs /opt/* 2>/dev/null | sort -rh | head -3 | tr '\n' ' ')")
fi

# 2. Old .bak clutter + old logs (whitelist: only these patterns, only these dirs)
BAKS=$(find /opt/jarvis/src /opt/jarvis/scripts /opt/jarvis/config -maxdepth 2 \( -name '*.bak.*' -o -name '*.bak-*' \) 2>/dev/null | head -50)
OLDLOGS=$(find /opt/jarvis/logs -type f -mtime +14 2>/dev/null | head -50)
if [ -n "$BAKS$OLDLOGS" ]; then
  if [ "$MODE" = "clean" ]; then
    echo "$OLDLOGS" | xargs -r rm -f && ACTIONS+=("deleted $(echo "$OLDLOGS" | grep -c .) logs >14d")
    ISSUES+=("bak files present (never auto-deleted, listed for review): $(echo "$BAKS" | tr '\n' ' ')")
  else
    ISSUES+=("cleanup candidates (report mode): $(echo "$BAKS $OLDLOGS" | wc -w) files")
  fi
fi

# 3. Failed units + zombies + orphaned chrome
FAILED=$(systemctl --failed --no-legend | awk '{print $2}' | tr '\n' ' ')
[ -n "${FAILED// /}" ] && ISSUES+=("failed units: $FAILED")
ZOMBIES=$(ps -eo stat,pid,comm | awk '$1 ~ /Z/ {print $2}' | wc -l)
[ "$ZOMBIES" -gt 0 ] && ISSUES+=("$ZOMBIES zombie processes")
ORPHANS=$(pgrep -f 'chrom.*--headless' --older 7200 2>/dev/null | wc -l || echo 0)
if [ "$ORPHANS" -gt 0 ]; then
  if [ "$MODE" = "clean" ]; then pkill -f 'chrom.*--headless' --older 7200 && ACTIONS+=("killed $ORPHANS headless-chrome orphans >2h"); else ISSUES+=("$ORPHANS headless-chrome orphans >2h (report mode)"); fi
fi

# 4. Memory DB care: weekly VACUUM (Sunday), daily backup freshness
if [ "$(date -u +%u)" = "7" ] && [ "$MODE" = "clean" ]; then
  cd /opt/jarvis && node -e "const D=require('better-sqlite3');const db=new D('/opt/jarvis/memory/jarvis.db');db.pragma('wal_checkpoint(TRUNCATE)');db.exec('VACUUM');db.exec('ANALYZE');db.close();" \
    && ACTIONS+=("weekly VACUUM+ANALYZE")
fi
NEWEST_BACKUP=$(ls -t /opt/jarvis/backups/*.db* 2>/dev/null | head -1)
if [ -z "$NEWEST_BACKUP" ] || [ -n "$(find "$NEWEST_BACKUP" -mtime +2 2>/dev/null)" ]; then
  ISSUES+=("memory backup missing or older than 48h: ${NEWEST_BACKUP:-none}")
fi

# 5. Security quick-check
SSH_FAILS=$(journalctl -u ssh --since yesterday 2>/dev/null | grep -c 'Failed password')
SSH_FAILS=${SSH_FAILS:-0}
[ "$SSH_FAILS" -gt 200 ] && ISSUES+=("$SSH_FAILS failed SSH attempts in 24h")
DRIFT=$(comm -13 <(jq -r '.ports[]' /opt/jarvis/config/ports-baseline.json | sort -n) \
  <(ss -tln | awk 'NR>1 {print $4}' | sed 's/.*://' | sort -un))
[ -n "$DRIFT" ] && ISSUES+=("NEW listening ports vs baseline: $(echo "$DRIFT" | tr '\n' ' ')")

# Report
SUMMARY="disk ${DISK_PCT}%, ${#ISSUES[@]} issues, ${#ACTIONS[@]} actions [$MODE]"
DETAIL=$(printf '%s; ' "${ISSUES[@]:-none}" "${ACTIONS[@]:-}")
bash /opt/jarvis/scripts/marco-report.sh janitor box "$([ ${#ISSUES[@]} -eq 0 ] && echo ok || echo blocked)" \
  "daily box-health sweep" "$DETAIL" "janitor,box-health"
if [ ${#ISSUES[@]} -gt 0 ]; then
  bash /opt/jarvis/scripts/agent-report.sh janitor 0 action_needed "$SUMMARY" "$DETAIL"
fi
echo "$SUMMARY"

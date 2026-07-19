#!/usr/bin/env bash
# Jarvis control-plane backup: PULL a consistent snapshot of box 158's live
# vapron SQLite DB to box 161, verified + rotated. Replaces the on-158
# vapron-backup service, which silently protected nothing (built for
# Turso/Neon; vapron actually uses file:/opt/vapron/data/vapron.db, and its
# MinIO upload target is down). No box-158 config or MinIO needed — Jarvis
# reaches 158 headless over the tailnet (tag:server SSH).
set -Eeuo pipefail

BOX="${VAPRON_BOX:-100.89.227.39}"           # box 158 tailnet IP
REMOTE_DB="${VAPRON_DB:-/opt/vapron/data/vapron.db}"
DEST_DIR="${DEST_DIR:-/var/backups/vapron}"
KEEP="${KEEP:-14}"                            # daily snapshots to retain
LOG="${LOG:-/var/log/jarvis-vapron-backup.log}"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 "root@$BOX")

log() { echo "[$(date -Is)] $*" | tee -a "$LOG" >&2; }

notify_fail() {
  local msg="$1"
  curl -sf -m 5 -H 'Content-Type: application/json' \
    -d "{\"source\":\"vapron-backup\",\"level\":\"alert\",\"title\":\"Vapron DB backup FAILED\",\"body\":\"$msg\",\"speech\":\"Alert. The vapron database backup failed.\"}" \
    http://127.0.0.1:9200/memory/notifications >/dev/null 2>&1 || true
}
trap 'notify_fail "see $LOG"' ERR

mkdir -p "$DEST_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
SNAP="/tmp/vapron-snap-$STAMP.db"
DEST="$DEST_DIR/vapron-db-$STAMP.db.gz"

log "start: snapshot $BOX:$REMOTE_DB"
# Consistent online .backup + integrity check ON the source box.
"${SSH[@]}" "sqlite3 'file:$REMOTE_DB' '.backup $SNAP' && \
  [ \"\$(sqlite3 '$SNAP' 'PRAGMA integrity_check;' | head -1)\" = ok ]" \
  || { log "snapshot/integrity failed on $BOX"; "${SSH[@]}" "rm -f '$SNAP'" || true; exit 3; }

EXP="$("${SSH[@]}" "stat -c%s '$SNAP'")"
"${SSH[@]}" "gzip -c '$SNAP'" > "$DEST"
"${SSH[@]}" "rm -f '$SNAP'" || true

GOT="$(zcat "$DEST" | wc -c)"
if [ "$GOT" != "$EXP" ]; then
  log "SIZE MISMATCH got=$GOT expected=$EXP — discarding"; rm -f "$DEST"; exit 4
fi

log "ok: $DEST ($(stat -c%s "$DEST") bytes gz, db=$EXP bytes, integrity ok)"
# Rotate: keep newest $KEEP.
ls -1t "$DEST_DIR"/vapron-db-*.db.gz 2>/dev/null | tail -n +"$((KEEP+1))" | xargs -r rm -f
trap - ERR

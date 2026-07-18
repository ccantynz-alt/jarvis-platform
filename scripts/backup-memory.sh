#!/usr/bin/env bash
# Jarvis memory backup: WAL-safe SQLite online backup via better-sqlite3.
# Keeps the 14 newest backups; runs from systemd timer jarvis-backup.timer.
set -euo pipefail

JARVIS_DIR="/opt/jarvis"
BACKUP_DIR="${JARVIS_DIR}/backups"
DB_PATH="${JARVIS_DIR}/memory/jarvis.db"
HEALTH_PATH="${JARVIS_DIR}/memory/platform-health.json"
KEEP=14

TS="$(date +%Y%m%d-%H%M%S)"
DB_BACKUP="${BACKUP_DIR}/jarvis-${TS}.db"

mkdir -p "$BACKUP_DIR"
cd "$JARVIS_DIR"  # so better-sqlite3 resolves from /opt/jarvis/node_modules

# Online backup (WAL-safe, no service downtime). backup() returns a promise.
node - "$DB_PATH" "$DB_BACKUP" <<'EOF'
const Database = require('better-sqlite3');
const [src, dest] = process.argv.slice(2);
const db = new Database(src, { readonly: true, fileMustExist: true });
db.backup(dest)
  .then(() => { db.close(); })
  .catch((err) => {
    console.error('backup failed:', err.message);
    process.exit(1);
  });
EOF

# Copy platform health snapshot with the same timestamp (tolerate absence)
if [[ -f "$HEALTH_PATH" ]]; then
  cp "$HEALTH_PATH" "${BACKUP_DIR}/platform-health-${TS}.json"
fi

# Prune: keep the newest $KEEP jarvis-*.db backups and their json siblings
ls -1t "${BACKUP_DIR}"/jarvis-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old_db; do
  old_ts="$(basename "$old_db" .db)"
  old_ts="${old_ts#jarvis-}"
  rm -f "$old_db" "${BACKUP_DIR}/platform-health-${old_ts}.json"
done

SIZE="$(stat -c %s "$DB_BACKUP")"
echo "backup ok: ${TS} ${DB_BACKUP} ${SIZE} bytes"

# ── Off-box copy: push tonight's snapshot to box 158 over the tailnet ────────
# Same tag:server SSH channel pull-vapron-backup.sh already uses in the other
# direction. Never fatal: local backup stands on its own; a failed push only
# raises a deck notification (deduped by memory-server).
OFFBOX="${OFFBOX_HOST:-100.89.227.39}"
OFFBOX_DIR="${OFFBOX_DIR:-/var/backups/jarvis-offbox}"
OFFBOX_KEEP="${OFFBOX_KEEP:-30}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)

push_offbox() {
  gzip -c "$DB_BACKUP" | ssh "${SSH_OPTS[@]}" "root@$OFFBOX" \
    "mkdir -p '$OFFBOX_DIR' && cat > '$OFFBOX_DIR/jarvis-${TS}.db.gz.part' \
     && mv '$OFFBOX_DIR/jarvis-${TS}.db.gz.part' '$OFFBOX_DIR/jarvis-${TS}.db.gz'"
  # Round-trip check: gunzip on 158 must yield the exact local byte count.
  local remote_size
  remote_size="$(ssh "${SSH_OPTS[@]}" "root@$OFFBOX" \
    "gunzip -c '$OFFBOX_DIR/jarvis-${TS}.db.gz' | wc -c")"
  [[ "$remote_size" == "$SIZE" ]] || return 1
  # Retention on 158: newest $OFFBOX_KEEP archives.
  ssh "${SSH_OPTS[@]}" "root@$OFFBOX" \
    "ls -1t '$OFFBOX_DIR'/jarvis-*.db.gz 2>/dev/null | tail -n +$((OFFBOX_KEEP + 1)) | xargs -r rm -f"
}

if push_offbox; then
  echo "offbox ok: ${OFFBOX}:${OFFBOX_DIR}/jarvis-${TS}.db.gz (verified ${SIZE} bytes)"
else
  echo "offbox push FAILED (local backup unaffected)" >&2
  curl -sf -m 5 -H 'Content-Type: application/json' \
    -d "{\"source\":\"jarvis-backup\",\"level\":\"warn\",\"title\":\"Off-box jarvis.db push failed\",\"body\":\"push to ${OFFBOX}:${OFFBOX_DIR} failed for ${TS}; local backup OK\"}" \
    http://127.0.0.1:9200/memory/notifications >/dev/null 2>&1 || true
fi

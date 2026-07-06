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

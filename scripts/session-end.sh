#!/bin/bash
# session-end.sh — Run at the END of EVERY Claude Code session
# Usage: bash /opt/jarvis/scripts/session-end.sh <platform> <session_id> "<summary>" ["<file1,file2,...>"]
# Example: bash /opt/jarvis/scripts/session-end.sh zoobicon 42 "Fixed visual-repair race condition in ai-spawn.ts" "src/ai-spawn.ts,tests/ai-spawn.test.ts"
#
# The 4th arg (files_changed) is OPTIONAL but matters: jarvis-deploy-gate
# (src/deploy-gate.js) polls this table for sessions with a non-empty
# files_changed as its "a deploy just happened" signal — before this field
# was wired through, every session recorded files_changed=[] and the
# deploy gate could never actually fire. Pass a comma-separated list of
# the files this session actually changed (e.g. `git diff --name-only
# main` from the platform's repo) if you want deploy-gate coverage for
# this session's work.

PLATFORM=${1:-"unknown"}
SESSION_ID=${2:-$(cat /tmp/jarvis-session.env 2>/dev/null | grep SESSION_ID | cut -d= -f2 || echo "0")}
SUMMARY=${3:-"No summary provided — this session was not properly closed"}
FILES_CHANGED_RAW=${4:-""}

# Convert "a,b,c" into a JSON array via python (already a dependency of
# this script for the response-parsing line below — no new dependency).
FILES_CHANGED_JSON=$(python3 -c "
import json, sys
raw = sys.argv[1].strip()
files = [f.strip() for f in raw.split(',') if f.strip()] if raw else []
print(json.dumps(files))
" "$FILES_CHANGED_RAW")

echo "Recording session end..."

# Body built by python's json.dumps (2026-08-19): the old inline JSON left
# session_id UNQUOTED and the summary unescaped, so a non-numeric id or a quote
# in the summary made invalid JSON — memory-server 400'd, the session was never
# recorded, and this script still printed "closed". Numeric ids stay numbers.
BODY=$(python3 - "$SESSION_ID" "$SUMMARY" "$FILES_CHANGED_JSON" <<'PY'
import json, sys
sid, summary, files = sys.argv[1], sys.argv[2], json.loads(sys.argv[3] or '[]')
try: sid = int(sid)
except ValueError: pass
print(json.dumps({"session_id": sid, "summary": summary, "files_changed": files, "proof": "session-end.sh"}))
PY
)
RESULT=$(curl -sf -X POST http://127.0.0.1:9200/memory/session/end   -H "Content-Type: application/json" -d "$BODY" 2>/dev/null)
if echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('ok') else 1)" 2>/dev/null; then
  echo "✅ Session recorded"
else
  echo "❌ Failed to record session $SESSION_ID (memory said: ${RESULT:-no response}) — the summary below is NOT in memory"
fi



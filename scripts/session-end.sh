#!/bin/bash
# session-end.sh — Run at the END of EVERY Claude Code session
# Usage: bash /opt/jarvis/scripts/session-end.sh <platform> <session_id> "<summary>"
# Example: bash /opt/jarvis/scripts/session-end.sh zoobicon 42 "Fixed visual-repair race condition in ai-spawn.ts"

PLATFORM=${1:-"unknown"}
SESSION_ID=${2:-$(cat /tmp/jarvis-session.env 2>/dev/null | grep SESSION_ID | cut -d= -f2 || echo "0")}
SUMMARY=${3:-"No summary provided — this session was not properly closed"}

echo "Recording session end..."

curl -sf -X POST http://127.0.0.1:9200/memory/session/end \
  -H "Content-Type: application/json" \
  -d "{
    \"session_id\": $SESSION_ID,
    \"summary\": \"$SUMMARY\",
    \"proof\": \"session-end.sh called at $(date)\"
  }" | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ Session recorded' if d.get('ok') else '❌ Failed to record')" 2>/dev/null \
  || echo "❌ Memory service not responding"

echo ""
echo "Session $SESSION_ID closed for $PLATFORM"
echo "Summary: $SUMMARY"
echo ""
echo "The next Claude Code session will see this context."
rm -f /tmp/jarvis-session.env

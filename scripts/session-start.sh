#!/bin/bash
# session-start.sh — Run at the start of EVERY Claude Code session
# Usage: bash /opt/jarvis/scripts/session-start.sh <platform>
# Example: bash /opt/jarvis/scripts/session-start.sh zoobicon

PLATFORM=${1:-"all"}
MEMORY_URL="http://127.0.0.1:9200"

echo "╔══════════════════════════════════════════════════╗"
echo "  JARVIS SESSION START — $(date)"
echo "  Platform: $PLATFORM"
echo "╚══════════════════════════════════════════════════╝"

# Start session in memory, capture ID
SESSION_RESPONSE=$(curl -sf -X POST ${MEMORY_URL}/memory/session/start \
  -H "Content-Type: application/json" \
  -d "{\"platform\":\"$PLATFORM\",\"objective\":\"Session started via session-start.sh\"}" 2>/dev/null)

SESSION_ID=$(echo $SESSION_RESPONSE | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id','0'))" 2>/dev/null || echo "0")
echo "SESSION_ID=$SESSION_ID" > /tmp/jarvis-session.env
echo ""
echo "Session ID: $SESSION_ID (save this for session-end.sh)"

# Platform context
echo ""
echo "━━━ PLATFORM CONTEXT ━━━"
curl -sf "${MEMORY_URL}/memory/context?platform=$PLATFORM" 2>/dev/null | \
  python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  state = d.get('platform_state', {})
  if isinstance(state, list):
    for s in state:
      score = s.get('health_score', 0)
      marker = '✅' if score > 80 else '⚠️' if score > 50 else '🔴'
      print(f\"{marker} {s['platform'].upper()}: {s['status']} (score: {score}/100)\")
      errs = json.loads(s.get('last_known_errors') or '[]')
      if errs:
        print(f'   Last known errors ({len(errs)}):')
        for e in errs[:5]: print(f'   • {e[:120]}')
  else:
    score = state.get('health_score', 0)
    print(f\"Status: {state.get('status')} | Score: {score}/100\")
    errs = json.loads(state.get('last_known_errors') or '[]')
    if errs:
      print(f'Last known errors ({len(errs)}):')
      for e in errs[:10]: print(f'• {e[:120]}')

  print('')
  sessions = d.get('recent_sessions', [])
  if sessions:
    print(f'Recent sessions ({len(sessions)}):')
    for s in sessions[:3]:
      ended = '✓' if s.get('ended_at') else '⚠ NEVER CLOSED'
      print(f'  [{s[\"id\"]}] {s[\"started_at\"][:16]} {ended}')
      if s.get('summary'): print(f'    {str(s[\"summary\"])[:100]}')

  issues = d.get('open_issues', [])
  if issues:
    print(f'')
    print(f'Open unverified repairs ({len(issues)}):')
    for i in issues[:10]:
      print(f'  [{i[\"id\"]}] {i[\"file_path\"]}: {str(i[\"issue\"])[:80]}')
except Exception as e:
  print(f'Memory read error: {e}')
" 2>/dev/null || echo "Memory service not responding — start with: systemctl start jarvis-memory"

# GateTest awareness
echo ""
echo "━━━ GATETEST ━━━"
if [ -d "/opt/gatetest" ]; then
  # Check if the GateTest process is running
  if pgrep -f "gatetest" > /dev/null 2>&1 || curl -sf http://127.0.0.1:4200/health > /dev/null 2>&1; then
    echo "✅ GateTest: RUNNING at /opt/gatetest"
  else
    echo "⚠️  GateTest: installed at /opt/gatetest (not running)"
  fi
  echo ""
  echo "  Before frontend changes — capture baseline:"
  echo "    node /opt/gatetest/bin/gatetest.js scan --url <platform_url> --modules visualRegression"
  echo "  After changes — compare:"
  echo "    node /opt/gatetest/bin/gatetest.js scan --url <platform_url> --modules visualRegression"
  echo "  ⚠️  NEVER deploy frontend changes without a visual diff."
  echo ""
  echo "  MCP server: npx @gatetest/mcp-server"
else
  echo "❌ GateTest not found at /opt/gatetest"
fi

# Service health
echo ""
echo "━━━ JARVIS SERVICES ━━━"
for name_port in "memory:9200" "screenshot:9201" "metrics:9202" "slack:9203" "audit:9204"; do
  NAME=$(echo $name_port | cut -d: -f1)
  PORT=$(echo $name_port | cut -d: -f2)
  STATUS=$(curl -sf http://127.0.0.1:${PORT}/${NAME}/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('✅ ONLINE')" 2>/dev/null || echo "🔴 OFFLINE")
  printf "%-20s %s\n" "$NAME ($PORT):" "$STATUS"
done

# Latest screenshot
LATEST=$(ls -t /opt/jarvis/screenshots/*.png 2>/dev/null | head -1)
echo ""
if [ -n "$LATEST" ]; then
  echo "━━━ LATEST SCREENSHOT ━━━"
  echo "File: $LATEST"
  echo "Size: $(du -h $LATEST | cut -f1)"
  echo "Age: $(date -d @$(stat -c %Y $LATEST) '+%Y-%m-%d %H:%M:%S')"
else
  echo "No screenshots yet. Run: curl -X POST http://127.0.0.1:9201/screenshot/capture -H 'Content-Type: application/json' -d '{\"url\":\"https://zoobicon.com\"}'"
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "  READ THE ABOVE BEFORE TOUCHING ANY CODE"
echo "  Session ID: $SESSION_ID"
echo "  End with: bash /opt/jarvis/scripts/session-end.sh $PLATFORM $SESSION_ID \"summary\""
echo "╚══════════════════════════════════════════════════╝"

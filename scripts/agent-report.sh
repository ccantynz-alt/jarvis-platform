#!/usr/bin/env bash
# agent-report.sh — role agents file their mandatory end-of-job report.
# Usage: agent-report.sh <agent> <job_id> <ok|action_needed|escalate> "<summary>" ["<details>"]
set -euo pipefail

if [ $# -lt 4 ]; then
  echo "usage: agent-report.sh <agent> <job_id> <ok|action_needed|escalate> \"summary\" [\"details\"]" >&2
  exit 64
fi

jq -n \
  --arg agent "$1" \
  --arg job_id "$2" \
  --arg status "$3" \
  --arg summary "$4" \
  --arg details "${5:-}" \
  '{agent: $agent, job_id: $job_id, status: $status, summary: $summary, details: $details}' \
| curl -s -X POST http://127.0.0.1:9200/memory/agent-report \
    -H 'Content-Type: application/json' \
    --data-binary @-
echo

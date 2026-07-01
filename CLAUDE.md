# CLAUDE.md — Jarvis Platform
> Operating doctrine for every Claude Code session working on this repo.
> Read this entire file before touching any code.

---

## WHAT JARVIS IS

Jarvis is the autonomous agent platform running on Vultr Chicago (149.28.119.158).
It is NOT a product. It is the infrastructure that watches, audits, and repairs
Craig's platforms so they stay healthy without human intervention.

Jarvis serves Craig Canty / MarcoReid Intelligence Systems.

Platforms Jarvis monitors:
- Zoobicon (zoobicon.com) — AI website builder, currently broken, priority #1
- Vapron (vapron.ai) — self-hosted infrastructure platform
- AlecRae (alecrae.com) — AI legal + accounting platform
- MarcoReid (marcoreid.com) — premium professional tier
- GateTest (gatetest.ai) — code quality platform (111 modules)
- eSIM MVNO — pre-launch

---

## THE FIVE SERVICES

| Service | File | Port | Purpose |
|---------|------|------|---------|
| jarvis-memory | src/memory-server.js | 9200 | Cross-session SQLite memory |
| jarvis-screenshot | src/screenshot-service.js | 9201 | CDP screenshot capture |
| jarvis-metrics | src/metrics-collector.js | 9202 | Real server metrics + WebSocket |
| jarvis-slack | src/slack-bridge.js | 9203 | Slack command interface |
| jarvis-audit | src/audit-runner.js | 9204 | Build + test audit runner |

All services run on 127.0.0.1 (loopback only).
All are managed by systemd and survive reboots.
All have a /health endpoint Claude must probe before assuming they are running.

---

## THE FIVE RULES

### Rule 1 — Read memory first
Every session starts with:
```bash
bash /opt/jarvis/scripts/session-start.sh <platform>
```
This reads the SQLite memory store and prints full context.
Never touch code without running this first.

### Rule 2 — Proof of work required
Nothing is "done" without a named artifact proving it:
- A green health probe response
- A screenshot showing the fix rendered
- A passing test output
- A successful build log
"The code looks right" is not proof.

### Rule 3 — Write memory at session end
Every session ends with:
```bash
bash /opt/jarvis/scripts/session-end.sh <platform> <session_id> "<summary>"
```
A session that ends without updating memory has not fully ended.
The next session will start blind. This rule exists to prevent that.

### Rule 4 — Never break Vapron to fix Zoobicon
Jarvis runs ON Vapron's infrastructure. Jarvis services run on ports
9200-9204. Do not conflict with Vapron's ports (3000, 3001, 8090, 9099).
Do not modify Vapron config files from this repo.

### Rule 5 — No competitor dependencies
No Playwright. No Puppeteer. No Vercel SDK. No Cloudflare SDK.
Screenshots use raw Chromium CDP only.
If you need browser automation, extend src/screenshot-service.js.

---

## ARCHITECTURE

```
Craig (Slack / iPad)
        ↓
jarvis-slack (9203) — receives commands
        ↓
jarvis-audit (9204) — runs GateTest + build checks
        ↓
jarvis-screenshot (9201) — captures rendered output
        ↓
Claude Code — reads screenshot + errors, writes fixes
        ↓
jarvis-memory (9200) — logs everything, survives session reset
        ↑
jarvis-metrics (9202) — feeds real data to Jarvis HUD (WebSocket)
```

---

## PORTS IN USE ON VULTR BOX

Existing Vapron services (DO NOT CONFLICT):
- :80 / :443 — Caddy (TLS front door)
- :3000 — Vapron web app
- :3001 — Vapron API (Hono + tRPC)
- :8090 — bun-gateway
- :9099 — deploy-agent

Jarvis services (this repo):
- :9200 — memory-server
- :9201 — screenshot-service
- :9202 — metrics-collector (HTTP + WebSocket)
- :9203 — slack-bridge
- :9204 — audit-runner

---

## FILE STRUCTURE

```
jarvis-platform/
├── src/
│   ├── memory-server.js       — SQLite memory + REST API
│   ├── screenshot-service.js  — CDP screenshot capture
│   ├── metrics-collector.js   — server metrics + WebSocket
│   ├── slack-bridge.js        — Slack commands + reports
│   └── audit-runner.js        — build/test/screenshot audit loop
├── scripts/
│   ├── install.sh             — one-command server setup
│   ├── session-start.sh       — run at start of every Claude session
│   └── session-end.sh         — run at end of every Claude session
├── config/
│   └── secrets.env.example    — env var template (never commit real secrets)
├── systemd/
│   ├── jarvis-memory.service
│   ├── jarvis-screenshot.service
│   ├── jarvis-metrics.service
│   ├── jarvis-slack.service
│   └── jarvis-audit.service
├── docs/
│   └── PLATFORM_REGISTRY.md  — known state of all platforms
├── CLAUDE.md                  — this file
├── package.json
└── README.md
```

---

## SECRETS

Real secrets live in /opt/jarvis/config/secrets.env on the server.
That file is NOT in this repo (gitignored).
Template is at config/secrets.env.example.

Required secrets:
- SLACK_BOT_TOKEN — xoxb-... from Slack app
- JARVIS_SLACK_CHANNEL — e.g. #jarvis
- ZOOBICON_PATH — filesystem path to Zoobicon repo on server
- VAPRON_PATH — filesystem path to Vapron repo on server
- GATETEST_PATH — filesystem path to GateTest repo on server
- CHROMIUM_BIN — chromium-browser or chromium

---

## WHEN SOMETHING BREAKS

1. Check service status: `systemctl status jarvis-<name>`
2. Check logs: `journalctl -u jarvis-<name> -n 50`
3. Probe health endpoint: `curl http://127.0.0.1:<port>/health`
4. Never restart a service without reading its last 50 log lines first
5. If a service is down, read memory first — it may explain why

---

## SESSION PROTOCOL (MANDATORY)

Start:
```bash
bash /opt/jarvis/scripts/session-start.sh <platform>
# Read ALL output before proceeding
```

During session — after every fix:
```bash
curl -s -X POST http://127.0.0.1:9200/memory/repair/log \
  -H "Content-Type: application/json" \
  -d '{"platform":"<p>","file_path":"<f>","issue":"<i>","fix_applied":"<fix>"}'
```

End:
```bash
bash /opt/jarvis/scripts/session-end.sh <platform> <session_id> "<what you did>"
```

# CLAUDE.md — Jarvis Platform
> Operating doctrine for every Claude Code session working on this repo.
> Read this entire file before touching any code.
> Last verified against the live box: 2026-07-06.

---

## WHAT JARVIS IS

Jarvis is the autonomous agent platform running on the Vultr box at
**66.42.121.161** (hostname `vultr`). It is NOT a product. It is the
infrastructure that watches, audits, and repairs Craig's platforms so they
stay healthy without human intervention.

Jarvis serves Craig Canty / MarcoReid Intelligence Systems.

Platforms Jarvis monitors (source of truth: `config/platforms.json` —
read it, don't trust this list):
- Zoobicon (zoobicon.com) — AI website builder
- Vapron (vapron.ai) — self-hosted infrastructure platform
- AlecRae (alecrae.com) — AI legal + accounting platform; **runs on THIS box**
  at `/opt/alecrae` (bun API on :4100, Next.js on :4200, user `alecrae`)
- MarcoReid (marcoreid.com) — premium professional tier
- GateTest (gatetest.ai) — code quality platform, local checkout `/opt/gatetest`
- Gluecron (gluecron.com) — AI-native git host; **runs on THIS box** as a
  Docker container behind Coolify/Traefik (see Gotchas below)
- eSIM MVNO — pre-launch

---

## THE EIGHT SERVICES

| Service | File | Port | Bind | Purpose |
|---------|------|------|------|---------|
| jarvis-memory | src/memory-server.js | 9200 | loopback | Cross-session SQLite memory |
| jarvis-screenshot | src/screenshot-service.js | 9201 | loopback | CDP screenshot capture |
| jarvis-metrics | src/metrics-collector.js | 9202 | loopback | Real server metrics + WebSocket |
| jarvis-slack | src/slack-bridge.js | 9203 | loopback | Slack command interface |
| jarvis-audit | src/audit-runner.js | 9204 | loopback | Build + test audit runner |
| jarvis-orchestrator | src/orchestrator.js | 9205 | loopback | Dispatch engine — spawns Claude agents (local + SSH) |
| jarvis-dashboard | src/dashboard-server.js | 9206 | **0.0.0.0 — PUBLIC, NO AUTH (known debt)** | Status panel + screenshot browser |
| jarvis-deploy-gate | src/deploy-gate.js | 9207 | loopback | GateTest scan gating platform deploys |

All are managed by systemd (`systemctl status 'jarvis-*'`) and survive reboots.
All have a `/health` endpoint Claude must probe before assuming they are running.
`config/platforms.json` is re-read on every request — registry edits take
effect immediately, no restart needed.

---

## THE RULES

### Rule 0 — This file must match reality
If a session changes topology (new service, port, platform, path), it updates
this file **in the same commit**. If this file disagrees with the box, the box
wins: probe, then fix this file. A doctrine file that lies is worse than none —
every future agent starts with false beliefs and wastes its first 20 minutes
rediscovering the truth.

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
A session that ends without updating memory has not fully ended. The next
session will start blind. (Audit 2026-07-06: 12 of 47 sessions were never
closed. Don't add to that number.)

### Rule 4 — Never break co-tenants
This box also runs AlecRae, Gluecron, GateTest, and the Coolify stack.
Jarvis owns ports 9200–9207 and nothing else. Before binding any port,
check `ss -tlnp`. Do not modify co-tenant config from this repo.

### Rule 5 — No competitor dependencies
No Playwright. No Puppeteer. No Vercel SDK. No Cloudflare SDK.
Screenshots use raw Chromium CDP only.
If you need browser automation, extend src/screenshot-service.js.

---

## ARCHITECTURE

```
Craig (Slack / iPad)
        ↓
jarvis-slack (9203) ── detectIntent() ──→ jarvis-orchestrator (9205)
                                               ↓ spawns
                              claude --print (local cwd, or ssh -i .ssh/orchestrator root@<server>)
                                               ↓ uses
        jarvis-audit (9204) · jarvis-screenshot (9201) · GateTest (/opt/gatetest)
                                               ↓ everything logs to
                              jarvis-memory (9200, SQLite at memory/jarvis.db)
                                               ↑ read by
        jarvis-dashboard (9206) · jarvis-metrics (9202, feeds HUD via WebSocket)
                              jarvis-deploy-gate (9207) polls deploys, runs GateTest
```

Orchestrator dispatch (the fastest way to run work programmatically):
```bash
curl -s -X POST http://127.0.0.1:9205/dispatch \
  -H "Content-Type: application/json" \
  -d '{"platform":"zoobicon","task":"<what to do>"}'
# platform "auto" scans task text for a platform name. Jobs: GET /jobs
```
Agents run with `--dangerously-skip-permissions` as root. Treat every
dispatched prompt as production input: no untrusted text pasted into tasks.

---

## PORTS ON THIS BOX (verified 2026-07-06 — re-verify with `ss -tlnp`)

Public (0.0.0.0):
- :22 sshd
- :80 / :443 — **Coolify's Traefik** (`coolify-proxy` container) — TLS front door for gluecron.com and other Coolify apps
- :6001/:6002 — Coolify realtime; :8000 — Coolify web UI; :8080 — Traefik (published by Coolify)
- :9206 — jarvis-dashboard (no auth — known debt, see below)
- :631 — cupsd (printing daemon; should not be public, known debt)

Loopback only:
- :4100 AlecRae API (bun) · :4200 AlecRae web (next)
- :5432 Postgres
- :9200–9205, :9207 Jarvis services

The old doctrine said Vapron owns 3000/3001/8090/9099 — **not true on this
box**. Vapron lives elsewhere; check `config/platforms.json` for servers.

---

## FILE STRUCTURE

```
jarvis-platform/
├── src/
│   ├── memory-server.js       — SQLite memory + REST API
│   ├── screenshot-service.js  — CDP screenshot capture
│   ├── metrics-collector.js   — server metrics + WebSocket
│   ├── slack-bridge.js        — Slack Socket Mode, intent routing (largest file)
│   ├── audit-runner.js        — build/test/screenshot audit loop
│   ├── orchestrator.js        — /dispatch API, spawns Claude agents, cron sprints
│   ├── dashboard-server.js    — public status panel + /screenshots browser
│   └── deploy-gate.js         — GateTest scan on every platform deploy
├── scripts/
│   ├── install.sh             — one-command server setup
│   ├── session-start.sh       — run at start of every Claude session
│   └── session-end.sh         — run at end of every Claude session
├── config/
│   ├── platforms.json         — THE platform registry (hot-reloaded)
│   ├── secrets.env            — real secrets (gitignored, lives only on box)
│   └── secrets.env.example    — env var template
├── systemd/                   — unit files for all eight services
├── memory/jarvis.db           — SQLite memory store (gitignored)
├── visual-baselines/          — screenshot baselines (gitignored, served at :9206/screenshots)
├── .ssh/orchestrator          — root SSH key for remote dispatch (gitignored — NEVER commit)
├── CLAUDE.md                  — this file (keep it true: Rule 0)
└── package.json
```

---

## SECRETS

Real secrets live in `/opt/jarvis/config/secrets.env` (gitignored).
Template: `config/secrets.env.example`. Never echo secret values into
logs, Slack, memory entries, or commit messages.

`.ssh/orchestrator` is a root private key used for remote dispatch.
It is gitignored. If `git status` ever shows it staged, stop everything.

---

## GOTCHAS (hard-won — read before debugging)

- **Coolify/Traefik two-network hang:** an app container attached to two
  Docker networks while Traefik only sits on `coolify` will HANG (gateway
  timeout, HTTP 000), not error. TLS completes, then silence. Fix: label
  `traefik.docker.network=coolify`, recreate only that service. Cost us
  gluecron.com downtime until 2026-07-06.
- **`gluecron-update.service`** (legacy auto-deploy timer, not Jarvis's)
  fails every 60s — its git remote lacks HTTPS creds. Log noise, not an
  outage. Fix or disable it, don't rediscover it.
- **detectIntent() is keyword matching**, not NLP. Slack phrasings that
  don't contain a known verb/platform substring fall through. Historical
  bugs: everything used to default-dispatch to vapron. When routing
  misbehaves, dry-run it: `curl 'http://127.0.0.1:9203/slack/test?text=...'`
- **Memory hygiene:** `repair_log` and `agent_context` tables exist but are
  empty — sessions skip the mid-session logging in the protocol below. The
  memory is only as smart as what gets written to it.

## KNOWN DEBT (current priorities — fix these, don't work around them)

1. jarvis-dashboard (:9206) is public with zero auth — needs a token gate
   or Traefik basic-auth + TLS.
2. cupsd exposed on 0.0.0.0:631 — disable or firewall.
3. Intent routing should be a cheap Claude (Haiku) classification call, not
   substring matching.
4. No external watcher: Jarvis monitors the platforms but nothing off-box
   monitors Jarvis. If this box dies, the reporter dies with it.
5. No scheduled backup of memory/jarvis.db.

---

## WHEN SOMETHING BREAKS

1. Check service status: `systemctl status jarvis-<name>`
2. Check logs: `journalctl -u jarvis-<name> -n 50`
3. Probe health endpoint: `curl http://127.0.0.1:<port>/health`
4. Never restart a service without reading its last 50 log lines first
5. If a service is down, read memory first — it may explain why
6. Web app hanging behind Traefik? Read Gotchas above before touching code.

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

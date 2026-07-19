# CLAUDE.md — Jarvis Platform
> Operating doctrine for every Claude Code session working on this repo.
> Read this entire file before touching any code.
> Last verified against the registry and implementation: 2026-07-17.

---

## WHAT JARVIS IS

Jarvis is the autonomous agent platform running on the Vultr box at
**66.42.121.161** (hostname `vultr`). It is NOT a product. It is the
infrastructure that watches, audits, and repairs Craig's platforms so they
stay healthy without human intervention.

Jarvis serves Craig Canty / MarcoReid Intelligence Systems.

Platforms Jarvis monitors (source of truth: `config/platforms.json` —
read it, don't trust this list). As of 2026-07-17 the registry contains 12:
zoobicon, vapron, bookaride, gatetest, alecrae, jarvis, voxlen, gluecron,
universal-ai-operator, marcoreid, davenroe, screenshot-to-code.
Notes:
- AlecRae **runs on THIS box** at `/opt/alecrae` (bun API :4100, Next.js
  :4200, user `alecrae`)
- Gluecron **runs on THIS box** as a Docker container behind
  Coolify/Traefik (see Gotchas below)
- GateTest has a local checkout at `/opt/gatetest`
- MarcoReid is registered as a Vercel-hosted platform; Jarvis monitors its
  live site and repo rather than a local checkout.

---

## THE ELEVEN SERVICES

| Service | File | Port | Bind | Purpose |
|---------|------|------|------|---------|
| jarvis-memory | src/memory-server.js | 9200 | loopback | Cross-session SQLite memory + notifications inbox + durable job queue + agent reports |
| jarvis-screenshot | src/screenshot-service.js | 9201 | loopback | CDP screenshot capture |
| jarvis-metrics | src/metrics-collector.js | 9202 | loopback | Real server metrics + WebSocket |
| jarvis-audit | src/audit-runner.js | 9204 | loopback | Build + test audit runner |
| jarvis-orchestrator | src/orchestrator.js | 9205 | loopback | Dispatch engine — durable job queue (SQLite `jobs` table via :9200) + scheduler tick; spawns Claude agents (local + SSH) via src/lib/spawn-agent.js |
| jarvis-dashboard | src/dashboard-server.js | 9206 | loopback, exposed ONLY via `tailscale serve --https=8445` | Status panel + screenshot browser; token = JARVIS_DASHBOARD_TOKEN in secrets.env, login once per device via `?token=` |
| jarvis-deploy-gate | src/deploy-gate.js | 9207 | loopback | GateTest scan gating platform deploys |
| jarvis-gateway | src/gateway-server.js | 9208 | loopback, exposed ONLY via `tailscale serve` (tailnet HTTPS) | **THE interface** — conversational voice/text control channel + notification inbox. Spec: docs/GATEWAY.md. Token = JARVIS_GATEWAY_TOKEN. |
| jarvis-agents | src/agent-scheduler.js | 9209 | loopback | **Agent-org scheduler** — dispatches role agents from config/agents.json on cron (budget-capped), routes agent reports up the escalation ladder (ok→inbox, action_needed→warn, escalate→alert). Kill switch: `AGENTS_MODE=off|dry-run|live` in the unit file. Registry + personas: config/agents.json, config/personas/, config/knowledge/. |
| jarvis-deck | src/deck-server.js | 9210 | loopback, exposed ONLY via `tailscale serve --https=8444` | **Command Deck v2.2** (2026-07-16, from Craig's Claude Design handoff) — public/command-deck.html: full-screen **CORE** 3D neural-core brain (default) + HUD/Hierarchy/Message Flow/Platforms tabs; PWA (deck.webmanifest + /icons/deck-*.png, source deck-icon.html); briefing panel (`{type:'briefing'}`); raw WS `/jarvis` = handoff contract v1.0 + `chat_chunk`/`notify`/`org`/`briefing`. All numbers real. Commands → the three-provider lib/agent.js brain with intent fallback; conversation in memory KV `deck-conversation`. Voice: wake word "Jarvis" (fuzzy), `GET /tts` = ElevenLabs via src/lib/tts.js (cache + daily budget + `TTS_DISABLED`), speechSynthesis fallback. QA hooks `?demo-alert=1`/`?demo-briefing=1` (:9201 virtual-time captures can't see live WS pushes). Evidence: docs/DECK-AUDIT-2026-07-16.md. Token = deck/gateway token or gateway cookie. |
| jarvis-browser | src/browser-service.js | 9211 | loopback | SSRF-guarded web search, fetch, and Chromium render bridge for the brain |

Health paths are namespaced for memory (`/memory/health`), screenshot
(`/screenshot/health`), metrics (`/metrics/health`), deploy-gate
(`/deploy-gate/health`), audit (`/audit/health`), and browser
(`/browser/health`). Agents, deck, dashboard, gateway, and orchestrator use
plain `/health`. Retired Slack code uses `/slack/health` when run.

**The brain runs on Craig's claude.ai SUBSCRIPTIONS, not metered APIs
(2026-07-19).** Provider `claude` = a persistent Claude Agent SDK session
(src/lib/brain-claude.js) billed to the subscription login; `BRAIN_PROVIDER=auto`
always prefers it. Model tiers: everyday **Sonnet 5**, voice-switchable to
Opus/Fable ("switch model to Fable"), with an automatic one-turn escalation
retry when a tier struggles. Tools + persona live in src/lib/brain-tools.js —
ONE surface shared by every provider. The metered APIs (openai `gpt-5.1`,
anthropic Messages, gemini) are EMERGENCY fallbacks only; any automatic
failover away from `claude` fires a spoken notify() — silent downgrades
(the 2026-07-18 Gemini incident) must never repeat.
**Two-account failover (src/lib/claude-auth.js):** subscription logins live at
`/root/.claude` (profile `default`) and `/root/.claude-profiles/<name>`
(`CLAUDE_CONFIG_DIR`; one-time `CLAUDE_CONFIG_DIR=<dir> claude login`). On a
usage-limit error the brain AND spawn-agent workers flip to the other login,
announce it, and retry once; when all accounts are exhausted work is held (not
failed) until the earliest reset. Durable state in memory KV
`claude-active-profile` / `claude-profile-exhausted:<name>`. Voice: "switch
account".
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

**Extension (2026-07-09):** `docs/ROADMAP.md`'s "THE 23 MOVES" list and
`config/roadmap.json` are twins — one prose, one machine-readable (powers the
Gateway's Roadmap checklist, `GET /api/roadmap`, and the voice "what's left"
intent). Whenever a move's status changes, update BOTH in the same commit.
When flipping a move to `done`, also fire a `notify()` (or `POST
/internal/notify`) announcing it — the whole point is a live, spoken signal
of progress, not a file nobody reads.

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

**Rendered UI is proven by LOOKING at it, nothing else (added 2026-07-10 after
the Gateway avatar debacle).** Any change to anything a human sees — HTML,
CSS, frontend JS, layouts — MUST be screenshot-captured
(`POST http://127.0.0.1:9201/screenshot/capture`) and visually inspected
BEFORE telling Craig it's done. HTTP 200s, syntax checks, and "the code looks
right" are not proof for pixels. Five visual iterations shipped unverified
cost a full day and Craig's trust. Never again.

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
Jarvis owns ports 9200–9211 and nothing else. Before binding any port,
check `ss -tlnp`. Do not modify co-tenant config from this repo.

### Rule 5 — No competitor dependencies
No Playwright. No Puppeteer. No Vercel SDK. No Cloudflare SDK.
Screenshots use raw Chromium CDP only.
If you need browser automation, extend src/screenshot-service.js.

---

## ARCHITECTURE

```
Craig (voice/text, iPad/phone — tailnet) ──► https://jarvis.tailbd6217.ts.net:8443
        ↓ tailscale serve
jarvis-gateway (9208) ── lib/conversation.js ──→ jarvis-orchestrator (9205)
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

Loopback only:
- :3000 gatetest-web (binds 10.0.1.1, coolify bridge — Traefik fronts gatetest.ai)
- :4100 AlecRae API (bun) · :4200 AlecRae web (next)
- :5432 Postgres
- :9200–9202, :9204–9207 Jarvis services
- :9208 jarvis-gateway — loopback + `tailscale serve --https=8443` (tailnet-only HTTPS; never expose publicly)
- :9209 jarvis-agents · :9210 jarvis-deck · :9211 jarvis-browser — loopback; deck is also on `tailscale serve --https=8444`
- :9206 jarvis-dashboard — loopback + `tailscale serve --https=8445` (tailnet-only, same rule as deck and gateway)

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
│   ├── dashboard-server.js    — tailnet status panel + /screenshots browser
│   ├── deploy-gate.js         — GateTest scan on every platform deploy
│   └── browser-service.js     — guarded web search/fetch/render bridge
├── scripts/
│   ├── install.sh             — one-command server setup
│   ├── session-start.sh       — run at start of every Claude session
│   └── session-end.sh         — run at end of every Claude session
├── config/
│   ├── platforms.json         — THE platform registry (hot-reloaded)
│   ├── secrets.env            — real secrets (gitignored, lives only on box)
│   └── secrets.env.example    — env var template
├── systemd/                   — unit files for Jarvis services
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

- **`tailscale serve` CANNOT use port 443 on this box.** Coolify's Traefik
  (`docker-proxy`) already binds `0.0.0.0:443`, which blocks tailscaled from
  getting its own listener on the tailscale IP — fails silently with
  `tailscale serve status` still showing the config as "active" while every
  real request 503s with "no available server". Confirmed 2026-07-09
  (`journalctl -u tailscaled` showed repeated `bind: address already in use`).
  **The Gateway serves on `--https=8443` instead** (`https://jarvis.tailbd6217.ts.net:8443`)
  — do not fight Traefik for :443 (Rule 4: never touch co-tenant config).
  **Lesson: `tailscale serve status` reporting a route is not proof it works —
  always confirm with a real `curl .../health` returning 200, per Rule 2.**
- **Gateway voice needs the https `.ts.net` name, never a raw IP:** iOS Safari
  grants microphone/speech-recognition only in secure contexts. `tailscale
  serve` provides the cert; `http://100.x.y.z:9208` can never do STT. Also:
  iOS `speechSynthesis` must be primed by a user gesture (gateway.html does
  this on the first mic tap) or replies stay silent.
- **Tailscale on this box runs `--accept-dns=false`** so resolv.conf is
  untouched (co-tenant safety). Only Craig's devices need MagicDNS names.
  UFW has `allow in on tailscale0`; the tailnet is invisible publicly.
- **Coolify/Traefik two-network hang:** an app container attached to two
  Docker networks while Traefik only sits on `coolify` will HANG (gateway
  timeout, HTTP 000), not error. TLS completes, then silence. Fix: label
  `traefik.docker.network=coolify`, recreate only that service. Cost us
  gluecron.com downtime until 2026-07-06.
- **`gluecron-update.timer`** (legacy auto-deploy, not Jarvis's) was
  disabled 2026-07-06 after failing every 60s for days (git remote had no
  creds; Coolify owns the gluecron deploy now). The cups snap was disabled
  the same day (it exposed cupsd publicly on :631). Don't re-enable either
  without a reason.
- **Retired Slack intent routing was two-tier**: keyword fast-path for confident
  short commands, Haiku CLI classification (~3-10s) for ambiguous natural
  phrasing, silent keyword fallback on any classifier failure. Debug with
  `curl 'http://127.0.0.1:9203/slack/test?text=...'` — it returns
  {keyword, haiku, chosen, haiku_ms}. Haiku can only route to platforms
  present in platforms.json.
- **Memory hygiene:** `repair_log` table exists but is mostly empty — sessions
  skip the mid-session logging in the protocol below. The memory is only as
  smart as what gets written to it.
- **Jobs are durable (2026-07-15):** orchestrator jobs live in the SQLite
  `jobs` + `job_transitions` tables (memory :9200 `/memory/jobs*`), NOT in
  process memory. A restart re-queues interrupted jobs automatically (one
  retry, `max_attempts=2`). Debug a "silent" job with
  `curl -s http://127.0.0.1:9200/memory/jobs/<id> | jq .transitions`.
- **Worker spawns go through `src/lib/spawn-agent.js` ONLY.** It centralizes
  `IS_SANDBOX=1` (claude ≥2.1.207 refuses skip-permissions as root without
  it), `DISABLE_AUTOUPDATER=1`, timeout kill timers, and it STRIPS
  `ANTHROPIC_API_KEY` from worker envs — CLI workers must bill the flat-rate
  claude.ai subscription, never the metered key (that key is only for the
  gateway's Messages-API brain). Never add a raw `spawn('claude', ...)`
  anywhere else.
- **Canary gate:** when the installed claude CLI version differs from
  `agent_context.claude_verified_version`, the scheduler runs a CANARY-OK
  probe before starting ANY job. If it fails, dispatch is HELD (jobs stay
  queued, alert notification fires, retry every 30 min) — a CLI regression
  can no longer silently kill the fleet. Check `curl :9205/health | jq
  .canaryHeld`.

## KNOWN DEBT (current priorities — fix these, don't work around them)

1. Haiku intent classification runs via CLI cold-start (~3-10s per
   ambiguous message). An ANTHROPIC_API_KEY in secrets.env + switching
   classifyIntent to the HTTP Messages API would cut that to ~300ms.
2. Orchestrator still runs agents as root with
   --dangerously-skip-permissions; migrate to the Claude Agent SDK with
   scoped permissions.

Cleared 2026-07-06: dashboard auth (was #1), cupsd exposure (was #2),
keyword-only intents (was #3), no DB backups (was #5) — see git log.

---

## WHEN SOMETHING BREAKS

1. Check service status: `systemctl status jarvis-<name>`
2. Check logs: `journalctl -u jarvis-<name> -n 50`
3. Probe the service's documented health path (for example,
   `curl http://127.0.0.1:9200/memory/health`; plain `/health` is not universal)
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

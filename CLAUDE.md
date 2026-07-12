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
read it, don't trust this list). As of 2026-07-12 the registry contains:
zoobicon, vapron, bookaride, gatetest, alecrae, jarvis, voxlen, gluecron,
universal-ai-operator, marcoreid, davenroe, screenshot-to-code.
Notes:
- AlecRae **runs on THIS box** at `/opt/alecrae` (bun API :4100, Next.js
  :4200, user `alecrae`)
- Gluecron **runs on THIS box** as a Docker container behind
  Coolify/Traefik (see Gotchas below)
- GateTest has a local checkout at `/opt/gatetest`
- The eSIM MVNO is talked about but NOT yet in the registry — Haiku
  intent routing can't target a platform that isn't registered. Add it
  when it's real. (MarcoReid was registered 2026-07-08.)

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
| jarvis-dashboard | src/dashboard-server.js | 9206 | 0.0.0.0 + token auth | Status panel + screenshot browser; token = JARVIS_DASHBOARD_TOKEN in secrets.env, login once per device via `?token=` |
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
- :9206 — jarvis-dashboard (token auth; `/health` open for off-box watcher)

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
- **`gluecron-update.timer`** (legacy auto-deploy, not Jarvis's) was
  disabled 2026-07-06 after failing every 60s for days (git remote had no
  creds; Coolify owns the gluecron deploy now). The cups snap was disabled
  the same day (it exposed cupsd publicly on :631). Don't re-enable either
  without a reason.
- **Slack intent routing is two-tier**: keyword fast-path (src/intent.js —
  pure functions, unit-tested in test/) for confident commands, Haiku
  classification for ambiguous natural phrasing, silent keyword fallback on
  any classifier failure. Haiku uses the HTTP Messages API (~300ms) when
  ANTHROPIC_API_KEY is set in secrets.env, else the local `claude` CLI
  (~3-10s cold start). Debug with
  `curl 'http://127.0.0.1:9203/slack/test?text=...'` — it returns
  {keyword, normalized, haiku, chosen, haiku_ms}. Haiku can only route to
  platforms present in platforms.json. "hey jarvis" address prefixes and
  polite lead-ins ("can you", "please") are stripped BEFORE matching, so
  addressing the bot no longer routes to the `jarvis` platform. Unclear
  messages get a "didn't catch that" reply — they are NEVER auto-dispatched
  to the orchestrator (the old passthrough fallback caused spurious agent
  runs and "Which platform?" spam).
- **All unsolicited Slack notifications go through the NotifyCenter**
  (src/notify-center.js; state persisted at memory/notify-state.json).
  Levels: critical (immediate, bypasses quiet hours/mute), warning
  (immediate but deduped + rate-limited), info (batched into a periodic
  digest). Backstop: max N immediate posts/hour, overflow demotes to the
  digest. Quiet hours 22:00–07:00 NZ hold non-critical. Craig controls it
  from Slack: `mute`, `mute 2h`, `mute all`, `unmute`, `digest`,
  `notifications`. Services posting to :9203 pass {level, key};
  /slack/send defaults to "warning", /slack/report levels itself from
  audit status (healthy → digest only). Replies to Craig's own commands
  bypass all of this by design — mute never mutes answers. Tuning vars in
  secrets.env.example. If Slack floods again, find the caller posting
  with level=critical or a constantly-changing dedupe key.
- **Memory hygiene:** `repair_log` and `agent_context` tables exist but are
  empty — sessions skip the mid-session logging in the protocol below. The
  memory is only as smart as what gets written to it.

## KNOWN DEBT (current priorities — fix these, don't work around them)

1. No external watcher: Jarvis monitors the platforms but nothing off-box
   monitors Jarvis. If this box dies, the reporter dies with it.
   (`:9206/health` is intentionally unauthenticated for this purpose.)
2. ANTHROPIC_API_KEY not yet set in secrets.env on the box — the fast
   HTTP classifier path shipped 2026-07-12 but stays dormant until the
   key is added (falls back to the 3-10s CLI meanwhile). Add the key,
   `systemctl restart jarvis-slack`, verify with /slack/health
   (classifier should read "http-api").
3. Orchestrator still runs agents as root with
   --dangerously-skip-permissions; migrate to the Claude Agent SDK with
   scoped permissions.
4. eSIM MVNO not in platforms.json (see WHAT JARVIS IS).
5. audit-runner's PLATFORM_CONFIG only covers 4 of the 12 registered
   platforms — the daily sprint now skips the rest silently (logged, not
   Slacked). Add PLATFORM_CONFIG entries for platforms that should be
   audited.

Cleared 2026-07-06: dashboard auth, cupsd exposure, keyword-only intents,
no DB backups. Cleared 2026-07-12: Slack notification firehose (NotifyCenter:
digest/mute/rate-limit) and misrouted Slack commands (src/intent.js rewrite)
— see git log.

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

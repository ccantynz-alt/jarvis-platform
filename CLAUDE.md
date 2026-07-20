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
| jarvis-agents | src/agent-scheduler.js | 9209 | loopback | **Agent-org scheduler** — dispatches role agents from config/agents.json on cron (budget-capped), routes agent reports up the escalation ladder (ok→inbox, action_needed→warn, escalate→alert). **44 agents** (2026-07-19): CEO (resident) → real C-suite (cto/cmo/cfo/clo/coo/cro, weekly roll-ups, `reports_to` actually routes through them) → 9 social-media + 9 seo-specialist + 9 site-medic (per-platform) + 5 accountant + 5 legal (per-jurisdiction). Kill switch: `AGENTS_MODE=off|dry-run|live` in the unit file (**`live` as of 2026-07-19**, Craig's go-ahead). Registry + personas: config/agents.json, config/personas/, config/knowledge/. |
| jarvis-deck | src/deck-server.js | 9210 | loopback, exposed ONLY via `tailscale serve --https=8444` | **Command Deck v2.2** (2026-07-16, from Craig's Claude Design handoff) — public/command-deck.html: full-screen **CORE** 3D neural-core brain (default) + HUD/Hierarchy/Message Flow/Platforms tabs; PWA (deck.webmanifest + /icons/deck-*.png, source deck-icon.html); briefing panel (`{type:'briefing'}`); raw WS `/jarvis` = handoff contract v1.0 + `chat_chunk`/`notify`/`org`/`briefing`. All numbers real. Commands → the three-provider lib/agent.js brain with intent fallback; conversation in memory KV `deck-conversation`. Voice: wake word "Jarvis" (fuzzy), `GET /tts` = ElevenLabs via src/lib/tts.js (cache + daily budget + `TTS_DISABLED`), speechSynthesis fallback. QA hooks `?demo-alert=1`/`?demo-briefing=1` (:9201 virtual-time captures can't see live WS pushes); `?view=hud\|org\|flow\|plat` deep-links a tab for screenshots (Hierarchy tab is `org`) — the org tier now renders real agent-org data, see jarvis-agents row. Evidence: docs/DECK-AUDIT-2026-07-16.md. Token = deck/gateway token or gateway cookie. |
| jarvis-browser | src/browser-service.js | 9211 | loopback | SSRF-guarded web search, fetch, and Chromium render bridge for the brain |

Health paths are namespaced for memory (`/memory/health`), screenshot
(`/screenshot/health`), metrics (`/metrics/health`), deploy-gate
(`/deploy-gate/health`), audit (`/audit/health`), and browser
(`/browser/health`). Agents, deck, dashboard, gateway, and orchestrator use
plain `/health`. Slack (`slack-bridge.js`, :9203) is frozen-legacy but
**still actively used** — a 2026-07-20 correction to docs/ROADMAP.md's
decisions-locked table found the earlier "retired 2026-07-15" claim was
wrong (never touch/delete this file on the strength of that claim). Uses
`/slack/health`.

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

**PC worker (2026-07-19):** Craig's own Windows machine is a pull-based
worker node — `src/pc-worker.js` (Task Scheduler job `JarvisPcWorker`) polls
`POST /worker/claim` on the gateway (own scoped `JARVIS_WORKER_TOKEN`, never
the gateway/deck login), runs `claude --print` on the PC's own subscription
login, and reports back via `/worker/result`. Registry entry `craig-pc`
(`config/platforms.json`, `executor:"pc"`) routes jobs there via
`src/executors.js`; the orchestrator's scheduler never starts them itself —
only the worker's own claim does, and an expired lease (worker asleep/
offline) re-queues automatically. Excluded from the daily audit sprint (no
repo, no build). Kill switches: memory KV `pc-worker-enabled`, local
`%ProgramData%\jarvis\KILL` file, or revoke the token.

**Second box, 158 (Vapron, 149.28.119.158 / `vapron-158.tailbd6217.ts.net`):**
on the tailnet, health exposed tailnet-only (`tailscale serve --https=8443`
→ Vapron's ops-agent `:9095/health`), and `jarvis-heartbeat.timer` (NOT
Jarvis code — a standalone script on 158 per the estate doctrine) posts every
5 min to the gateway's `/internal/heartbeat` on a scoped
`JARVIS_HEARTBEAT_TOKEN_vapron158` (never the master gateway token). >15 min
silence raises a spoken + inbox alert automatically. A leftover, non-running
`jarvis-platform` git clone from June 29 was found at `/opt/jarvis` on 158
during this — it holds a `secrets.env` and should be deleted by Craig
(estate doctrine: no Jarvis code on 158).

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
Jarvis owns ports 9200–9212 and nothing else. Before binding any port,
check `ss -tlnp`. Do not modify co-tenant config from this repo.

### Rule 5 — No competitor dependencies
No Playwright. No Puppeteer. No Vercel SDK. No Cloudflare SDK.
Screenshots use raw Chromium CDP only.
If you need browser automation, extend src/screenshot-service.js.

**Documented, narrow exception (2026-07-20):** `src/browser-service.js`
imports `playwright-core` (not full `playwright` — no bundled browser
download, drives the box's own system Chrome via `executablePath`) for its
`/browser/render` endpoint. This was found to violate the letter of this
rule during a leanness/reliability pass. It was NOT rewritten to raw CDP
because `screenshot-service.js`'s existing approach (spawning Chromium with
`--headless=new --screenshot=...` CLI flags, no DevTools protocol
connection at all) is architecturally insufficient for what render needs:
DOM text/title/link extraction (`Runtime.evaluate`-equivalent) and
per-sub-request SSRF blocking (`Network`/`Fetch`-domain interception)
require genuine CDP WebSocket scripting — essentially reimplementing
Playwright's automation layer by hand, untested, in a security-sensitive
SSRF-guard code path. That risk (a real SSRF regression) was judged worse
than the doctrine inconsistency. If someone wants to close this gap
properly: write raw CDP session handling (Network.setRequestInterception
or the Fetch domain) into browser-service.js or a shared lib, test it
against real outbound requests to private IPs before trusting it, then
remove this exception.

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
- :9212 — jarvis-dashboard's public liveness ping (2026-07-19). ONE route
  (`GET /health` → `{"status":"ok"}`), plain `http.createServer`, no express,
  no auth surface, no other route ever. The July 18 hardening session moved
  the real dashboard (:9206, job-dispatch WS + API) to loopback-only —
  correct, that's a real control surface — but silently killed the public
  `:9206/health` signal that the off-box watcher (docs/OFF-BOX-WATCHDOG.md —
  not tied to any specific KNOWN DEBT # or roadmap move #, an earlier
  revision of this file mislabeled it as both) depends on. This port exists
  ONLY to restore that liveness signal.
  If you ever need more than a static "ok" here, that's a sign to build a
  proper endpoint elsewhere, not extend this one.

Loopback only:
- :3000 gatetest-web (binds 10.0.1.1, coolify bridge — Traefik fronts gatetest.ai)
- :4100 AlecRae API (bun) · :4200 AlecRae web (next)
- :5432 Postgres
- :9200–9202, :9204–9207 Jarvis services
- :9208 jarvis-gateway — loopback + `tailscale serve --https=8443` (tailnet-only HTTPS; never expose publicly)
- :9209 jarvis-agents · :9210 jarvis-deck · :9211 jarvis-browser — loopback; deck is also on `tailscale serve --https=8444`
- :9206 jarvis-dashboard — loopback + `tailscale serve --https=8445` (tailnet-only, same rule as deck and gateway). Its `/health` is NOT public despite an old comment claiming otherwise — see :9212 above for the actual public liveness ping.

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
│   ├── slack-bridge.js        — frozen-legacy Slack transport, still active (see Rule 0 note above)
│   ├── notify-center.js       — severity levels/dedupe/digest gate for unsolicited Slack notifications
│   ├── intent.js              — Slack's own keyword-tier intent classifier (unit-tested)
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

1. **No external watcher — STILL NOT ACTUALLY TRUSTED, despite two separate
   redesign attempts on 2026-07-20.** Full messy history in
   docs/OFF-BOX-WATCHDOG.md, but the short version: two different Claude
   Code sessions worked on this in parallel without knowing about each
   other, reached different root-cause theories, and neither could fully
   verify their fix from inside the constrained tool. Session A found the
   symptom (any 2nd tool-call step in a CCR run silently fails) and
   rebuilt the routine as one single Bash call posting to ntfy.sh — but
   only tested delivery from an interactive session, not the actual
   unattended CCR sandbox. Session B independently found what looks like
   the deeper cause: CCR sandboxes egress through an allowlisting proxy
   that rejects `ntfy.sh` outright (403) and may block the raw `:9212`
   health check too — meaning session A's "verified" fix may not actually
   work in production. Session B's real fix (join the tailnet from the
   routine itself, hit the gateway's `/internal/notify` instead of ntfy)
   needs two Craig-only prerequisites neither session could do: allowlist
   `*.tailscale.com` + `pkgs.tailscale.com` in the cloud environment's
   network policy, and add an ephemeral tagged `TS_AUTHKEY`. Until those
   land, don't trust ANY cloud-routine watchdog design, and don't spin up
   yet another redesign attempt without those prerequisites in place first
   — that's how this got to two contradictory "fixes" already.
2. ANTHROPIC_API_KEY not yet set in secrets.env on the box — the fast
   HTTP classifier path shipped 2026-07-12 but stays dormant until the
   key is added (falls back to the 3-10s CLI meanwhile). Add the key,
   `systemctl restart jarvis-slack`, verify with /slack/health
   (classifier should read "http-api"). (A second, separate fast-path for
   the Gateway/voice brain's own classifier — src/lib/conversation.js,
   unrelated code path — shipped 2026-07-20 and has the same "needs the
   key added" caveat.)
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
Cleared 2026-07-19: resource guards / pre-OOM alerting (metrics-collector.js).
Cleared 2026-07-20 (code side, Gateway/voice path only): Haiku intent
classification's ~3-10s CLI cold-start in `classifyIntent`
(src/lib/conversation.js) now tries the HTTP Messages API first (~300ms),
falling back to the CLI path if `ANTHROPIC_API_KEY` is unset or the HTTP
call fails. **Craig still needs to add `ANTHROPIC_API_KEY` to
`/opt/jarvis/config/secrets.env`** for the speed-up to take effect — until
then this silently keeps using the CLI path as before, correctly, just
without the win. (The Slack bridge's own classifier fast-path, KNOWN DEBT
#2 above, is a separate, earlier piece of code needing the same key.)
NOT cleared, despite an earlier claim in this file to the contrary: no
external watcher — see KNOWN DEBT #1 above, this is still actively broken
and being fought over by two uncoordinated redesign attempts.

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

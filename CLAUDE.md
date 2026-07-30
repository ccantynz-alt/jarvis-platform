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
| jarvis-metrics | src/metrics-collector.js | 9202 | loopback | Real server metrics + WebSocket + **the only thing that alerts when a Jarvis service itself dies** (2026-07-30). Probes all 12 ports every 30s (ONE `ss` call, not one per port) and reports a dead service via `notify()`. "The port isn't answering" is FOUR situations and they get different treatment — see `src/lib/service-verdict.js`: `restarting` (systemd activating/deactivating) is silent and accumulates no strike; `failed` (ActiveState=failed) alerts on the FIRST probe, since systemd has already given up; `stopped` (inactive, deliberate) is `warn` after ~2 min, so a deploy gap passes in silence; `notlistening` (systemd says running, port disagrees — the dangerous one) alerts after ~60s. Those numbers exist because the first version paged Craig for a 50-second deploy restart of mine. |
| jarvis-audit | src/audit-runner.js | 9204 | loopback | Build + test audit runner |
| jarvis-orchestrator | src/orchestrator.js | 9205 | loopback | Dispatch engine — durable job queue (SQLite `jobs` table via :9200) + scheduler tick; spawns Claude agents (local + SSH) via src/lib/spawn-agent.js |
| jarvis-dashboard | src/dashboard-server.js | 9206 | loopback, exposed ONLY via `tailscale serve --https=8445` | Status panel + screenshot browser; token = JARVIS_DASHBOARD_TOKEN in secrets.env, login once per device via `?token=` |
| jarvis-deploy-gate | src/deploy-gate.js | 9207 | loopback | GateTest scan gating platform deploys |
| jarvis-gateway | src/gateway-server.js | 9208 | loopback, exposed ONLY via `tailscale serve` (tailnet HTTPS) | **THE interface** — conversational voice/text control channel + notification inbox. Spec: docs/GATEWAY.md. Token = JARVIS_GATEWAY_TOKEN. |
| jarvis-agents | src/agent-scheduler.js | 9209 | loopback | **Agent-org scheduler** — dispatches role agents from config/agents.json on cron (budget-capped), routes agent reports up the escalation ladder (ok→inbox, action_needed→warn, escalate→alert). **44 agents** (2026-07-19): CEO (resident) → real C-suite (cto/cmo/cfo/clo/coo/cro, weekly roll-ups, `reports_to` actually routes through them) → 9 social-media + 9 seo-specialist + 9 site-medic (per-platform) + 5 accountant + 5 legal (per-jurisdiction). Kill switch: `AGENTS_MODE=off|dry-run|live` in the unit file (**`live` as of 2026-07-19**, Craig's go-ahead). Registry + personas: config/agents.json, config/personas/, config/knowledge/. |
| jarvis-deck | src/deck-server.js | 9210 | loopback, exposed ONLY via `tailscale serve --https=8444` | **Command Deck v2.2** (2026-07-16, from Craig's Claude Design handoff) — public/command-deck.html: full-screen **CORE** 3D neural-core brain (default) + HUD/Hierarchy/Message Flow/Platforms tabs; PWA (deck.webmanifest + /icons/deck-*.png, source deck-icon.html); briefing panel (`{type:'briefing'}`); raw WS `/jarvis` = handoff contract v1.0 + `chat_chunk`/`notify`/`org`/`briefing`. All numbers real. Commands → the three-provider lib/agent.js brain with intent fallback; conversation in memory KV `deck-conversation`. Voice: wake word "Jarvis" (fuzzy), `GET /tts` = ElevenLabs via src/lib/tts.js (cache + daily budget + `TTS_DISABLED`), speechSynthesis fallback. QA hooks `?demo-alert=1`/`?demo-briefing=1` (:9201 virtual-time captures can't see live WS pushes); `?view=hud\|org\|flow\|plat` deep-links a tab for screenshots (Hierarchy tab is `org`) — the org tier now renders real agent-org data, see jarvis-agents row. Evidence: docs/DECK-AUDIT-2026-07-16.md. Token = deck/gateway token or gateway cookie. |
| jarvis-browser | src/browser-service.js | 9211 | loopback | SSRF-guarded web search, fetch, and Chromium render bridge for the brain |

**FIVE periodic timers, NOT persistent daemons (documented 2026-07-24, found
late — see Rule 0 note below; corrected from "three" on 2026-07-30 when
`systemctl list-timers "jarvis-*"` turned out to list two more than this file
did). Trust that command, not this list:**
- **`scripts/fleet-check.sh`** — `jarvis-fleet-check.timer`, every 10 min.
  Cheap HTTP status probe of every platform's public URL, writes
  `status`/`health_score` to `platform_state` via `/memory/platform/update`.
  2+ consecutive misses → `status=error`. Also tracks flap history per
  platform (oscillating healthy/error) separately from steady downtime.
  **`TimeoutStartSec=600` was added 2026-07-30** — `Type=oneshot` DISABLES the
  start timeout by default, and the memory write had no `--max-time`, so a
  stalled memory-server could hang the run forever; systemd then skips every
  timer activation while the unit sits in `activating`. Since this is what
  notices a platform is down, and self-heal only ever acts on the status it
  writes, the whole detect-and-repair chain would have gone quiet with every
  service still showing green. If you add another `oneshot` unit here, set the
  timeout explicitly — the default is not a default.
- **`src/self-heal.js`** — `jarvis-self-heal.timer`, every 5 min (per
  `config/self-heal.env`, reconstructed 2026-07-24). Watches for
  `platform_state.status === 'error'` (fleet-check's signal) and
  **auto-dispatches a repair agent** through the orchestrator once a site's
  been down ≥ `SELF_HEAL_DOWN_MINUTES` (debounce), gated by a cooldown,
  a daily-attempts cap, a fleet-wide concurrency cap, and (2026-07-24) a
  check that no OTHER job (including audit-runner's or deploy-gate's own
  auto-fix-dispatch, which watch different signals) is already in flight
  for that platform. **`SELF_HEAL_MODE=live` is currently set** —
  `config/self-heal.env`'s own comments reference a real incident
  (2026-07-17: 117 dispatches in a day against a cap of 6, caused by
  systemd `EnvironmentFile` not stripping inline comments off numeric
  guardrail values) — treat this as **already running live in production**,
  not a dormant/experimental system.
  **DNS pre-check (2026-07-30):** before dispatching, self-heal resolves the
  platform's hostname. `nxdomain` → alert Craig, count the attempt, dispatch
  NOTHING (a name that does not exist cannot be repaired from this box);
  `unresolvable` (EAI_AGAIN/timeout — our resolver, not their domain) → wait for
  the next tick without counting an attempt. This came from gatetest.ai expiring
  into .ai redemption on 2026-07-29: self-heal spent SIX repair agents in one
  day, twelve runs in total, each correctly concluding "registry-level, nothing
  to do here" after minutes of a full-permission agent's time, while Next.js
  answered 200 on 10.0.1.1:3000 throughout.
  **The daily cap is now actually daily (2026-07-30).** `rollDay()` owns the
  rollover for BOTH the down-path and the recovered-platform loop, and derives
  the reset from `lastAttempt` rather than the stored `day` — which was
  re-stamped every tick and so carried no history. Before this, the
  recovered-platform loop wrote `day: today()` while carrying yesterday's count
  forward, so the reset could never fire and one bad day disabled a platform's
  autonomous repair PERMANENTLY. It was live: bookaride claimed "1 attempt
  today" for an attempt made 2026-07-12, gluecron the 14th, zoobicon the 13th,
  and gatetest sat at 5 of 6.
  **Rule 0 note:** `jarvis-self-heal.service`/`.timer` were missing from
  this repo's `systemd/` folder entirely until 2026-07-24 — the exact same
  gap `jarvis-browser.service` had (a real unit that exists only on the
  box, never committed). The versions now in `systemd/` are a best-effort
  reconstruction from the fleet-check.sh pattern + self-heal.env's own
  references, not a copy of the box's real file — verify with `diff
  /etc/systemd/system/jarvis-self-heal.* /opt/jarvis/systemd/jarvis-self-heal.*`
  before trusting it matches exactly (see docs on the browser-service
  discovery for why this check matters).
- **`src/code-health.js`** — `jarvis-code-health.timer`, every 3 hours
  (`config/code-health.env`). **The only thing on this box that looks for
  CODE defects rather than dead ports** (Craig, 2026-07-30: "not just
  finding HTTP problems but actually coding issues regardless of how deep
  they go"). One sweep = the least-recently-swept local platform × one of
  nine rotating review lenses (failure paths, data integrity, input trust,
  auth, concurrency, money paths, integrations, config/deploy, recent
  commits) → ONE read-only review agent → an **adversarial verifier** on
  anything critical/high/security/data-loss → upsert into the new
  `code_findings` table by fingerprint. `dismissed` is sticky, severity only
  escalates, and a `fixed` finding that reappears is reopened as a
  regression. **It fixes nothing** — findings become work only through the
  dispatch confirmation gate, and the brain reads them via
  `get_code_findings`. **`CODE_HEALTH_MODE=live` since 2026-07-30** — shipped
  dry-run, flipped after two sweeps were run by hand and their findings read
  against the actual code (7 real defects in Jarvis itself, all fixed that day;
  3 adversarially-confirmed highs in AlecRae's mail stack). Findings record the
  `commit_sha` they were found in, because a local checkout can be behind its
  remote (/opt/alecrae was 28 commits behind during the first live sweep) and a
  real finding there may already be fixed upstream. Spec:
  **docs/CODE-HEALTH.md**; pure logic + tests: `src/lib/findings.js`,
  `test/findings.test.js`.
  **A path existing is not the same as code being there (2026-07-30).** The timer
  picked `zoobicon` at `/root/zoobicon` — a directory holding only a `.claude`
  folder — spent a review agent, returned 0 findings in 25s, and recorded the
  platform as SWEPT with a 20-hour cooldown, so the flagship read as reviewed
  having never been read. `eligiblePlatforms()` now also requires
  `hasSource(path)` (`src/lib/checkout.js`) and logs the skip. Note that is a
  DIFFERENT test from the audit runner's `checkoutProblem()`: "is there code to
  read" (any source file, 2 levels deep) versus "could this be built" (a
  manifest). universal-ai-operator is loose Python with no manifest — reviewable,
  not buildable — and getting those backwards silently drops a platform from one
  system or the other.
- **`scripts/backup-memory.sh`** — `jarvis-backup.timer`, daily 03:30 UTC.
  SQLite memory-store backup (the "no DB backups" debt cleared 2026-07-06).
- **`scripts/pull-vapron-backup.sh`** — `jarvis-vapron-backup.timer`, daily
  04:17 UTC. Pulls and verifies an off-box copy of box 158's Vapron database
  onto this box. **Rule 0 note (2026-07-30):** the script was committed but
  BOTH its units existed only in `/etc/systemd/system` — enabled, active, and
  running daily — for the third occurrence of exactly the gap already recorded
  for `jarvis-browser.service` and `jarvis-self-heal.service`. Now in
  `systemd/`. When you write a unit during an incident, copy it back the same
  hour or nobody will know it exists.

**The unit files in `systemd/` were not the deployed config either** (found
2026-07-30 by the code-health spine's config/deploy lens). Eleven drop-in
directories under `/etc/systemd/system/jarvis-*.service.d/` overrode
`MemoryMax` on ten services, so reading a unit gave you a limit that had not
applied since 17 July — the orchestrator's real ceiling was 3G, not the 2048M
the unit claimed; the dashboard's was 256M, not 512M. The drop-ins are now in
`systemd/dropins/` and the units carry matching numbers, but **a drop-in still
wins**: verify with `systemctl show <svc> -p MemoryMax`, never by reading a
unit. See `systemd/dropins/README.md`, which also documents three
`codex-env.conf` drop-ins setting `CODEX_MODEL`/`CODEX_EFFORT` — variables that
appear nowhere in this repo and are awaiting Craig's decision to delete.

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
always prefers it. **Model tiers (Craig's ruling 2026-07-26): Opus 5 and Fable
5 ONLY** — everyday **Opus 5**, with Fable 5 as the voice-selectable heavy tier
("switch model to Fable") and the automatic one-turn escalation when a turn
fails for a non-limit, non-timeout reason. **A heavier tier changes the
TIMEOUTS that fit it — move them in the same commit (2026-07-28).** The 12s
warm first-token watchdog was tuned on 2026-07-24 against `claude-sonnet-5`;
`7e1c7b9` made the everyday tier Opus 5 two days later and left the watchdog
alone, so healthy-but-heavier turns were being shot at 12s (seen live on the
box 2026-07-28 20:33). It is now 20s, and a watchdog trip classifies as
`kind:'timeout'` and retries the SAME tier with the cold-spawn allowance
rather than escalating — escalation answers "too slow" with something slower
and spends the subscription window doing it. Sonnet is no longer a tier (a stale
`brain-claude-model` KV naming it is ignored and falls back to Opus 5), and
the previous-generation `claude-opus-4-8` is retired. Note the interaction
with the subscription-only rule below: heavy tiers burn the usage windows
faster and there is no metered fallback, so two-account failover
(claude-auth.js) + the total-outage alert are what keep that safe. Tools + persona live in src/lib/brain-tools.js —
ONE surface shared by every provider.

**A model-ID change in code can outrun the `claude` binary on the box — check
the CLI version whenever tiers move (2026-07-28).** Every Jarvis spawn sets
`DISABLE_AUTOUPDATER=1` (spawn-agent.js, brain-claude.js) by design, so the
CLI only moves when a human moves it. A binary that predates a tier rejects it
with `There's an issue with the selected model (<id>). It may not exist or you
may not have access to it.` Because metered fallback is off, ONE unknown model
ID takes the whole brain down: Opus 5 rejected → escalate → Fable 5 rejected →
runAgent finds no other provider → deck/gateway degrade to the keyword-intent
pipeline for **every** turn. That reads to Craig as three separate faults —
"it keeps breaking", "it has no memory" (the keyword pipeline has no
conversational memory), "it keeps narrating problems" — from a single stale
binary. `classifyFailure` now returns `kind:'model'` for this and
`reportModelRejected()` names it out loud instead of letting it wear an
outage's clothes. First check when the brain is dead across the board:
`claude --version` on the box, then `claude --model claude-opus-5 --print hi`.

**SUBSCRIPTION-ONLY — metered APIs are OFF by default (Craig's ruling,
2026-07-26: "sometimes we can't get an eye on API fallback so probably best
not to have it").** The metered providers (openai `gpt-5.1`, anthropic
Messages, gemini) are gated behind `BRAIN_ALLOW_METERED=1`, default unset.
While off, `keyFor()` reports them keyless, which removes them from
runAgent's failover loop, `hasAgent()`, and `maybeBrainSwitch()` in one
place. When both subscription accounts are usage-limited the brain now
THROWS, the caller degrades to the keyword-intent pipeline, and a total-
outage `notify()` fires — loud and free, instead of quiet and metered.
This replaced a real, live problem, not a theoretical one: on 2026-07-25 a
total outage made the failover loop land on `anthropic`, and because a
successful failover is persisted to KV `brain-provider` it stayed there,
billing metered tokens with no ongoing signal; `secrets.env` separately had
`BRAIN_PROVIDER=gemini`, so clearing that KV would have pinned it to a
*different* metered API rather than the subscription. **Two things to check
if the brain ever seems to be on the wrong provider — they drifted apart
before: KV (`curl 127.0.0.1:9200/memory/kv/brain-provider`) AND env (`grep
BRAIN_PROVIDER config/secrets.env`). Fastest single check: the
`[jarvis-deck] agent brain: <name> ✓` line at boot in `journalctl -u
jarvis-deck`.**
Any automatic failover away from `claude` still fires a spoken notify() —
silent downgrades (the 2026-07-18 Gemini incident) must never repeat.
**Scope:** `ANTHROPIC_API_KEY` is deliberately untouched and still powers the
Haiku *intent classifier* fast-path (src/lib/conversation.js,
src/slack-bridge.js) — ~300ms classification calls, not brain turns. Don't
delete that key thinking it's part of the brain fallback.
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
│   ├── browser-service.js     — guarded web search/fetch/render bridge
│   ├── code-health.js         — deep read-only code review on a timer (docs/CODE-HEALTH.md)
│   └── lib/
│       ├── cookies.js         — ONE cookie parser that cannot throw (a raw upgrade handler dies if it does)
│       ├── findings.js        — pure code-health logic: fingerprints, lenses, verification budget
│       ├── slack-auth.js      — who may command Jarvis from Slack; FAILS CLOSED
│       └── push.js            — device alerts via ntfy, the channel that works with no tab open
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
- **Every numeric limit goes through `src/lib/guardrail.js` (2026-07-28).**
  systemd's `EnvironmentFile` does NOT strip inline comments, so
  `MAX=6 # per day` arrives as the string `"6 # per day"`; `Number()` makes it
  NaN and every `x < NaN` is false, so the gate stops gating. That is the
  2026-07-17 incident (117 self-heal dispatches against a cap of 6). The same
  bug was still live in `tts.js`/`tts-stream.js`, where a bare
  `parseInt(...)` with no `||` fallback meant a malformed
  `TTS_DAILY_CHAR_BUDGET` removed the ElevenLabs spend cap entirely. Note that
  `Number(x) || default` is only *accidentally* safe — it hides the operator's
  mistake instead of reporting it. Use `guardrail()`: it takes the leading
  token, refuses non-positive values, always returns something finite, and
  logs `BAD GUARDRAIL` when a value was set but unusable.
- **Memory hygiene:** `repair_log` is empty — sessions skip the mid-session
  logging in the protocol below. The memory is only as smart as what gets
  written to it. **Correction (2026-07-28): `agent_context` is NOT empty and
  never was** — it is the physical table behind the whole `/memory/kv` API
  (see memory-server.js: `GET/POST /memory/kv` read and write
  `agent_context`), so it holds `brain-provider`, `jarvis-conversation`,
  `claude-active-profile`, `claude_verified_version` and every other durable
  bit of Jarvis state. Do not "clean up" this table.
- **One conversation, all surfaces (2026-07-28):** the deck and the gateway
  share ONE durable transcript via `src/lib/transcript.js`, memory KV key
  `jarvis-conversation` (migrated from the deck's old `deck-conversation`).
  Before this the gateway — **THE interface** — held conversation in a
  per-WebSocket array, so a page reload, a device swap, or a service restart
  silently wiped it. If Jarvis ever "forgets" again, check that key first.
  **Saves MERGE, they do not overwrite (2026-07-30).** Until then `saveTranscript`
  wrote the whole local array as the new value, from a cache `loadTranscript`
  never refreshes — and the deck and the gateway are separate PROCESSES with
  separate caches, both of which save. A long conversation on the deck plus one
  sentence to the gateway meant the gateway wrote its stale array over the top
  and the deck's turns were gone. Now a save re-reads the store and appends only
  what that process added since its last CONFIRMED write (`newSince`/`mergeTail`),
  splices the result into the shared array in place (runAgent holds that
  reference), and writes NOTHING if the store is unreachable. Note `newSince`
  cannot diff by length: runAgent trims the array to 24 in place, so at the cap
  two new turns leave the length unchanged — that bug shipped and was caught by a
  live deck-then-gateway run, not by the tests. Known limit: two saves inside the
  same few hundred ms can still lose the later one; the KV has no version to
  compare against, and a CAS there would close it.
  The dispatch confirmation gate is deliberately NOT shared: a preview shown
  on one surface must not be confirmable from another.
- **Alerts reach his DEVICES now, not just open tabs (2026-07-30).** Every
  notification path before this needed something of Craig's to be listening —
  the inbox is a pull, gateway/deck pushes only land in a connected tab, TTS
  needs a live page. `src/lib/push.js` is step 5 of `notify()`: an HTTP POST to
  an ntfy topic, fanning out to the app on every device. The topic name IS the
  credential — `NTFY_TOPIC` in secrets.env, never in git, treat it like a
  password. `warn`/`alert` only by default (`PUSH_MIN_LEVEL`), deduped, hourly
  capped, `alert` exempt from both, all limits via `guardrail()`. Kill switch
  `PUSH_DISABLED=1`. Full channel map + per-device setup: **docs/ALERTS.md**.
  Tests: `test/push.test.js`.
- **The confirmation gate reads a VOCABULARY, not a phrase list, and never
  drops a staged job in silence (2026-07-30).** `resolveDispatchGate` /
  `classifyGateReply` in `src/lib/conversation.js` are the only path from
  "Craig said go" to a full-permission agent, and on 2026-07-30 that path was
  shut: he staged a repair, answered **"please"**, and nothing launched. The
  old `AFFIRM_RE` knew `please do` but not `please`, so the reply counted as an
  unrelated command — which **silently deleted the pending** and passed the
  text to the brain, which re-staged the identical job and said *"I've passed
  your yes through, sir"*. Both halves were bugs. Now: a reply is classified
  `yes|no|defer|none` against word sets (compact replies only — anything over 8
  tokens or containing a word outside the sets is a fresh command, and any
  negation vetoes a launch); a staged job survives `GATE_TTL_TURNS = 3` turns
  of ordinary talk; re-staging the SAME job does not move its confirmation turn
  (re-stamping made every "yes" one turn too early); and the gate leaves
  `gate.launched` / `gate.lapsed` for `gateNote()`, which `statusDigest()`
  feeds to the brain — the model cannot see the confirming turn (the gate
  answers it and returns early), which is exactly why it used to invent one.
  Gate-handled turns are also written to the shared transcript via
  `recordTurn()`. Tests: `test/dispatch-gate.test.js` — add a case there before
  widening the vocabulary, a false "yes" launches a production agent.
  **The same day's overcorrection, and the rule that came out of it:** widening
  the gate from a phrase list to a vocabulary made it too LOOSE — action verbs
  counted as standalone affirmations and first-person pronouns sat in FILLER, so
  it answered *yes* to "i need to run", "let me go", "i can do that", "you can
  send it". Any of those would have launched a staged full-permission agent from
  a sentence not addressed to it (found by the code-health spine, on code six
  hours old). **A confirmation is an IMPERATIVE**, so: `YES_STRONG`
  (yes/ok/please/proceed/granted…) stands alone; `YES_VERB`
  (do/go/launch/send/run…) needs a `YES_OBJECT` ("do it", "go ahead") or must be
  the entire reply ("go"); and `i/me/my/we/us/you/can/could/would/will/need` are
  deliberately NOT filler, so a sentence about the speaker is not "compact
  vocabulary" and falls through to the brain as a fresh command. When touching
  this, run both directions — the false-affirm list AND the 21 real
  confirmations.

## KNOWN DEBT (current priorities — fix these, don't work around them)

1. **No external watcher — REPLACED 2026-07-30, not patched.** The whole
   cloud-routine approach below was abandoned: three attempts, two
   contradictory "fixes", and hard evidence it had never delivered a single
   alert. It now lives in **`.github/workflows/offbox-watchdog.yml`** — a
   GitHub Actions runner asking for every 5 minutes but **measured at roughly
   ONCE AN HOUR** (2026-07-30: it fired 4 times in its first 4 hours — GitHub
   throttles scheduled workflows hard, so treat the detection window as ~1h and
   never design against 5 min), three spaced probes of the public
   `:9212/health`, raising TWO independent alarms on total failure: a
   max-priority ntfy push (`NTFY_TOPIC` repo secret) **and** the job failing,
   which makes GitHub email Craig from its own infrastructure with no secret
   needed. Off-box by definition, unrestricted egress, free and unlimited
   minutes on this public repo, and it touches nothing private (no tailnet, no
   SSH key, no Jarvis credential) because it must run when the box is a smoking
   hole. See docs/ALERTS.md for the channel map and docs/OFF-BOX-WATCHDOG.md
   for why the routine design was dropped rather than fixed.
   **Two things still outstanding, both Craig's:** (a) `gh secret set
   NTFY_TOPIC --repo ccantynz-alt/jarvis-platform` to turn on the push half
   (until then it logs a `::warning::` and relies on the email — deliberately,
   because failing every 5 minutes over its own config would be 288 emails a
   day); (b) SSH access to box 158, which is the *better* watcher (always on,
   tailnet, deeper checks, 5-minute timer, and the standalone-script pattern is
   already accepted there) and is currently blocked by `Permission denied
   (publickey)` from both his PC and the master box. **Do not mark this cleared
   until `gh workflow run offbox-watchdog.yml -f test_alert=true` has actually
   buzzed a device** — "the code exists" is exactly the mistake that kept this
   open for a month.
   **Measured 2026-07-30 (partial — this entry stays OPEN):** the workflow itself
   is running and healthy — 8 scheduled runs that day, all green, averaging one
   per **~49 minutes**, which confirms the ~1h detection window rather than the 5
   minutes it asks for. And the ntfy leg from the BOX is proved: a push from a
   service environment returned HTTP 200 and ntfy's own topic cache
   (`GET /<topic>/json?poll=1&since=72h` — sends nothing, safe any time) holds 9
   real messages. So what is unproven is now narrow and specific: the workflow's
   own push half, which needs the repo secret, and whether any of it lands on a
   device, which needs Craig to subscribe. Neither is something this box can do.
   The abandoned history, kept because it explains the constraint:
   Full messy history in
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
   **CONFIRMED 2026-07-22:** a fresh one-shot diagnostic from inside the
   real CCR sandbox tried `login.tailscale.com`, `controlplane.tailscale.com`,
   `pkgs.tailscale.com`, AND `ntfy.sh` (as a "known-working" baseline) —
   **all four failed identically** (`CONNECT tunnel failed, 403`). This is
   the same error Session B found for `ntfy.sh` alone on 2026-07-19 — two
   independent confirmations now. **The live watchdog most likely cannot
   deliver an alert at all right now** — this isn't just "unverified,"
   it's evidence of an actual block. Craig still needs to do the network
   policy step above (either allowlist `ntfy.sh` to keep the current
   design, or go straight to the tailnet-join redesign, which needs the
   same step anyway and drops the third-party dependency). See
   docs/OFF-BOX-WATCHDOG.md for the full diagnostic.
2. ~~ANTHROPIC_API_KEY not yet set in secrets.env on the box~~ **CLEARED
   2026-07-22** — key added, verified live via `/slack/health` showing
   `"classifier":"http-api"`. (A second, separate fast-path for
   the Gateway/voice brain's own classifier — src/lib/conversation.js,
   unrelated code path — shipped 2026-07-20. Same secrets.env, same
   restart round, so this is very likely also live now, but not
   independently verified the way the Slack path was — no direct
   evidence yet that a Gateway/voice utterance actually took the
   ~300ms path instead of the CLI fallback.)
3. Orchestrator still runs agents as root with
   --dangerously-skip-permissions; migrate to the Claude Agent SDK with
   scoped permissions.
4. eSIM MVNO not in platforms.json (see WHAT JARVIS IS).
7. ~~**No linter, and it has already cost 22 days of silent breakage**~~
   **CLEARED 2026-07-30.** `eslint.config.mjs` + `npm run lint`, and the
   deferral reason below was answered rather than ignored: the violation
   count was MEASURED first, with a throwaway install outside the repo. The
   whole tree came to 13 problems, all trivial, all fixed in the same
   commit — plus 2 more that only appeared when `npm run lint` ran for real
   on the box, which is the argument for having the script. Proof the rule
   earns its place: run against the actual pre-fix file (`git show
   951dccf^:src/slack-bridge.js`) it reports `637:45 'ms' is not defined`
   AND `624:9 't0' is assigned but never used` — the bug and its own
   corroboration. `no-empty` is deliberately OFF (this codebase uses
   `catch { /* why */ }` on purpose, ~30 times, each commented; enabling it
   only teaches people to write disable directives). `lint` is NOT in
   `npm test`, because the suite runs on dev checkouts that have no
   `node_modules` — lint on the box. Three of the 13 were worth more than
   the lint itself: a discarded `/memory/query` round trip on every
   dashboard refresh, a `COOKIE_MAX_AGE` orphaned by the 2026-07-17 Deck
   consolidation (with a comment still describing the vanished token
   bootstrap), and `/internal/notify` destructuring `body` it never used.
   Original entry, kept because the reasoning still applies to the next
   rule anyone wants to add: `src/slack-bridge.js:637` interpolated `${ms}` — an
   identifier that never existed in that module — from 2026-07-08 (11d8af7, the
   lib/ extraction) until it was found by a code-health sweep. ESM is strict
   mode, so that line throws `ReferenceError`, and it sits AFTER intent
   resolution but BEFORE the switch: every Slack command would have died, and
   both call sites `.catch(e => console.error(...))`, so Craig would have seen
   nothing in Slack at all. `node --check` never sees it (the syntax is fine) and
   no test exercised the line. **`eslint` with `no-undef` would have caught it at
   commit time.** Adding one was NOT done unattended: the violation count across
   ~20 services is unknown and could be large, and a noisy first run invites
   blanket-disabling the rule, which is worse than not having it. Do it with
   Craig, `no-undef` first and the style rules off. (That is exactly what
   shipped.)
   *(A heuristic test was attempted instead — flag an identifier interpolated in
   a template literal that appears exactly once in the file — and it FAILED to
   catch this very instance, because `(${ms}ms)` contains `ms` twice: the
   interpolation and the literal unit suffix. It was deleted rather than shipped;
   a test that passes on the bug it was written for is worse than no test.)*
6. **`platform_state.status` still has THREE writers meaning three different
   things — the last one wins (2026-07-30).** fleet-check.sh writes uptime
   ('healthy'/'error' from an HTTP probe, every 10 min), audit-runner writes
   build/test quality ('healthy'/'warning'/'critical', daily, direct to SQLite),
   and orchestrator's `logToMemory` writes a JOB outcome ('healthy'/'error' from
   an exit code, per job). The dangerous direction is fixed — an audit can no
   longer erase a real outage, see `lib/health-status.js` — and omitted columns
   are now preserved rather than zeroed. What remains: fleet-check's 'healthy'
   overwrites an audit's 'critical' build verdict within 10 minutes, so a broken
   build reads healthy on the deck. Nothing dangerous happens (self-heal only
   acts on 'error', and the audit notifies + auto-dispatches independently) but
   the displayed status is wrong.
   **The fix, deliberately NOT done unattended on 2026-07-30:** give each writer
   its own column (`uptime_status`, `audit_status`) and make `status` a DERIVED
   worst-of (error > critical > warning > healthy) computed on write, so every
   existing reader keeps reading `status` unchanged. It needs a coordinated
   change across memory-server.js (schema + derive), fleet-check.sh,
   orchestrator.js and audit-runner.js — an optional `kind` on
   `/memory/platform/update`, since the endpoint currently cannot tell which
   writer is calling. It was left for a session with Craig awake because this is
   the single most-read table on the box and the failure mode is *he sees the
   wrong health*, which is his most frequent complaint already.
5. ~~audit-runner's PLATFORM_CONFIG only covers 4 of the 12 registered
   platforms~~ **CLEARED 2026-07-22** — all 11 audit-eligible platforms now
   have a config (`jarvis` itself and the `pc`-executor `craig-pc` are
   intentionally excluded, not a gap). Full build/test/screenshot audit:
   zoobicon, vapron, bookaride, alecrae, gatetest, voxlen (web/React portion
   only — desktop Tauri + mobile Swift builds are NOT audited),
   universal-ai-operator, screenshot-to-code. Lighter URL-only audit
   (screenshot + health check, no build/test, no auto-fix — no local
   checkout on this box to build or push a fix from): marcoreid, davenroe
   (Vercel-hosted). `noAutoFix` also set for universal-ai-operator (no git
   remote to push a fix to) and screenshot-to-code (third-party fork —
   auto-committing "fixes" risks diverging from upstream).
   **CORRECTED 2026-07-30 — the sentence that used to end this entry said a
   wrong command "just shows as a build failure on the first run, not a
   silent false-pass". That is exactly what did NOT happen.** A wrong
   *path* produced a silent false-pass for weeks: `ZOOBICON_PATH` and
   `ALECRAE_PATH` pointed into `/var/www`, which does not exist on this
   box, so `spawnSync` got a dead cwd, the `ENOENT` text matched none of
   `extractErrors()`'s patterns, the arithmetic landed on a tidy
   `100-20-10 = 70` → `warning`, and `notifyAuditResult()` only speaks for
   `critical`. Craig's flagship and AlecRae were "audited" daily and the
   number was invented. Guard now lives in **`src/lib/checkout.js`**: a
   path that is missing, is not a directory, or holds no build manifest
   gives `status:'unconfigured'` with `health_score: null` — never a number —
   and a spoken warn-level notify. **Current coverage after that fix:**
   zoobicon moved to URL-only (no checkout on this box — `/root/zoobicon`
   holds only a `.claude` folder); alecrae is `bun run typecheck` ONLY, with
   `testCmd: null`, because it is a LIVE co-tenant whose working tree is
   `/opt/alecrae` (`turbo run build` would regenerate Next.js output under
   the running :4200 server, and the repo is bun, not npm). jarvis-audit's
   `MemoryMax` went 1536M → **2560M** because that first genuine typecheck
   OOM-killed the service; measured, cold run exits 137 under 1536M and 0
   under 2G. Don't "fix" a platform's audit by correcting its command alone
   — check the path exists and that running it is safe on a shared box.

Cleared 2026-07-06: dashboard auth, cupsd exposure, keyword-only intents,
no DB backups. Cleared 2026-07-12: Slack notification firehose (NotifyCenter:
digest/mute/rate-limit) and misrouted Slack commands (src/intent.js rewrite)
— see git log.
Cleared 2026-07-19: resource guards / pre-OOM alerting (metrics-collector.js).
Cleared 2026-07-30: nothing alerted when a Jarvis SERVICE died — no OnFailure= on
any unit, nothing watching unit state, and the HUD showing four ports of twelve.
Demonstrated live the same day when a bad deploy of mine crash-looped jarvis-slack
for a minute and the inbox recorded nothing. metrics-collector.js now watches all
twelve and classifies why a port is quiet before deciding how loudly to say so.
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
Cleared 2026-07-22: audit-runner ran real audits (build/test/screenshot,
health score) for weeks without ever acting on what it found — Craig had to
notice a bad score and manually ask for a repair every time (Vapron
specifically). A critical audit now auto-dispatches its own fix via the
orchestrator, same guarded pattern as deploy-gate.js's self-repair (capped
at 2 consecutive critical audits before escalating to a human alert instead
of re-dispatching forever). Platform coverage gap (was KNOWN DEBT #5) also
cleared the same day — see KNOWN DEBT #5's strikethrough entry above for
the full breakdown of which platforms get the full audit vs. the lighter
URL-only variant vs. an explicit no-auto-fix flag.

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

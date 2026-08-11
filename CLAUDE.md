# CLAUDE.md — Jarvis Platform
> Operating doctrine for every Claude Code session on this repo. Read it all.
> Lean by design (restructured 2026-08-07): this file holds CURRENT truth and
> rules; every incident narrative behind a rule lives in **docs/LESSONS.md** —
> read the entry there before relaxing any constraint. Rule 0 covers both.
> Last verified against the box: 2026-08-08.

## WHAT JARVIS IS

The autonomous agent platform on the Vultr box **66.42.121.161** (`vultr`).
Not a product — the infrastructure that watches, audits, and repairs Craig
Canty's (MarcoReid Intelligence Systems) platforms without human intervention.

**Reaching the fleet from Craig's PC: `ssh jarvis` and `ssh vapron` — nothing
else (2026-08-08).** Both aliases are pinned to TAILNET IPs in the PC's
`~/.ssh/config`; never type `ssh root@66.42.121.161` again (Craig: "no matter
how many times i say we have tailscale claude never remembers"). Both boxes
answer over the tailnet, including 158 — the old "Permission denied
(publickey) to 158" claim is dead.

The platform registry is `config/platforms.json` (hot-reloaded — edits apply
instantly). Read it; never trust a list in a doc. Local checkouts of note:
AlecRae runs ON THIS BOX at `/opt/alecrae` (live co-tenant, bun :4100 / next
:4200), Gluecron runs here as a Docker container behind Coolify/Traefik,
GateTest at `/opt/gatetest`, zoobicon clone at `/root/zoobicon`. The eSIM MVNO
is not yet registered — add it when it's real.

## HOW WE BUILD (the next-20-moves principles)

1. **Pure logic in `src/lib/`, tests in `test/`, service wiring thin.** Every
   hard-won behavior gets a pure function and a regression test carrying the
   real incident that motivated it.
2. **Verify live.** `node --check` and green tests prove little; restart the
   service, read its log, probe its health path, screenshot its pixels. The
   deck's build stamp (bottom-right, from `/health`) proves the whole deploy
   chain git → box → browser.
3. **Every numeric limit goes through `src/lib/guardrail.js`.** No bare
   `Number()`/`parseInt()` on env values, ever (LESSONS: the 117-dispatch day).
4. **One mechanism, not N.** One notify pipeline, one confirmation gate, one
   transcript, one proposal/review path. A second bespoke path is where the
   next incident lives.
5. **Boundaries are credentials and server-side gates, not prompts.** An agent
   prompt is a request. Anything an agent must not do needs a hook, a scoped
   token, or a server-side check it cannot route around.
6. **Fail loud and free, never quiet and metered.** Degraded modes must
   announce themselves (on screen, in the inbox, spoken) — a silent fallback
   is indistinguishable from a broken assistant.
7. **New state is additive.** Migrations are additive columns; writers UPSERT
   only the columns they own (never `INSERT OR REPLACE`); a future column must
   survive by construction.
8. **A path in config is a claim — verify it.** That it exists, that it holds
   THAT platform's own source, and that running commands there is safe on a
   shared box.
9. **Doctrine moves in the same commit as topology.** And when you write a
   unit file on the box during an incident, copy it into `systemd/` the same
   hour.

## THE RULES

**Rule 0 — this file must match reality.** Topology changes update this file
in the same commit. If it disagrees with the box, the box wins: probe, then
fix the file. Extension: `docs/ROADMAP.md`'s moves list and
`config/roadmap.json` are twins — update both in the same commit; flipping a
move to `done` also fires a `notify()`.

**Rule 1 — read memory first.** Every session starts:
`bash /opt/jarvis/scripts/session-start.sh <platform>` — read all output.

**Rule 2 — proof of work.** Nothing is "done" without a named artifact: green
health probe, passing test output, build log — and for ANYTHING a human sees
(HTML/CSS/frontend JS), a screenshot via
`POST http://127.0.0.1:9201/screenshot/capture`, visually inspected, BEFORE
telling Craig. "The code looks right" is not proof (LESSONS: the avatar
debacle).

**Rule 3 — write memory at session end.**
`bash /opt/jarvis/scripts/session-end.sh <platform> <session_id> "<summary>"`
— and log fixes mid-session to `/memory/repair/log` (see SESSION PROTOCOL).

**Rule 4 — never break co-tenants.** This box also runs AlecRae, Gluecron,
GateTest, and the Coolify stack. Jarvis owns ports 9200–9212 and nothing
else; check `ss -tlnp` before binding. Never modify co-tenant config.

**Rule 5 — no competitor dependencies.** No Playwright/Puppeteer/Vercel
SDK/Cloudflare SDK; screenshots are raw Chromium CDP via
screenshot-service.js. ONE documented exception: `browser-service.js` uses
`playwright-core` (system Chrome, no bundled browser) because its
`/browser/render` needs real CDP scripting for DOM extraction + per-request
SSRF blocking, and hand-rolling that in a security-sensitive path was judged
worse than the doctrine violation. Closing it properly = raw CDP
Network/Fetch interception, tested against private-IP egress first.

## THE ELEVEN SERVICES

| Service | File | Port | Purpose |
|---|---|---|---|
| jarvis-memory | src/memory-server.js | 9200 | SQLite memory + KV + notifications inbox + durable job queue + agent reports + proposals |
| jarvis-screenshot | src/screenshot-service.js | 9201 | CDP screenshot capture |
| jarvis-metrics | src/metrics-collector.js | 9202 | Server metrics + WebSocket; **the only thing that alerts when a Jarvis service dies** — probes all 12 ports/30s, classifies why a port is quiet (`src/lib/service-verdict.js`: restarting=silent, failed=first-probe alert, stopped=warn ~2min, notlistening=alert ~60s) |
| jarvis-audit | src/audit-runner.js | 9204 | Daily build/test/screenshot audit; repeat-identical results go quiet (`src/lib/audit-noise.js`) |
| jarvis-orchestrator | src/orchestrator.js | 9205 | Dispatch engine: durable job queue + scheduler; spawns Claude agents (local + SSH) via src/lib/spawn-agent.js; `/pc/action`, `/pc/status` |
| jarvis-dashboard | src/dashboard-server.js | 9206 | Status panel + screenshot browser; tailnet `--https=8445`; token JARVIS_DASHBOARD_TOKEN |
| jarvis-deploy-gate | src/deploy-gate.js | 9207 | GateTest scan gating platform deploys |
| jarvis-gateway | src/gateway-server.js | 9208 | **THE interface** — voice/text control + inbox; tailnet `--https=8443`; token JARVIS_GATEWAY_TOKEN; spec docs/GATEWAY.md |
| jarvis-agents | src/agent-scheduler.js | 9209 | Agent-org scheduler: 44 role agents (CEO → C-suite → per-platform/per-jurisdiction specialists) from config/agents.json on cron, budget-capped; reports route up the ladder (ok→inbox, action_needed→warn, escalate→alert). `AGENTS_MODE=live` since 2026-07-19 |
| jarvis-deck | src/deck-server.js | 9210 | **Command Deck v2.2** (public/command-deck.html): CORE brain + HUD/Hierarchy/Flow/Platforms/OPS tabs, PWA, briefings, raw WS `/jarvis`; tailnet `--https=8444`. Deck mints its OWN token — `config/deck.token` (env `JARVIS_DECK_TOKEN`); the gateway token does NOT unlock it. Cookie re-stamps on every authed load (sliding 30-day). OPS tab = inbox (mark-read is the ONLY mutating action, via `POST /api/ops/inbox-read`) + findings + agent reports + job queue; data via 15s `{type:'ops'}` broadcast + `GET /api/ops` (the only path virtual-time captures see). QA: `?demo-alert=1` / `?demo-briefing=1` / `?view=hud\|org\|flow\|plat\|ops`. Voice: wake word "Jarvis" (fuzzy), `GET /tts` = ElevenLabs (src/lib/tts.js — cache, daily budget, TTS_DISABLED), speechSynthesis fallback. Evidence: docs/DECK-AUDIT-2026-07-16.md |
| jarvis-browser | src/browser-service.js | 9211 | SSRF-guarded web search/fetch/render bridge |

Health paths are namespaced: `/memory/health`, `/screenshot/health`,
`/metrics/health`, `/deploy-gate/health`, `/audit/health`, `/browser/health`;
plain `/health` on agents, deck, dashboard, gateway, orchestrator. Slack
(`slack-bridge.js`, :9203, `/slack/health`) is frozen-legacy but **still
active** — never delete on the strength of the (wrong) "retired" claim.

## THE SEVEN TIMERS

Periodic `oneshot` units, not daemons. Count them with
`systemctl list-timers "jarvis-*"` — trust that, not this table. Any new
oneshot MUST set `TimeoutStartSec` explicitly (the default is no timeout).

| Timer | Cadence | What it does | Mode |
|---|---|---|---|
| jarvis-fleet-check | 10 min | `scripts/fleet-check.sh`: HTTP probe of every platform URL → `platform_state` status/health_score; 2 misses = error; tracks flap history | — |
| jarvis-self-heal | 5 min | `src/self-heal.js`: on `status==='error'`, auto-dispatches a repair agent. Debounce, cooldown, daily cap, concurrency cap, no-other-job-in-flight check, DNS pre-check (nxdomain → alert + dispatch nothing) | **live** |
| jarvis-code-health | 3 h | `src/code-health.js`: the only CODE-defect finder. Least-recently-swept platform × 1 of 9 lenses → one read-only review agent → adversarial verifier on critical/high → `code_findings` by fingerprint (dismissed sticky, severity only escalates, reappeared-fixed = regression). Fixes NOTHING. Requires `hasSource(path)`. Spec docs/CODE-HEALTH.md; logic src/lib/findings.js | **live** |
| jarvis-fix-runner | 30 min | `src/fix-runner.js`: closes the loop — worst CONFIRMED, pushable, unclaimed findings → opens a proposal → ONE repair agent each (max 1/platform/tick), branch `jarvis/fix-<id>` only. Gates in src/lib/fix-dispatch.js (confirmed-only, git remote required, no dupes, denied platforms, CAUTION_RE — prose beats enum). Never marks findings fixed | **live** |
| jarvis-review-runner | 20 min | `src/review-runner.js`: spawns the OWNING officer to review open proposals | **dry-run** |
| jarvis-harvester | 1 h | `src/session-harvester.js`: **the flywheel** (2026-08-07) — indexes every quiet CLI transcript into `coding_sessions` (redacted metadata; raw stays on disk), then distills each real session with one capped agent turn into `lessons` (deduped by fingerprint, `seen_count` on recurrence). Brain CONVERSATION sessions excluded by construction (the 2026-08-06 privacy lesson). Injection: session-start.sh prints a platform's lessons; brain tool `get_lessons`. **Phase 2 (2026-08-08):** also pulls 158 transcripts (tailnet rsync, `HARVEST_REMOTE`) and Craig's PC (read-only `harvest.list`/`harvest.get` PC verbs, cursor in KV `harvest-pc-cursor`). PC dispatch is single-flight with fate tracking (2026-08-10): a queued/running harvester PC job blocks new dispatch, and a permanent refusal — even one landing after the wait window (KV `harvest-pc-last-list-job`) — trips the daily stale-worker back-off (KV `harvest-pc-stale-worker-day`; `pcListPlan()` in lib/harvest.js). Backlog burn at `HARVEST_DISTILL_MAX=10` newest-first until the ~458-session backlog clears, then RESTORE to 3. Logic + tests: `src/lib/harvest.js`, `test/harvest.test.js`, `test/pc-actions.test.js` | **live** |
| jarvis-backup / jarvis-vapron-backup | daily 03:30 / 04:17 UTC | SQLite backup; pull + verify off-box copy of box 158's Vapron DB | — |

Guardrail env caps (all via `guardrail()`): self-heal + fix-runner limits in
`config/self-heal.env` / `config/fix-runner.env` (`FIX_MAX_PER_DAY=4`,
`FIX_MAX_CONCURRENT=2`, `FIX_MIN_SEVERITY=critical`).

**Drop-ins win over unit files.** Real limits live in
`/etc/systemd/system/jarvis-*.service.d/` (mirrored in `systemd/dropins/`);
verify with `systemctl show <svc> -p MemoryMax`, never by reading a unit.

## THE BRAIN

- **Subscription-only.** Provider `claude` = persistent Claude Agent SDK
  session (src/lib/brain-claude.js) on Craig's claude.ai subscriptions.
  Metered providers (openai/anthropic/gemini) gated behind
  `BRAIN_ALLOW_METERED=1`, default OFF; both accounts exhausted → throw,
  degrade to keyword-intent, loud total-outage notify. Any automatic failover
  away from `claude` fires a spoken notify().
- **Tiers: Opus 5 everyday, Fable 5 heavy** (voice: "switch model to Fable";
  auto one-turn escalation on non-limit/non-timeout failure). Sonnet is not a
  tier. Changing a tier = re-fit its timeouts in the SAME commit (warm
  first-token watchdog is 20s; a trip retries the SAME tier).
- **Wrong-provider check:** KV `brain-provider` AND `grep BRAIN_PROVIDER
  config/secrets.env` (they have drifted apart); fastest single check is the
  `[jarvis-deck] agent brain: <name> ✓` boot line.
- **Brain dead everywhere?** `claude --version` on the box first, then
  `claude --model claude-opus-5 --print hi` — a stale binary rejecting one
  model ID downs the whole brain (spawns set `DISABLE_AUTOUPDATER=1`).
- **Two-account failover:** src/lib/claude-auth.js; profiles `/root/.claude` +
  `/root/.claude-profiles/<name>`; state in KV `claude-active-profile`.
  Voice: "switch account".
- `ANTHROPIC_API_KEY` powers the ~300ms Haiku intent classifier fast-path
  (conversation.js, slack-bridge.js) — NOT brain fallback; don't delete it.
- Tools + persona: src/lib/brain-tools.js — ONE surface for every provider.
- **`show_me` puts a page ON CRAIG'S SCREEN (2026-08-11)** — the deck, so it
  works on iPad and phone too, needs nothing running on his PC. Capture goes
  through browser-service's SSRF-guarded `/browser/render` (never the raw
  screenshot service — the URL comes from a model reading untrusted pages),
  the deck serves it via `GET /shot/:name` (basename + `.png` allowlist +
  prefix assertion) and broadcasts `{type:'show'}` from `POST /internal/show`.
  Only the FILENAME crosses to the client, never a box path. It reports
  `shown:false` when no deck is open rather than claiming it landed. Screenshot
  not iframe, because X-Frame-Options blocks most real sites; the panel carries
  the live URL so he can open it properly. QA: `?demo-show=<capture.png>`.
  Tests: `test/deck-show.test.js`.
- Evidence of what the brain actually did:
  `/root/.claude/projects/-opt-jarvis/*.jsonl`, not service logs.

## VOICE (deck + gateway)

- **The ear is SHUT while Jarvis talks — every platform, no exceptions.**
  `closeEar()` + `isSelfEcho()` (LCS) as backstop. No voice barge-in (Craig
  accepted 2026-07-31): Escape, STOP bar, or mic button.
- **The open mic has bounds (2026-08-07):** MIC LIVE never survives a page
  load, expires after 30 min with an on-screen notice, and the wake-mode
  follow-up window chain-caps at `FOLLOWUP_CHAIN_MAX` turns without the wake
  word. Tests: `test/deck-live-mic.test.js`, `test/deck-echo.test.js`.
- **First diagnostic for any voice weirdness:**
  `curl 127.0.0.1:9200/memory/kv/jarvis-conversation` — Jarvis's own words in
  `user` turns = echo; no-wake-word room talk = a held-open mic.
- **The confirmation gate** (`resolveDispatchGate`/`classifyGateReply`,
  src/lib/conversation.js) is the ONLY path from "Craig said go" to a
  full-permission agent. Vocabulary not phrase-list; a confirmation is an
  IMPERATIVE; staged jobs survive 3 turns and are never dropped silently. Add
  a case to `test/dispatch-gate.test.js` before widening anything — run both
  the false-affirm list and the 21 real confirmations. NOT shared across
  surfaces by design.
- **One transcript for all surfaces:** src/lib/transcript.js, KV
  `jarvis-conversation`; saves MERGE (never overwrite), write nothing if the
  store is unreachable.

## PC WORKER (Craig's Windows machine)

Pull-based worker `craig-pc` (`executor:"pc"` in the registry):
`src/pc-worker.js` under Task Scheduler `JarvisPcWorker` polls the gateway's
`/worker/claim` (scoped `JARVIS_WORKER_TOKEN`), runs `claude --print` on the
PC's own subscription, reports to `/worker/result`; expired lease re-queues.
Jarvis can also OPERATE the PC: `src/lib/pc-actions.js` — 10 typed verbs as
PowerShell via `-EncodedCommand` (never stdin — `powershell -Command -` runs
NOTHING and exits 0; never interpolation — `psQuote()` only). Read-only verbs
run instantly; **anything mutating goes through the SAME dispatch confirmation
gate as a fleet job** (`mutates` defaults TRUE for undeclared verbs). Rides
the jobs table on the `runtime` column (`'action'` vs `'claude'`). Elevation
is measured and shipped in heartbeats (KV `pc-worker-capability`), along with
the worker's VERB LIST (2026-08-10): `/pc/action` refuses a verb the connected
worker hasn't got (409 + remedy, `workerKnowsVerb()`) instead of manufacturing
a job it will permanently refuse — a worker too old to report verbs gets the
benefit of the doubt. The live
task is still `RunLevel: Limited` until Craig re-runs
`scripts/install-pc-worker.ps1` from an ADMIN PowerShell — until then service
control correctly refuses. `JarvisPcWorkerWatchdog` (SYSTEM, 5 min) restarts a
dead worker — deliberately one inline command, no repo dependency. Kill
switches: KV `pc-worker-enabled`, `%ProgramData%\jarvis\KILL`, revoke token.
Excluded from the daily audit sprint. Brain tools: `pc_control`,
`get_pc_status`.

## SECOND BOX — 158 (Vapron, 149.28.119.158 / tailnet 100.89.227.39)

**Access (2026-08-08, amended estate ruling):** the master reaches 158 over
the TAILNET via `root@100.89.227.39` (Tailscale SSH — 158 has `RunSSH:true`,
no OpenSSH key needed; public-IP SSH refuses, by design). This is what lets
the master spawn agents there. `orchestrator.js` (`runRemoteJob`) and
`code-health.js` (remote sweeps) share ONE remote spawner: `spawnClaudeRemote`
in `src/lib/spawn-agent.js`. 158 has its own `claude` CLI + subscription login
(`/root/.claude`), so remote spawns bill Craig's subscription, not metered API
— but they bypass the two-account failover, so a usage-limit there is logged,
not retried.

**Vapron's code is reviewed REMOTELY, never mirrored here.** `CODE_HEALTH_REMOTE=vapron`
sweeps `/opt/vapron` on 158 over tailnet SSH; findings come home to
`code_findings` over the same channel. No product source lands on the master
(governance), no Jarvis service runs on 158 (estate doctrine). `/opt/vapron`'s
git origin is a LOCAL bare repo, not GitHub — canonical repo is roadmap #15,
still Craig's to confirm; don't push to the registry's `repo` value for vapron.

**Runs on 158** (for reference; not managed from this repo): the Vapron stack,
Postgres, Redis, Caddy, litestream, AlecRae + DavenRoe API copies, and an
undocumented `jarvis-metrics.service` (predates current doctrine — awaiting
Craig's ruling to bless or remove). Three plaintext secret files sit in `/root`
and a June `/opt/jarvis` clone lingers — both flagged for Craig's cleanup.

Tailnet-only health (`tailscale serve --https=8443` → ops-agent :9095);
`jarvis-heartbeat.timer` (standalone script, NOT Jarvis code — estate
doctrine: no Jarvis code on 158) posts 5-min heartbeats to the gateway on
scoped `JARVIS_HEARTBEAT_TOKEN_vapron158`; >15 min silence auto-alerts.
**`jarvis-watchdog.timer` (2026-08-08): 158 watches the master box** —
`/root/jarvis-watchdog.sh` (standalone, same pattern as heartbeat) probes the
master's `:9212/health` on BOTH the public IP and the tailnet IP every 5 min,
3 spaced attempts each; both dead → max-priority ntfy push (topic in
`/root/.jarvis-watchdog.env`, chmod 600). Alerts on the DOWN transition +
6-hourly while down + recovery — never per-tick. Log:
`/var/log/jarvis-watchdog.log` on 158.
Leftover `/opt/jarvis` clone on 158 (holds a secrets.env) awaits Craig's
deletion.

## GOVERNANCE — how autonomous work gets authorised

Read **docs/GOVERNANCE.md** before adding any capability that changes
something outside this repo. Model: PROPOSE → REVIEW (a DIFFERENT agent, the
domain's officer) → APPROVE/REJECT/ESCALATE → EXECUTE, append-only audit
trail, one mechanism for all six officers. Separation of duties in
`canTransition()`. `ALWAYS_HUMAN` classes (payment, credential, legal_filing,
production_data, public_content, infrastructure) + high/unrecognised risk can
never be agent-approved; ordinary low/medium `code_fix` deliberately CAN be.
Gate enforced server-side (`status` not settable via PATCH). Logic:
src/lib/proposals.js.

**Repository boundaries (Craig: "zero cross contamination"):** Jarvis may fix
Jarvis directly; everything else is proposal-only — observe, file, escalate.
No product source hosted here. Agents may only push `jarvis/fix-<id>`
branches; `scripts/install-push-guards.sh` puts a pre-push hook refusing
main/master/trunk/release/production on all 9 checkouts (LOCAL only — re-run
after any new clone). End state: merge authority inside each platform's own
repo with its own credential + CI; isolation = credential scope + review
gate, not an agent's label. Remaining hole: one key still writes everywhere —
server-side branch protection is Craig's ~10-minute fix
(docs/CREDENTIAL-SCOPING.md).

Current modes: `FIX_RUNNER_MODE=live` (safe — it cannot land anything),
`REVIEW_RUNNER_MODE=dry-run` (officers log verdicts; nothing auto-approves).

## ARCHITECTURE

```
Craig (voice/text, tailnet) ──► https://jarvis.tailbd6217.ts.net:8443
        ↓ tailscale serve
jarvis-gateway (9208) ── lib/conversation.js ──→ jarvis-orchestrator (9205)
                                               ↓ spawns
                              claude --print (local cwd, or ssh root@<server>)
                                               ↓ uses
        jarvis-audit (9204) · jarvis-screenshot (9201) · GateTest (/opt/gatetest)
                                               ↓ everything logs to
                              jarvis-memory (9200, SQLite memory/jarvis.db)
                                               ↑ read by
        jarvis-dashboard (9206) · jarvis-metrics (9202) · jarvis-deck (9210)
```

Programmatic dispatch:
`curl -s -X POST http://127.0.0.1:9205/dispatch -H "Content-Type: application/json" -d '{"platform":"zoobicon","task":"…"}'`
(platform `"auto"` scans task text; jobs at `GET /jobs`). Agents run with
`--dangerously-skip-permissions` as root — treat every dispatched prompt as
production input; no untrusted text pasted into tasks.

## PORTS

Public (0.0.0.0): :22 sshd · :80/:443 Coolify's Traefik (TLS front door — do
NOT fight it for :443) · :6001/:6002/:8000/:8080 Coolify · **:9212**
jarvis-dashboard's public liveness ping — ONE static `GET /health` route for
the off-box watchdog, never anything more.

Loopback: :3000 gatetest-web (10.0.1.1) · :4100/:4200 AlecRae · :5432
Postgres · :9200–9202, :9204–9207, :9209–9211 Jarvis. Tailnet HTTPS exposure:
gateway :8443, deck :8444, dashboard :8445. Vapron does NOT own ports on this
box. Re-verify with `ss -tlnp`.

## FILE STRUCTURE

```
src/                  services (one file each — see the services table)
src/lib/              pure logic + shared surfaces (findings, fix-dispatch,
                      proposals, guardrail, pc-actions, transcript, tts,
                      brain-*, conversation, checkout, audit-noise, push,
                      cookies, slack-auth, service-verdict, health-status)
test/                 node:test suites — every lib has one; regression tests
                      carry their incident
scripts/              install.sh, session-start/end.sh, fleet-check.sh,
                      backup-memory.sh, pull-vapron-backup.sh,
                      install-push-guards.sh, install-pc-worker.ps1
config/               platforms.json (THE registry, hot-reloaded), agents.json,
                      personas/, knowledge/, roadmap.json, *.env,
                      secrets.env (gitignored, box-only)
systemd/              unit files + dropins/ (must mirror the box — Rule 0)
docs/                 LESSONS.md, GOVERNANCE.md, CODE-HEALTH.md, GATEWAY.md,
                      ALERTS.md, OFF-BOX-WATCHDOG.md, CREDENTIAL-SCOPING.md,
                      ROADMAP.md, DECK-AUDIT-2026-07-16.md
public/               command-deck.html, gateway.html, deck icons/manifest
memory/jarvis.db      SQLite store (gitignored)
.ssh/orchestrator     root SSH key for remote dispatch (gitignored — if git
                      status ever shows it staged, STOP EVERYTHING)
```

## SECRETS

Real secrets: `/opt/jarvis/config/secrets.env` (gitignored; template
`secrets.env.example`). Never echo secret values into logs, Slack, memory, or
commits. **This repo is PUBLIC** — the estate map is world-readable; never
commit a secret value. `NTFY_TOPIC` is a credential (the topic name IS the
auth).

## GOTCHAS — one line each, full story in docs/LESSONS.md

- `tailscale serve` can't have :443 here (Traefik owns it) — and `serve
  status` showing a route is NOT proof it works; curl it.
- Coolify two-network hang: container on two networks + Traefik on `coolify`
  only = silent hang; label `traefik.docker.network=coolify`.
- Every numeric env limit via `guardrail()` — EnvironmentFile keeps inline
  comments; `Number()` makes NaN; NaN gates don't gate.
- `INSERT OR REPLACE` on platform_state destroyed unnamed columns four times —
  it is an UPSERT now; do not turn it back; `test/platform-state-preserve.
  test.js` runs on the box only.
- Repeat-identical audits go QUIET (info/digest) past 2 repeats — but break
  DIFFERENTLY and they're loud again. Nothing is ever dropped.
- **An alert about something the monitor cannot fix needs a HUMAN's rate limit,
  not a monitor's.** `alert` is exempt from push dedupe AND the hourly cap, so a
  `notify()` inside a 5-minute timer loop is 288 buzzes a day (2026-08-10: 235
  of them, for a PC that was fine). Use a once-a-day marker, cleared on
  recovery. And only a job actually working ON a platform may write its health —
  `jobWritesPlatformHealth()`, not role-agent jobs, not typed PC actions.
- The confirmation gate: a false "yes" launches a production agent — test
  both directions before touching the vocabulary.
- Transcript saves merge; `agent_context` is the KV table — never "clean" it.
- The ear is shut while Jarvis talks; the open mic has bounds; diagnose voice
  via the `jarvis-conversation` KV first.
- Drop-ins beat unit files; oneshot units need explicit `TimeoutStartSec`.
- A registry path is a claim about WHOSE code lives there — verify before
  adding a platform (over ssh for a remote one).
- Box-to-box is `root@100.89.227.39` over the TAILNET (Tailscale SSH, no key);
  158's public IP refuses by design. Remote agent spawns bypass two-account
  failover — a usage-limit there is logged, not retried.
- Prose beats enum in verifier verdicts (`CAUTION_RE`).
- Lint on the box (`npm run lint`), not in `npm test`; `no-empty` stays off.
- `gluecron-update.timer` and the cups snap stay disabled.
- Slack bridge is frozen-legacy but ACTIVE.

## KNOWN DEBT (open items only — fix these, don't work around them)

1. **Off-box watchdog: the 158 watcher is INSTALLED and proven to the topic
   (2026-08-08) — one confirmation left.** `jarvis-watchdog.timer` on 158
   (see SECOND BOX) probes both of the master's paths every 5 min; its
   `--test-alert` landed in the ntfy topic cache at max priority the day it
   was installed. **The single remaining step is Craig's: confirm a DEVICE
   actually buzzed** (subscribe in the ntfy app if not) — then this clears.
   The GitHub Actions watcher (`offbox-watchdog.yml`, ~hourly, GitHub
   throttles hard) stays as the second, fully-independent leg; its own push
   half still wants the `NTFY_TOPIC` repo secret, and its job-failure email
   works with no secret. History + the CCR-sandbox egress block: LESSONS +
   docs/OFF-BOX-WATCHDOG.md.
2. **Orchestrator runs agents as root with `--dangerously-skip-permissions`.**
   Migrate to the Claude Agent SDK with scoped permissions.
3. **eSIM MVNO not in platforms.json** — intent routing can't target an
   unregistered platform.
4. **platform_state.status: three writers, last wins (display-only now).**
   fleet-check's 'healthy' can overwrite an audit's 'critical' for up to 10
   min on the deck. Designed fix (NOT to be done unattended — this is the
   most-read table on the box): per-writer columns (`uptime_status`,
   `audit_status`) + derived worst-of `status`, optional `kind` on
   `/memory/platform/update`. Needs memory-server + fleet-check +
   orchestrator + audit-runner in one coordinated change, with Craig awake.
5. **Credential scope.** One root SSH key writes to every product repo;
   local pre-push hooks are bypassable. Server-side branch protection is
   Craig's ~10-minute fix — docs/CREDENTIAL-SCOPING.md.
6. **Gateway/voice Haiku fast-path unverified live** (Slack's was verified
   2026-07-22; the conversation.js path shipped with the same key but no
   direct evidence a voice utterance took the ~300ms path).
7. **REVIEW_RUNNER_MODE=dry-run** — officers log verdicts; flipping to live
   auto-approval is Craig's call after reading dry-run verdicts.

Cleared debt (dates + what closed it): docs/LESSONS.md, bottom.

## WHEN SOMETHING BREAKS

1. `systemctl status jarvis-<name>` → 2. `journalctl -u jarvis-<name> -n 50`
→ 3. probe its documented health path → 4. never restart before reading the
last 50 log lines → 5. read memory first — it may explain why → 6. hanging
behind Traefik? LESSONS: two-network hang. Brain dead everywhere? THE BRAIN
section, CLI version first. Voice weirdness? VOICE section, transcript KV
first. Craig's PC misbehaving? Check its load first — 100% CPU fakes Jarvis
bugs.

## SESSION PROTOCOL (MANDATORY)

```bash
# start — read ALL output before proceeding
bash /opt/jarvis/scripts/session-start.sh <platform>

# after every fix
curl -s -X POST http://127.0.0.1:9200/memory/repair/log \
  -H "Content-Type: application/json" \
  -d '{"platform":"<p>","file_path":"<f>","issue":"<i>","fix_applied":"<fix>"}'

# end — a session that doesn't write memory has not ended
bash /opt/jarvis/scripts/session-end.sh <platform> <session_id> "<summary>"
```

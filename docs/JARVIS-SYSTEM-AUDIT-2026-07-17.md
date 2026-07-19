# JARVIS SYSTEM AUDIT — full journey review, 2026-07-17

Commissioned by Craig ("full audit of Jarvis system journeys, the lot, and how we can improve it").
Method: four parallel investigators traced every journey end-to-end with file:line + log/DB evidence
(voice/notifications · job execution/automation · infrastructure/security · awareness/integrations),
findings cross-checked against 48h of journals, the memory API, systemd, and tailscale state.
Complements `docs/AUDIT-2026-07-17.md` (same-day code audit) and `docs/DECK-AUDIT-2026-07-16.md`.

---

## 1. Executive summary — journey scorecard

| Journey | State | One-liner |
|---|---|---|
| Voice command → brain → spoken reply (Deck) | ✅ HEALTHY | GPT brain live (~5s, tool-calling); queue-unified ElevenLabs voice; wake word hardened today |
| Notifications → Craig | ⚠️ DEGRADED | Pipeline works, but 200+ unread (alert fatigue from the self-heal storm); no dedup; restart gap can drop spoken alerts |
| Job dispatch (orchestrator) | ✅ HEALTHY | 2.1.207-as-root incident fixed (IS_SANDBOX=1 + canary gate); 72 completed / 0 stuck |
| Self-heal | 🟥 WAS CRITICAL → ✅ FIXED TODAY | All guardrails NaN-disabled by config bug; 117 live dispatches in one day vs cap 6. Fixed during this audit (see §2) |
| Role agents (CMO/CFO org) | ⚠️ SILENT | `AGENTS_MODE=dry-run` since Jul 15 — org looks alive, files no real reports. Decision needed |
| Fleet-check / deploy-gate / backups | ✅ GREEN | All running on schedule; backups integrity-checked 2 days running |
| Slack | 🟥 DEAD | Bridge service disabled; three services still call it silently (screenshot alerts DIE here) |
| Vapron watchdog cutover (box 158) | 🟨 HALF-BUILT | This box's receiving side ready; remote side never deployed; heartbeat never wired |
| Dashboards / Deck telemetry | ✅ mostly REAL | Deck numbers measured; metrics-collector's local "vapron" port checks are garbage (co-tenant processes) |
| Gateway (old voice app) | ⚠️ INCONSISTENT | No fallback when brain errors; browser voice only; kept alive as second surface |

**Single deadliest finding:** the self-heal guardrail bug (§2) — "believes it's guardrailed, isn't."
It was live and firing when the audit began; it is fixed and verified as of 06:36 UTC.

---

## 2. FIXED DURING THIS AUDIT (already live)

### 2.1 🟥→✅ Self-heal guardrail wipe-out (CRITICAL)
- **Bug:** `config/self-heal.env` used inline `#` comments. systemd `EnvironmentFile=` does not strip
  them, so `SELF_HEAL_DOWN_MINUTES=12   # comment` became the string `"12   # comment"` →
  `Number()` → `NaN` → every guardrail comparison (`< NaN`) false → debounce, cooldown, daily cap
  and concurrency **all silently disabled**, in `SELF_HEAL_MODE=live`.
- **Blast radius observed:** 117 live repair dispatches against vapron TODAY (cap: 6), triggered by
  transient probe flaps (vapron responds but slowly, ~5s; probe intermittently records `000`);
  the site was never actually down. Two repair agents ran 30 min to timeout. Alert storm
  (~every 20 min) buried real notifications; 200+ unread.
- **Fix applied:** comments moved to their own lines (env now parses 12/30/6/2, verified);
  `self-heal.js` given a defensive `guardrail()` parser — non-finite/non-positive → default +
  loud error log, so a malformed env can never disable a gate again. Supervised tick at 06:36
  ran clean (no dispatch). Today's 117 counter keeps it over-cap until midnight regardless.
- **Remaining root-cause work (backlog P1):** require 2 consecutive failed probes before
  `status=error` in fleet-check; investigate vapron's ~5s latency (that slowness is the flap source).

### 2.2 Also fixed earlier today (context)
- Memory-server was missing `GET /memory/platform/:name` (only the POST existed) — every spoken
  platform question returned "memory lookup failed". Route added, verified by voice.
- Intent classifier's `claude` CLI was being killed by the credit-less `ANTHROPIC_API_KEY` leaking
  into its env (overriding the subscription login). Env now stripped; classifier works on login.
- Brain provider layer added (GPT default / Claude switchable by voice); new OpenAI key installed;
  Codex CLI re-authenticated (was invalid, breaking all TRIP/codex skills).
- Voice unification (one ElevenLabs voice, queue-until-primed, announced backup mode),
  wake-word arming/visibility overhaul, neural core, gateway notify-speech removed.

---

## 3. OPEN FINDINGS by priority

### P1 — real risk or "Craig thinks it works but it doesn't"

1. **Visual-regression alerts die silently** — `screenshot-service.js:188-200` posts regressions to
   `:9203/slack/image-alert`; the Slack bridge is dead, the fetch fails, only console.error. A real
   visual breakage would never reach you. *Fix (quick):* route through `src/lib/notify.js` instead.
2. **Gateway has no fallback when the brain errors** — `gateway-server.js:384-393`: with a key set,
   `hasAgent()` is true, and any brain failure returns "Sorry, something went wrong" (the keyword
   pipeline at :396 is unreachable). Deck does this correctly (catch → transcript splice → fallback).
   Also: gateway never splices the failed user turn out of the transcript (context poisoning).
   *Fix (quick):* mirror the Deck's catch/splice/fallback.
3. **Brain failure is invisible to the user** — when the smart brain 400s, Craig silently gets
   regex answers. *Fix:* one-time spoken notice ("running in basic mode, sir") + active-brain badge
   in the Deck header + auto-failover to the other provider on 400/401 (provider layer now makes
   this easy). Persisted `brain-provider` KV should not survive if its key is unusable.
4. **Role agents in dry-run since Jul 15** — `AGENTS_MODE=dry-run` (unit env). Org tree looks alive;
   zero real reports. **Decision needed:** flip live (with budget caps) or label the UI "PAUSED".
5. **Notification flood / no dedup** — 200+ unread; `notify.js` has no per-(source,platform)
   coalescing and nothing marks the inbox read. Storm source is fixed; add dedup window + read/ack
   path so unread count means something. Also: deck only speaks alerts <2 min old — alerts firing
   while the deck restarts are never spoken (*fix:* durable `lastSpokenNotifId` KV).
6. **Vapron watchdog cutover is half-built** — this box's `/internal/notify` + heartbeat endpoints
   are ready and token-gated; the patched `watchdog-new.sh` was never deployed to box 158, the
   `JARVIS_GATEWAY_TOKEN` was never added there, the heartbeat sender + fleet-check ts.net probe
   were never built. A vapron-box failure reaches you only via the separate Slack webhook — never
   Jarvis's inbox/voice. *Fix:* deploy the last mile (needs your go-ahead for remote-box changes).
7. **SQLite spine not in WAL mode** — `journal_mode=delete` despite backup script claiming WAL;
   writers block readers on the one DB every service depends on. *Fix (quick, high leverage):*
   `PRAGMA journal_mode=WAL` at open in memory-server.
8. **Memory dir world-writable** — `/opt/jarvis/memory` is 0777, `jarvis.db` 0644 on a shared
   Coolify/Docker box: any local user/escaped container can read or tamper with Jarvis's brain.
   *Fix (quick):* `chmod 700 memory; chmod 600 memory/jarvis.db` (services run as root; no loss).

### P2 — should fix soon

9. **Dispatch confirmation is model-self-attested** — `dispatch_job`'s `confirmed:true` is set by
   the model itself; nothing in code enforces a genuine second human turn. Self-heal/orchestrator
   paths have no confirmation at all, and workers run `--dangerously-skip-permissions` with
   commit+push-to-main instructions. *Fix (structural):* server-side pending-token round-trip for
   dispatch; repair agents push to a branch + open PR instead of straight to main.
10. **Metrics-collector fakes vapron health** — `metrics-collector.js:64-70` port-scans localhost
    for a service that lives on box 158; co-tenant processes on :3000/:443 read as "vapron ONLINE".
    *Fix (quick):* delete the local vapron block; drive vapron from fleet-check/heartbeat.
11. **Deck WS has no keepalive; disconnect shows fake data** — half-open connections keep a green
    LIVE badge with stale data; on close, the simulator injects random feed lines visually identical
    to real telemetry. *Fix:* ping/pong heartbeat; after first LIVE link, freeze-and-label
    "RECONNECTING" instead of simulating. Also: "Live link established, sir" is spoken on every
    reconnect (pass `null` speech); a dropped WS mid-command leaves the orb stuck on THINKING.
12. **Slack half-retirement** — bridge dead/disabled but `audit-runner.js:188`,
    `screenshot-service.js` (#1 above) and an orchestrator const still point at :9203. Inbound
    Slack control is currently zero. **Decision needed:** delete the bridge + callers, or re-enable.
13. **No memory limits, everything as root** — no `MemoryMax=` on any unit; box already 1.3G into
    swap. One runaway node process can thrash the whole stack. *Fix:* `MemoryMax` per unit;
    longer-term de-root the loopback services.
14. **Dashboard binds 0.0.0.0** — only ufw stands between :9206 and the internet (token-gated,
    fail-closed, but defense-in-depth says bind 127.0.0.1 + tailscale like deck/gateway).
15. **One token = two surfaces** — deck accepts the gateway token/cookie; a single leak opens both.
16. **Anthropic credits still empty** — GPT default makes this optional now, but "switch brain to
    Claude" is dead until topped up, and docs/UI still advertise Fable 5 (see #18).

### P3 — hygiene

17. **systemd journal 3.9G uncapped** → `SystemMaxUse=500M` + vacuum.
18. **Doc drift that misleads agents at session start** — `docs/ROADMAP.md` dateline 2026-07-08 /
    "20 moves" vs canonical `config/roadmap.json` (23 moves, 07-15); `CLAUDE.md` claims 8 platforms
    (registry: 12), fable-5 brain, uniform `/health` paths. Regenerate + doc-sync.
19. **Stale secrets backups** (`secrets.env.bak.*` from Jul 13) — shred old copies.
20. **Repo clutter** — 12+ `*.bak.*` in src/public, orphaned `jarvis-bg.mp4/.jpg` + their dead
    routes (`gateway-server.js:118-125`), stray `Animate_this_image.mp4`, `esim` orphan row in
    memory inflating open_issues (19). Purge.
21. **Briefing triple-compute** — deck panel + intent handler + brain tool can each call
    `handleBriefing()` for one utterance. Compute once, reuse.
22. **Platform registry nit** — vapron `server=100.89.227.39` matches self-heal's "SSH-repairable"
    IPv4 test but cross-box SSH is forbidden by doctrine; classification wrong (currently harmless).

---

## 4. Improvement roadmap (recommended order)

**NOW (this week, mostly quick wins):**
WAL mode (#7) · memory perms (#8) · screenshot alerts → notify() (#1) · gateway fallback+splice (#2)
· brain-failure spoken notice + badge + auto-failover (#3) · notification dedup + read-all sweep of
the storm backlog (#5) · delete metrics vapron block (#10) · fleet-check 2-consecutive-probe rule
(§2.1 residue) · journal cap (#17) · purge clutter/stale secrets (#19, #20).

**NEXT (needs Craig's go-ahead):**
Vapron 158 cutover last mile (#6) · agents live-or-labeled decision (#4) · Slack delete-or-revive
(#12) · MemoryMax on units (#13) · dashboard rebind (#14) · dispatch confirmation hardening +
repair-agents-push-to-branch (#9).

**LATER (structural):**
De-root services · split deck/gateway tokens (#15) · off-box copy of jarvis.db · WS keepalive +
honest-disconnect UX (#11) · doc regeneration pipeline (#18) · gateway voice unification or formal
retirement to text-only.

---

## 5. Decisions only Craig can make
1. Role agents: go live (real CMO/CFO runs, real spend) or label paused?
2. Slack bridge: delete for good, or revive as the off-tailnet channel?
3. Vapron 158 watchdog cutover: authorize the remote-box deployment?
4. Anthropic credits: top up (restores Claude switch + Fable 5) or stay GPT-only?
5. Dashboard :9206: move behind tailscale (breaks any public bookmark) — OK?

*Auditors: 4 parallel investigators, 93 tool calls, evidence-first. Fixed-in-place items verified live.*

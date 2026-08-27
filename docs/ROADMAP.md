# Jarvis Roadmap & Decisions Ledger

> **This is the single source of truth.** Every agent (Jarvis-dispatched, Vapron's,
> or interactive) reads this at session start and updates it the moment a decision
> changes. If this file disagrees with reality, fix reality *or* fix this file —
> never leave them out of sync. Last updated: 2026-08-27.

---

## TARGET TOPOLOGY (the north star)
- **Jarvis = the host / control plane.** All platforms RUN on infrastructure Jarvis controls, so Jarvis can monitor + heal them. ("On Jarvis" = on infra Jarvis controls — may span multiple boxes; do NOT assume everything crams onto 66.42.121.161. Capacity + blast-radius.)
- **Vapron = the shared backend.** Every Jarvis-hosted platform CONNECTS to Vapron via API (onboarding tool injects the SDK/API) for backend services.
- **Platforms stay separate** — own repo, own deploy. Integration is API-only. **Never merge a platform into Vapron.**

## DECISIONS LOCKED (read before acting — stops agents contradicting each other)

| Decision | Status | Notes |
|---|---|---|
| Vapron stays on **149.28.119.158**, Jarvis controls it remotely | ✅ DECIDED | Critical shared backend → its own resilient home, not co-located. |
| All platforms → **Vapron as backend via API onboarding** (dogfood) | ✅ DECIDED (direction) | Vapron already has the API + SDK (`packages/sdk`). Roll out one platform at a time. |
| **🚫 NEVER merge a platform's codebase/deploy INTO Vapron** | ✅ LOCKED — anti-pattern | A previous agent physically merged AlecRae + Vapron; that caused the conflicts. Integration is **API-only** via Vapron's onboarding tool (injects the SDK/API). Three concepts stay separate: (1) merge=FORBIDDEN, (2) API-onboarding=the model, (3) hosting=where the app runs, independent of both. Each platform stays its own repo/deploy. |
| Jarvis Gateway = **private mesh (Tailscale), NOT public HTML** | ✅ DECIDED 2026-07-08 (Craig) — BUILD NOW | Full scope approved: Tailscale mesh (161 + 158 + Craig's devices), conversational Gateway at :9208 via `tailscale serve` HTTPS, **voice = browser-native Web Speech API** (iPad Safari STT/TTS). NOT gated on Voxlen (Voxlen may replace the ears later). See docs/GATEWAY.md. |
| **Two-box estate model** — 161 hosts/serves, 158 = Vapron backend, cross-box work over the **TAILNET** | ✅ DECIDED 2026-07-08, **AMENDED 2026-08-08 (Craig)** | Original ruling said "never SSH between boxes"; amended to allow **SSH over the tailnet only** (Tailscale SSH, ACL-revocable — 158 has RunSSH:true; the master reaches root@100.89.227.39 with no key installed). Public-IP SSH between boxes stays banned (158's public IP refuses anyway). This unblocked remote code-review of Vapron and the flywheel's 158 leg. Monitoring/heartbeats still ride the tailnet. Supersedes move #16. |
| Cloud executor (`runCloud`) | 🔒 OFF | Stays off until registry repos are fixed (#8) + cloud creds confirmed. |
| Canonical Vapron repo | 🟡 RECOMMEND `/root/Vapron` (`ccantynz-alt/Vapron`, branch `Main`) | Craig to confirm which GitHub repo he actually pushes to. |
| GateTest canonical repo | ✅ CONFIRMED `crclabs-hq/GateTest` (2026-08-08) | Registry truth pass: BOTH on-box checkouts (`/root/gatetest`, `/opt/gatetest`) have origin `git@github.com:crclabs-hq/GateTest.git`. platforms.json corrected (was `ccantynz-alt/gatetest`), and `path` corrected to `/opt/gatetest` — the newer checkout, the one deploy-gate uses. `/root/gatetest` is a stale duplicate awaiting Craig's deletion. |
| **Slack** — keep or drop | 🟡 **STILL ACTIVE, this line was wrong** (corrected 2026-07-20) | This said "retired 2026-07-15", but PR #1 (merged 2026-07-19, "Slack overhaul: kill the notification firehose + fix command understanding") describes Craig actively getting hundreds of live Slack notifications and needing commands fixed — jarvis-slack was never actually disabled. Frozen-legacy retirement criteria are in docs/GATEWAY.md ("Slack: frozen legacy + retirement criteria") and have NOT been met. **Agents: do NOT delete or disable Slack code based on this file's past claim.** |
| Registry repo fixes (gatetest/alecrae/bookaride) | ⏳ PENDING Craig confirm | Blocks safe cloud dispatch. |

## BANKED (done — do not redo)
Dashboard token auth · cups/:631 closed · gluecron-update timer disabled · nightly
memory backups (03:30) · Haiku intent routing · `runCloud` code (flag-off) · Vapron
Phase-0 investigation · GateTest scanner self-contradiction fixed · GateTest MCP endpoint
live (`mcp.gatetest.ai`).

---

## THE 51 MOVES (order = strategy; reliability is the floor)

### Phase 1 — STABILIZE (kill "everything breaks")
1. ✅ Restart policies — all jarvis-* + gatetest-mcp = `Restart=always`, alecrae = `on-failure`. (Container autoheal deferred — could conflict with Coolify; Craig call.)
2. ✅ **DONE 2026-07-20** — Resource guards: all 15 jarvis-* systemd units now set `MemoryMax`/`CPUQuota` (was previously just metrics-collector.js's software pre-OOM alerting, no hard cgroup cap) — one runaway service (Chromium in browser-service/screenshot-service, or orchestrator's spawned Claude agents) can no longer OOM the box and starve AlecRae/Gluecron/GateTest. Also created the previously-missing `jarvis-browser.service` unit (browser-service.js existed in src/ but had no systemd unit at all).
3. ✅ Off-box watcher extended to the whole public fleet (`jarvis-fleet-watcher`, hourly, deduped GitHub-issue alerts, known-down list to avoid noise).
4. ⬜ Consolidate the proxy layer (4 front doors → 1) — endgame is Vapron (#18).
5. ✅ Restore-drill passed — backup recovers faithfully (all tables match, integrity ok).

### Phase 2 — ALIGN (stop the burning)
6. ✅ This ledger — every agent reads/updates it.
7. 🔄 Point all CLAUDE.mds here; enforce Rule 0.
8. 🔄 Fix registry repo mismatches. **2026-08-08:** gatetest repo + path corrected and GateTest canonical repo confirmed (see DECISIONS LOCKED); every on-box path verified to hold its own platform's source. Remaining: canonical Vapron repo (#15) — `/opt/vapron`'s origin is a LOCAL bare repo, not the GitHub URL in the registry.
9. 🔄 Enforce session protocol — auto-log repairs to memory.

### Phase 3 — AUTOMATE (self-running)
10. ⬜ Agent runtime → Claude Agent SDK, scoped permissions.
22. ✅ **DONE 2026-07-15** — Durable job queue + CLI canary gate (agent-org Phase 1): jobs survive restarts in SQLite (`jobs`/`job_transitions` via :9200), scheduler tick with `MAX_CONCURRENT_JOBS` + timeouts, boot recovery re-queues interrupted jobs, and `spawn-agent.js` holds all dispatch behind a CANARY-OK probe whenever the claude CLI version changes (kills the 2.1.207-class silent-failure mode).
23. 🔄 **IN PROGRESS 2026-07-19** — Agent-org roster + scheduler + Slack retirement (Phase 2): 44 role agents registered — the original 19 (social-media × 9 platforms; accountant + legal × NZ/AU/US/UK/SG, DRAFT-only honesty framing) plus a REAL C-suite (cto/cmo/cfo/clo/coo/cro — weekly roll-up agents, not the deck's old cosmetic tiles) that `reports_to` now actually routes through, plus seo-specialist-* and site-medic-* on the same 9-platform roster. `jarvis-agents` (:9209) cron-dispatches them budget-capped and routes reports up the escalation ladder into the Gateway inbox. Verified end-to-end; deck Hierarchy tab renders the real tree. jarvis-slack disabled; deploy-gate repointed to notify(). 158 watchdog alert cutover is **done** (`jarvis-heartbeat.timer` on 158 posts to `/internal/heartbeat` every 5 min on a scoped `JARVIS_HEARTBEAT_TOKEN_vapron158`, verified live). Remaining: flip `AGENTS_MODE` dry-run→live (Craig's call, after reviewing one dry-run cycle).
11. ⬜ Enable cloud executor (after #8 + creds).
12. 🔄 **IN PROGRESS 2026-07-20** — Self-repair: `deploy-gate.js` now auto-dispatches a fix job (via the existing LOCAL/remote `/dispatch` path, not yet the cloud executor — #11 is still off) when a post-deploy GateTest scan finds critical issues, instead of only posting an advisory alert. Guarded by `consecutiveBlockedRuns()` — caps at `AUTO_FIX_MAX_ATTEMPTS` (2) consecutive auto-fix attempts per platform before escalating to a human alert instead of re-dispatching forever (the exact DavenRoe-style stuck-loop failure mode found elsewhere this session). Craig's ruling 2026-07-20: "deploy, push, merge = healthy up to date system" — don't wait on him to notice a broken deploy.
13. ⬜ Auto-dispatch + guardrail layer (the guardrail piece is now partly covered by #12's consecutiveBlockedRuns cap + the new `/jobs/loops` stuck-dispatch detector in orchestrator.js, added the same session).
14. ✅ **DONE 2026-07-20, verified 2026-07-22** — Intent routing → HTTP API (~300ms vs ~4-10s CLI). `classifyIntent()` (conversation.js) and the Slack bridge try the Anthropic Messages API first, CLI fallback on any failure; `ANTHROPIC_API_KEY` live on the box (`/slack/health` → `"classifier":"http-api"`). (This ledger row was the roadmap-twins mismatch — roadmap.json already said done.)

### Phase 3.5 — THE ESTATE (both boxes, all platforms, the flywheel) — added 2026-08-08
24. ✅ **DONE 2026-08-08** — Governance layer: PROPOSE→officer REVIEW→approve, append-only audit, server-side gate, pre-push hooks on all 9 checkouts. `FIX_RUNNER_MODE=live` (branch-only), `REVIEW_RUNNER_MODE=dry-run`. See docs/GOVERNANCE.md.
25. ✅ **DONE 2026-08-07** — The intelligent flywheel: `jarvis-harvester.timer` indexes every CLI transcript → `coding_sessions`, distills lessons deduped by fingerprint, injects via session-start.sh + brain `get_lessons`. Privacy: conversation sessions excluded, everything redacted. `HARVEST_MODE=live`. Phase 2 (2026-08-08): pulls 158 (tailnet rsync) + Craig's PC (read-only `harvest.*` PC verbs); backlog burn at 10/hr newest-first.
26. ✅ **DONE 2026-08-08** — Vapron enters code review: code-health sweeps it REMOTELY on 158 over tailnet SSH (`spawnClaudeRemote`, `CODE_HEALTH_REMOTE=vapron`), findings home to `code_findings` — no product source on the master, no Jarvis service on 158.
27. ⬜ Alerting completeness: 158 watchdog live (2026-08-08); remaining — Telegram two-way lock-screen channel (needs Craig's @BotFather token), and Craig confirming the ntfy device-buzz (clears KNOWN DEBT #1).
28. ⬜ platform_state per-writer columns (`uptime_status`/`audit_status` + derived worst-of `status`) — KNOWN DEBT #4, staged for a session with Craig awake (most-read table on the box; self-heal must move to `uptime_status` in the same commit).
29. ⬜ Deck estate view — both boxes + per-writer status with timestamps on the Command Deck.

### Phase 4 — CONSOLIDATE onto Vapron
15. ⬜ Confirm canonical Vapron repo; clean 3-checkout mess.
16. ~~Add Jarvis SSH key to 158~~ **SUPERSEDED 2026-07-08 by estate model: never SSH between boxes.** ✅ **DONE 2026-07-19** — 158 is on the tailnet (`vapron-158.tailbd6217.ts.net`), exposes health tailnet-only (`tailscale serve --https=8443 → 127.0.0.1:9095`, Vapron's ops-agent), and `jarvis-heartbeat.timer` posts every 5 min to the Gateway's `/internal/heartbeat`. Registry (`platforms.json`) still needs the tailnet health URL wired in (`vapron.server` is the tailnet IP already; a `health_url` field is the remaining piece).
17. 🔄 Onboard GateTest to Vapron as pilot tenant #1.
18. ⬜ Migrate off Coolify → Vapron proxy (endgame of #4).
19. ⬜ Roll remaining platforms onto Vapron.

### Phase 5 — INTERFACE (the product)
20. 🔄 Jarvis Gateway MVP — private mesh, streaming brain, voice in/out. Tailscale mesh + jarvis-gateway (:9208, `tailscale serve` HTTPS) are live and voice-tested; iPad/phone shakedown is ongoing. Spec: docs/GATEWAY.md.
21. 🔄 Embodied Jarvis — lip-synced live avatar + one custom voice (TTS via Vapron). **Custom-voice half live 2026-07-16:** ElevenLabs neural voice is wired into the Command Deck (`src/lib/tts.js`, `GET /tts` on :9210 — cache, daily char budget, `TTS_DISABLED` kill switch; awaiting a valid `ELEVENLABS_API_KEY`). Avatar half untouched; Vapron-hosted TTS remains the end-state.
31. ✅ **Mobile command centre — Marco on iPhone/iPad (DONE 2026-08-27).** Craig, 2026-08-27:
    "much better access… incredibly professional with great intelligence
    including orchestration" — all four use-cases (reporting, directions,
    maintaining platforms, coding), both voice + text flawless. Recon found the
    foundations strong (installable PWA, Tailscale-identity auth, resilient
    reconnect, honest-data discipline, governance gates) and the gap to be
    *surfacing the rich server data beautifully on mobile* + iPad tuning, not
    re-plumbing. **Phase 1a–c done + screenshot-verified:** the mobile
    conversation is now persistent, timestamped, rehydrated on connect, open by
    default, tap-to-copy, with a compact orb so the transcript owns the screen
    (`public/command-deck.html`, `src/deck-server.js`). **ALL FIVE PHASES SHIPPED
    2026-08-27** (build loop, each screenshot-verified): (1) persistent
    timestamped conversation rehydrated on connect; (2) iPad two-pane HUD +
    two-column OPS + single-row bottom tabs; (3) professional OPS reporting — KPI
    strip, findings severity filter chips, tap-through drill-down sheet; (4)
    orchestration from the phone — proposal drill-down with VIEW DIFF +
    APPROVE/REJECT in-sheet, job VIEW LOG (new `GET /api/ops/job/:id`); (5)
    always-visible colour-coded voice-state pill (LISTENING/SPEAKING/THINKING/TAP
    TO TALK/MIC OFF). Neural voice stayed OFF per the `TTS_DISABLED` ruling.

### Phase 6 — SHOWCASE (the estate builds platforms) — added 2026-08-25
30. 🔄 **The build pipeline — "Marco, build me a platform."** Craig, 2026-08-25:
    a spoken brief becomes a live platform, fully automated, and eventually a
    customer product — "this is where we get to showcase AI." Order confirmed:
    **Gluecron** (repo born; AI review on every PR = governance for AI-written
    code) → **Zoobicon** (the 7-agent builder writes the app) → **Vapron**
    (domain/DNS/TLS/deploy; AlecRae email) → **Jarvis** registers the newborn in
    `config/platforms.json` so the fleet watches it from birth. Phase 1 =
    internal dogfood through the existing confirmation gate + orchestrator:
    launch on an estate subdomain (no registrar dependency), one pipeline job,
    ends with URL + repo + screenshot. Phase 2 = same pipeline behind Zoobicon's
    customer checkout (prereqs: CentralNic PRODUCTION creds — current ones are
    OT&E sandbox, verified 2026-08-25; Zoobicon estate migration off
    Vercel/Neon/OpenSRS; known-debt #2, agents off root/skip-permissions).
    Phase 3 = the loop: plain-English Gluecron issues → AI PR → AI review →
    deploy, every customer platform fleet-checked. Logic:
    `src/lib/build-pipeline.js`.

### Phase 7 — SHARPEN (Marco notices first, and says so) — added 2026-08-27
Craig, 2026-08-27: *"we need smart alerts pushed and enabled through to the
mobile and ipad devices… if you can think on the next 20 biggest moves to make
it even smarter then this is a must. the whole system must be very clean and
work well with constant testing and checking."*

The through-line: for a week in August every real fault reached him before it
reached the box, and the fleet stayed green throughout. Phase 6 made Marco able
to BUILD; this phase makes him able to NOTICE — and to tell the right person,
at the right volume, at the right hour, with somewhere to tap.

32. ✅ **Smart alerts to the phone and iPad — Web Push through the deck PWA.**
    Shipped 2026-08-27. ntfy stayed, but it needs a second app and a topic name
    that is also its only credential, and it sat in KNOWN DEBT #1 for a month
    because nobody could confirm a device had ever buzzed. The deck is already
    installed on both devices, so it is now the transport: RFC 8291/8292 in
    `src/lib/webpush.js` against node:crypto alone (no `web-push` package —
    Rule 5), devices in KV via `src/lib/push-subs.js`, and triage in
    `src/lib/alert-smart.js` — quiet hours 22:00–07:00 NZ that hold a `warn` for
    a morning digest and **never** hold an `alert`, a collapse key so a phone in
    a pocket does not produce a pile, and a deep link so tapping "3 findings
    need review" opens the OPS tab. Both transports sit behind the ONE existing
    set of gates (dedupe, hourly cap, level) rather than becoming a second
    pipeline. ⚙ sheet → ENABLE ON THIS DEVICE / TEST ALERT. **The last step is
    Craig's: one tap on the phone, then TEST ALERT — that is also what finally
    closes KNOWN DEBT #1.**
33. ⬜ **The alert canary.** A synthetic alert on a schedule, delivered end to
    end and asserted — because the failure mode of this whole channel is an
    absence, and `jarvis-experience`'s new `alert_channel` check can only see as
    far as "a device is registered and has succeeded before".
34. ⬜ **Acknowledge, then escalate.** An alert nobody has acknowledged should
    come back louder; one he has acknowledged should go quiet immediately.
    Today "still broken" and "he has seen it" produce identical repeats, which
    is what made the voxlen alert arrive five days running.
35. ⬜ **Actionable alerts.** Approve the proposal, dispatch the repair, or
    dismiss the finding from the notification itself. The OPS tab already has
    every verdict path; the alert should reach it in one tap, not four.
36. ⬜ **One health verdict per platform** (KNOWN DEBT #4). Three writers race
    on `platform_state.status`, so fleet-check's "healthy" can bury an audit's
    "critical" for ten minutes. Per-writer columns + a derived worst-of. Needs
    memory-server + fleet-check + orchestrator + audit-runner in one commit,
    with Craig awake.
37. ⬜ **Findings get an exit path** (KNOWN DEBT #8). Only critical/high get a
    verifier and only `confirmed` gets re-checked, so low/medium findings are
    immortal — 308 of 618 on 2026-08-16. Age them to `stale` or widen the
    re-check. Craig's call, because it changes what the backlog number means.
38. ⬜ **Incident correlation.** One root cause currently produces N
    notifications from N subsystems. Group them into one incident with one
    headline and a timeline, and the phone buzzes once for one problem.
39. ⬜ **Noise scoring.** Measure which alerts he opens. A source he never opens
    demotes itself to the digest automatically — the honest version of the
    hand-tuned thresholds that keep drifting.
40. ⬜ **Predictive alerts.** Domain expiry, TLS certs, disk, memory and quota
    projected FORWARD. gatetest.ai's domain died in redemption and was
    re-diagnosed twelve times; a date arithmetic check would have said so in
    June.
41. ⬜ **Baselines, not thresholds.** metrics-collector already streams the
    numbers; alert on deviation from each platform's own normal instead of a
    fixed line that is wrong for eleven of them.
42. ⬜ **The brief arrives, it is not just spoken.** Morning and evening
    briefings push to the phone as a readable summary — today they exist only
    if a deck is open and listening.
43. ⬜ **Ask back.** Replying to an alert by voice loads THAT alert's context —
    "what's that about?" should not start from a cold status digest.
44. ⬜ **Alert → proposal → approved fix, entirely from the phone.** The pieces
    all exist (fix-runner, governance, OPS verdicts, move 31's drill-down); the
    end-to-end path from a 7am notification to a merged fix has never been run
    as one motion.
45. ⬜ **Credential scoping + server-side branch protection** (KNOWN DEBT #5).
    One root key still writes to every product repo and the pre-push hooks are
    local-only, so the boundary is a convention. ~10 minutes of Craig's time;
    prerequisite for the review-runner going live.
46. ⬜ **Guardrail conformance.** Prove every env limit actually gates, rather
    than trusting that it parses. Earned on 2026-08-27: `guardrail()` returned
    **0 instead of the fallback** for any unset variable when `allowZero` was
    set, because `Number('')` is 0 — a silent-disable inside the module written
    to prevent silent disables. Fixed with a regression test; the class needs a
    sweep.
47. ⬜ **Real journeys, not HTTP 200.** fleet-check proves a socket answers. It
    does not prove a user can sign in, buy, or send. One scripted journey per
    platform, run on the same cadence.
48. ⬜ **Cost and model telemetry.** Which agent, which model, how many tokens,
    what it cost — with a budget alarm. Today the only signal that spend went
    wrong is a usage limit at the worst moment.
49. ⬜ **The estate incident timeline.** One ordered view on the deck of what
    happened across both boxes and every platform. The data is in memory
    already; nothing renders it as a story.
50. ⬜ **LESSONS.md distils itself.** The harvester already writes `lessons`;
    the doctrine file is still hand-maintained, so the flywheel stops one step
    short of the thing every session reads.
51. ⬜ **Second-box alert redundancy.** 158 watches the master and can push;
    the master cannot currently hand its alerts over when its own push path is
    the thing that is broken.

---

## OPEN QUESTIONS FOR CRAIG (unblock when convenient)
- Canonical **Vapron** repo (#15): `/opt/vapron`'s origin is a local bare repo, not GitHub — which GitHub repo is canonical? (GateTest resolved 2026-08-08 → `crclabs-hq/GateTest`.)
- Credential scoping (docs/CREDENTIAL-SCOPING.md): branch protection on main across the 7 repos + GitHub App — the ~10 minutes that remove the estate-wide blast radius. Prerequisite for review-runner going live and the SDK/cloud moves.
- 158 housekeeping surfaced 2026-08-08: three plaintext secret files in `/root`, a leftover June `/opt/jarvis` clone, and an undocumented `jarvis-metrics.service` running there (doctrine says no Jarvis services on 158 — bless it or remove it).
- If 158 ever loses its claude login, remote Vapron review pauses — `claude login` there restores it.
- ~~Deploy GateTest site now or wait for Vapron path?~~ ✅ RESOLVED 2026-07-08: gatetest.ai deployed and live from 161 (systemd `gatetest-web` :3000 + Traefik route + LE cert). See /opt/gatetest/docs/deploy/JARVIS-WEB-DEPLOY.md.

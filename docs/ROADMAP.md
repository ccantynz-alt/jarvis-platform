# Jarvis Roadmap & Decisions Ledger

> **This is the single source of truth.** Every agent (Jarvis-dispatched, Vapron's,
> or interactive) reads this at session start and updates it the moment a decision
> changes. If this file disagrees with reality, fix reality *or* fix this file —
> never leave them out of sync. Last updated: 2026-07-15.

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
| **Two-box estate model** — 161 hosts/serves, 158 = Vapron backend over HTTPS, **never SSH between boxes** | ✅ DECIDED 2026-07-08 (Craig) | Cross-box work ships as handoff briefs (docs/handoffs/). Cross-box monitoring/heartbeats go over the **tailnet**, not SSH, not public internet. Supersedes move #16. |
| Cloud executor (`runCloud`) | 🔒 OFF | Stays off until registry repos are fixed (#8) + cloud creds confirmed. |
| Canonical Vapron repo | 🟡 RECOMMEND `/root/Vapron` (`ccantynz-alt/Vapron`, branch `Main`) | Craig to confirm which GitHub repo he actually pushes to. |
| GateTest canonical repo | 🟡 INFER `crclabs-hq/GateTest` | All tonight's work came from there; registry wrongly says `ccantynz-alt/gatetest`. Craig to confirm. |
| **Slack** — keep or drop | 🟡 **STILL ACTIVE, this line was wrong** (corrected 2026-07-20) | This said "retired 2026-07-15", but PR #1 (merged 2026-07-19, "Slack overhaul: kill the notification firehose + fix command understanding") describes Craig actively getting hundreds of live Slack notifications and needing commands fixed — jarvis-slack was never actually disabled. Frozen-legacy retirement criteria are in docs/GATEWAY.md ("Slack: frozen legacy + retirement criteria") and have NOT been met. **Agents: do NOT delete or disable Slack code based on this file's past claim.** |
| Registry repo fixes (gatetest/alecrae/bookaride) | ⏳ PENDING Craig confirm | Blocks safe cloud dispatch. |

## BANKED (done — do not redo)
Dashboard token auth · cups/:631 closed · gluecron-update timer disabled · nightly
memory backups (03:30) · Haiku intent routing · `runCloud` code (flag-off) · Vapron
Phase-0 investigation · GateTest scanner self-contradiction fixed · GateTest MCP endpoint
live (`mcp.gatetest.ai`).

---

## THE 23 MOVES (order = strategy; reliability is the floor)

### Phase 1 — STABILIZE (kill "everything breaks")
1. ✅ Restart policies — all jarvis-* + gatetest-mcp = `Restart=always`, alecrae = `on-failure`. (Container autoheal deferred — could conflict with Coolify; Craig call.)
2. ✅ **DONE 2026-07-20** — Resource guards: all 15 jarvis-* systemd units now set `MemoryMax`/`CPUQuota` (was previously just metrics-collector.js's software pre-OOM alerting, no hard cgroup cap) — one runaway service (Chromium in browser-service/screenshot-service, or orchestrator's spawned Claude agents) can no longer OOM the box and starve AlecRae/Gluecron/GateTest. Also created the previously-missing `jarvis-browser.service` unit (browser-service.js existed in src/ but had no systemd unit at all).
3. ✅ Off-box watcher extended to the whole public fleet (`jarvis-fleet-watcher`, hourly, deduped GitHub-issue alerts, known-down list to avoid noise).
4. ⬜ Consolidate the proxy layer (4 front doors → 1) — endgame is Vapron (#18).
5. ✅ Restore-drill passed — backup recovers faithfully (all tables match, integrity ok).

### Phase 2 — ALIGN (stop the burning)
6. ✅ This ledger — every agent reads/updates it.
7. 🔄 Point all CLAUDE.mds here; enforce Rule 0.
8. ⬜ Fix registry repo mismatches.
9. 🔄 Enforce session protocol — auto-log repairs to memory.

### Phase 3 — AUTOMATE (self-running)
10. ⬜ Agent runtime → Claude Agent SDK, scoped permissions.
22. ✅ **DONE 2026-07-15** — Durable job queue + CLI canary gate (agent-org Phase 1): jobs survive restarts in SQLite (`jobs`/`job_transitions` via :9200), scheduler tick with `MAX_CONCURRENT_JOBS` + timeouts, boot recovery re-queues interrupted jobs, and `spawn-agent.js` holds all dispatch behind a CANARY-OK probe whenever the claude CLI version changes (kills the 2.1.207-class silent-failure mode).
23. 🔄 **IN PROGRESS 2026-07-19** — Agent-org roster + scheduler + Slack retirement (Phase 2): 44 role agents registered — the original 19 (social-media × 9 platforms; accountant + legal × NZ/AU/US/UK/SG, DRAFT-only honesty framing) plus a REAL C-suite (cto/cmo/cfo/clo/coo/cro — weekly roll-up agents, not the deck's old cosmetic tiles) that `reports_to` now actually routes through, plus seo-specialist-* and site-medic-* on the same 9-platform roster. `jarvis-agents` (:9209) cron-dispatches them budget-capped and routes reports up the escalation ladder into the Gateway inbox. Verified end-to-end; deck Hierarchy tab renders the real tree. jarvis-slack disabled; deploy-gate repointed to notify(). 158 watchdog alert cutover is **done** (`jarvis-heartbeat.timer` on 158 posts to `/internal/heartbeat` every 5 min on a scoped `JARVIS_HEARTBEAT_TOKEN_vapron158`, verified live). Remaining: flip `AGENTS_MODE` dry-run→live (Craig's call, after reviewing one dry-run cycle).
11. ⬜ Enable cloud executor (after #8 + creds).
12. 🔄 **IN PROGRESS 2026-07-20** — Self-repair: `deploy-gate.js` now auto-dispatches a fix job (via the existing LOCAL/remote `/dispatch` path, not yet the cloud executor — #11 is still off) when a post-deploy GateTest scan finds critical issues, instead of only posting an advisory alert. Guarded by `consecutiveBlockedRuns()` — caps at `AUTO_FIX_MAX_ATTEMPTS` (2) consecutive auto-fix attempts per platform before escalating to a human alert instead of re-dispatching forever (the exact DavenRoe-style stuck-loop failure mode found elsewhere this session). Craig's ruling 2026-07-20: "deploy, push, merge = healthy up to date system" — don't wait on him to notice a broken deploy.
13. ⬜ Auto-dispatch + guardrail layer (the guardrail piece is now partly covered by #12's consecutiveBlockedRuns cap + the new `/jobs/loops` stuck-dispatch detector in orchestrator.js, added the same session).
14. ⬜ Intent routing → HTTP API (~300ms vs ~4-10s CLI).

### Phase 4 — CONSOLIDATE onto Vapron
15. ⬜ Confirm canonical Vapron repo; clean 3-checkout mess.
16. ~~Add Jarvis SSH key to 158~~ **SUPERSEDED 2026-07-08 by estate model: never SSH between boxes.** ✅ **DONE 2026-07-19** — 158 is on the tailnet (`vapron-158.tailbd6217.ts.net`), exposes health tailnet-only (`tailscale serve --https=8443 → 127.0.0.1:9095`, Vapron's ops-agent), and `jarvis-heartbeat.timer` posts every 5 min to the Gateway's `/internal/heartbeat`. Registry (`platforms.json`) still needs the tailnet health URL wired in (`vapron.server` is the tailnet IP already; a `health_url` field is the remaining piece).
17. 🔄 Onboard GateTest to Vapron as pilot tenant #1.
18. ⬜ Migrate off Coolify → Vapron proxy (endgame of #4).
19. ⬜ Roll remaining platforms onto Vapron.

### Phase 5 — INTERFACE (the product)
20. 🔄 Jarvis Gateway MVP — private mesh, streaming brain, voice in/out. Tailscale mesh + jarvis-gateway (:9208, `tailscale serve` HTTPS) are live and voice-tested; iPad/phone shakedown is ongoing. Spec: docs/GATEWAY.md.
21. 🔄 Embodied Jarvis — lip-synced live avatar + one custom voice (TTS via Vapron). **Custom-voice half live 2026-07-16:** ElevenLabs neural voice is wired into the Command Deck (`src/lib/tts.js`, `GET /tts` on :9210 — cache, daily char budget, `TTS_DISABLED` kill switch; awaiting a valid `ELEVENLABS_API_KEY`). Avatar half untouched; Vapron-hosted TTS remains the end-state.

---

## OPEN QUESTIONS FOR CRAIG (unblock when convenient)
- Canonical repo per platform (esp. gatetest: `ccantynz-alt/gatetest` vs `crclabs-hq/GateTest`).
- ~~Deploy GateTest site now or wait for Vapron path?~~ ✅ RESOLVED 2026-07-08: gatetest.ai deployed and live from 161 (systemd `gatetest-web` :3000 + Traefik route + LE cert). See /opt/gatetest/docs/deploy/JARVIS-WEB-DEPLOY.md.

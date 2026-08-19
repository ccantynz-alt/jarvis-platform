# Marco & the Command Deck — full-stack audit and the 50 moves

**Date:** 2026-08-19 · **Method:** live probes of the box (`ssh jarvis`, `ssh vapron`), the journal, the KV, the SQLite DB, then a code-level read of every brain/deck/PC/org/infra file. The MDs were deliberately NOT trusted; where they disagreed with the box, the box won.

**Ask (Craig):** make Marco the most efficient, intelligent, advanced brain possible; make the Command Deck the same; make it work on the phone; let me ask it anything about my PC; Google UK English male voice; fast Claude research models; 50 smartest moves; own platforms first, commercial if possible.

---

## 0. What is actually true today (the probe, not the docs)

| Fact | Evidence |
|---|---|
| **The brain is dead right now, and so is every autonomous timer.** Both claude.ai logins on the master are expired (`OAuth session expired and could not be refreshed` on `default` AND `account-b`). 11 services report green. | `claude --print hi` on the box (both profiles); KV `claude-profile-authbroken:default`; `jarvis-experience`: `FAIL agent_spawns: no agent spawn has ever authenticated`; jobs last 3 days: 42 failed / 1 completed |
| It is NOT the org this time. 158's own login works (CLI 2.1.223 answered `OK`). The master's two credential files are stale (last written 08-11 and 08-15). | `ssh vapron claude --print`; `ls -la /root/.claude/.credentials.json` |
| **The phone reaches the deck and the deck refuses it.** `[deck] 403 for 100.111.46.68 (ccantynz@gmail.com)` ×10 in 14 days — that is the iPhone's tailnet IP, identified by Tailscale's own whois header, refused because the only credential was a token in a file on the box. **FIXED TODAY** (Tailscale identity login; see §1). | deck journal; `tailscale status` (iphone182 = ccantynz@, iOS) |
| The deck spawned a `claude` situation-agent **every 15 s**, each dying in ~2 s, for three days: 34,821 journal lines. **FIXED TODAY** (10-min back-off per failed fingerprint, honours `authHeld`). | `journalctl -u jarvis-deck` count; `deck-server.js` refreshSituation |
| The deck was running build `6bb2868` while HEAD was `898d64c` (never restarted after the last pull). **FIXED TODAY** (restart; now `df4e680`). | `/health` build stamp |
| While the brain is dead the "basic pipeline" turns random speech into dispatch proposals: *"Ready to dispatch to auto: love you what. Shall I proceed?"*. The degraded mode is actively dangerous, not just dumb. | KV `jarvis-conversation` tail |
| `claude setup-token` (a long-lived subscription token, `CLAUDE_CODE_OAUTH_TOKEN`) exists on the box's CLI and **nothing in the code or units uses it**. The whole brain rides on short-lived OAuth refresh tokens that need a human in a browser. | `claude setup-token --help`; grep of src/ + systemd/ |
| The brain's `WebSearch`/`WebFetch` built-ins are **disallowed**; research is a DuckDuckGo HTML scrape clipped to 4,000 chars. | `brain-claude.js` disallowedTools; `browser-service.js:250-282` |
| The brain has no clock, no memory pen (cannot write a note/reminder/lesson), and forgets everything past 24 messages on any restart. Deck and gateway each run their OWN model session; a thing said to one is unseen by the other until a cold restart. | `brain-tools.js:42-63`; `brain-claude.js:129,237-248,358` |
| Voice: `VOICE_PREFS` already puts **Google UK English Male** first (correct). On iOS that voice does not exist; it falls to Apple's Daniel, but `u.lang` is never set so an empty voice cache yields the US default. | `command-deck.html:1198-1225` |
| `authHeld` is produced by the spawner and consumed by **nobody**; every auth-failed job is marked FAILED and the task is lost. | `spawn-agent.js:171` vs `orchestrator.js:310` |
| 371 `open` findings have no exit path; 16 proposals sit unreviewed; review-runner burns up to 216 ten-minute turns/day producing log lines in dry-run; 490 notifications in 7 days. | DB counts; `review-runner.js:163,226` |
| `/pc/action` (incl. `shell`) and `/dispatch` to `craig-pc` are gate-less on loopback: any root agent on the box (all of them run `--dangerously-skip-permissions`) can run PowerShell on Craig's PC unconfirmed. | `orchestrator.js:776-854` |
| Tests: 33 suites, 491 tests, 477 pass / 0 fail / 14 env-skipped. Lint is box-only. No tests for brain-claude, brain-tools, agent.js, orchestrator, deck-server. | `npm test` locally |
| Commercial: the brain and every agent run on Craig's **personal claude.ai subscription**. Reselling that to third parties is against Anthropic's consumer terms — a product must use the metered API or customers' own keys. | `brain-claude.js:2-7`, `claude-auth.js` |

## 1. Done today (commit `df4e680`, deployed and verified live)

1. **Tailscale identity unlocks the deck** — `src/lib/tailnet-identity.js` + `DECK_TAILNET_USERS=ccantynz@gmail.com` on the box. Verified: identity → `200` + cookie stamped; stranger → `403`; no identity → `403`; `/api/ops` with identity → `200`. The WebSocket upgrade accepts identity too, and an identity-authed load stamps the cookie so the iOS home-screen PWA (own cookie jar) keeps working. **Craig: turn Tailscale ON on the iPhone (enable VPN On Demand) and open `https://jarvis.tailbd6217.ts.net:8444` — no token.**
2. **Situation synthesis back-off** — one attempt per failed picture per 10 min; `authHeld` honoured.
3. **Brain auth failover mid-turn** — the auth branch now retries on the other login like `usage_limit` does, and stops re-warming a session on a login it just proved dead.
4. Deck restarted onto HEAD.

**Craig-only, today:** `claude login` on the box for both profiles (`claude login` and `CLAUDE_CONFIG_DIR=/root/.claude-profiles/account-b claude login`). Until then Marco is a keyword bot and the 8 timers do nothing. Better: do move #1 below instead, once, and never do this again.

---

## 2. The 50 moves

Legend — **Effort:** S (≤½ day) · M (1–3 days) · L (a week+). **Who:** J = Jarvis/Claude can do it unattended; **C** = needs Craig (credential, ruling, admin, money). Every move cites the code it changes.

### A. Stop being broken — the reliability floor (1–12)

1. **Long-lived credential leg (`claude setup-token`).** Run it once per account, store `CLAUDE_CODE_OAUTH_TOKEN_<profile>` in `secrets.env`, inject as `CLAUDE_CODE_OAUTH_TOKEN` in `profileEnv()` (`claude-auth.js:134`), keep it as a profile so failover/alerts still work. Kills the entire "OAuth session expired" class (not org-toggles). **S · C (one browser step) + J.**
2. **Auth hold everywhere limit hold is.** Consume `authHeld` in `orchestrator.js:310`, `code-health.js:413/627`, `review-runner.js:172`, `session-harvester.js:335`; add `authHold()` beside `usageHold()` in the scheduler gate so queued jobs PARK instead of burning; harvester must not mark sessions `distill_status='failed'` on auth. **S · J.**
3. **Liveness, not file-exists.** `hasClaudeAuth()` = "a credentials file exists" (`claude-auth.js:61-72`). Make `hasAgent()` consult the durable `authbroken` markers + last-good-turn so the deck drops to honest "BRAIN DOWN" instantly instead of a cold spawn per utterance. **S · J.**
4. **Brain heartbeat.** Call `noteSpawnSuccess(profile)` on every successful brain turn (`brain-claude.js:357`) so `claude-last-spawn-ok`, recovery notices and `jarvis-experience` reflect reality (today it says "never authenticated" even when Marco is talking). **S · J.**
5. **Health-triggered canary.** Run `ensureClaudeVerified` when `claude-last-spawn-ok` is >2 h old or after 3 consecutive non-zero exits; hold all dispatch on failure. Turns "three days of silence" into a ten-minute alert. **S · J.**
6. **Make the degraded mode safe.** When the brain is down, the keyword pipeline must answer status questions and say "brain offline" — never stage a dispatch from free speech (`conversation.js:1026-1027` passthrough). Per-turn `alert` on total brain failure (`agent.js:277-282`) → one durable daily marker. **S · J.**
7. **Durable everything a oneshot touches.** Push caps (`push.js:53-58`) into KV; review-runner verdict fingerprints into KV; scheduler `firedThisMinute` (`agent-scheduler.js:53`) into KV. **S · J.**
8. **One spawn governor.** Every `claude` spawn (timers, deck situation, harvester, code-health, brain-adjacent) takes a KV-backed `acquireSpawnSlot()`: global concurrency cap, per-window subscription budget, `usageHold` AND `authHold` checked BEFORE spawning. Today ~8 concurrent CLIs are possible with no shared ledger. **M · J.**
9. **Classify failures from the SDK's structured result, not prose regexes.** `classifyFailure` (`claude-auth.js:147-204`) should read the SDK `result` message's `subtype`/error fields; the org-disabled regex is keyed to 2.1.223 wording the master's 2.1.220 never emits. Also: keep the fleet's CLIs on the SAME version (master 2.1.220 vs 158 2.1.223). **S · J.**
10. **Retention + indexes in memory.** Nothing is ever deleted (`memory-server.js` has no DELETE/VACUUM); `notifications` has no index and is full-scanned every 15 s. Nightly age-out (>90 d) for notifications/job_transitions/agent_reports; index `notifications(source,level,title,ts)`; age untouched `open` low/medium findings to `stale` (the schema already allows it — debt #8). **S · J (the stale rule is C's call).**
11. **Internal auth on :9200/:9205 writes.** Every co-tenant process on the box can rewrite findings, approve proposals, enqueue jobs. One `JARVIS_INTERNAL_TOKEN` on mutating routes. **M · J.**
12. **Restore drill + off-vendor backup.** `backup-memory.sh` pushes to 158 — same vendor, same tailnet. Add an S3/B2 copy and a scripted restore that is actually run monthly. **S · C (bucket) + J.**

### B. Make Marco Gemini/Grok-class (13–26)

13. **Turn on Claude's native WebSearch + WebFetch for the brain.** They are explicitly disallowed (`brain-claude.js:149-163`) in favour of a DuckDuckGo scrape. Anthropic-side search is the "fast research model" Craig is asking for: ranked, current, no SSRF exposure on the box. Keep `browser-service` for rendered screenshots. **S · J.**
14. **A clock and a memory pen.** Add NZ date/time + Craig's profile to the per-turn prefix (`brain-claude.js:357`), and tools `remember(note)`, `recall(query)`, `set_reminder(when,text)` on a new additive `notes` table with a timer that `notify()`s. Today nothing Marco learns in conversation survives 24 messages. This is the single biggest gap vs Gemini/Grok. **M · J.**
15. **One brain session, not two.** Deck and gateway each hold their own model child (`brain-claude.js:129`). Either a single brain owner (`brain-server` on a Jarvis port) or per-turn injection of "what the other surface said since my last turn". Persist/resume the SDK session id across restarts instead of the 11-line recap. **M · J.**
16. **Latency control by effort.** Pass `effort:'low'` (or `maxThinkingTokens`) for conversational turns and default effort only when tools are in play; voice needs first tokens, not deliberation. Re-fit the 20 s/35 s watchdogs after. **S · J.**
17. **Model routing table** in `spawn-agent.js`: Haiku 4.5 for verify/recheck/distill/situation/officer-verdict/canary; pinned Sonnet-class ID for role agents; Opus 5 for repair/build; Fable 5 for escalation. Today repairs default to Fable 5 (`orchestrator.js:80`), most spawns are UNPINNED ("whatever `claude` defaults to"), and nothing uses a Haiku-class model except the fallback classifier. Add `model` to `spawnClaudeRemote`; honour `job.model` in `pc-worker.js:184`. **M · J.**
18. **Semantic memory.** `query_memory` is a regex router over a hardcoded platform list (`memory-server.js:1166-1288`). Add SQLite FTS5 over lessons/findings/repair_log/notes first (cheap, huge win); embeddings later. **M · J.**
19. **Vision.** `render_page` returns a *path string* — the model never sees pixels. Return screenshots as image content blocks through the MCP bridge; let Marco look at a site, a chart, a PC screenshot. Raise the 4,000-char tool-result clip (`brain-claude.js:122`) with `page/offset` params. **M · J.**
20. **MCP connectors for the brain.** The SDK session accepts `mcpServers`; Craig's claude.ai already has Gmail, Calendar, Drive, GitHub connectors. Give Marco email/calendar/drive/GitHub/Coolify read (write behind the confirmation gate). This is what "ask it anything" means in practice. **M · C (connector auth) + J.**
21. **Registry-driven everything.** `PLATFORM_URLS` (`conversation.js:58-65`), `KNOWN_PLATFORMS` (`memory-server.js:1173`), `metrics-collector.js:105-111`, `audit-runner.js:51-109` are four more registries in code; DavenRoe is invisible to half the tools. One source: `platforms.json`. **S · J.**
22. **Rebuild the system prompt per turn** (it is frozen at session start, `brain-tools.js:55`) with live registry, recent lessons (top 5 by recency), open reminders, and the experience-check verdicts. **S · J.**
23. **Streaming, markdown, history on every surface.** Deck already streams; add a safe markdown renderer in bubbles and `GET /api/transcript` on boot so the phone shows the conversation it joined. **S · J.**
24. **Brain telemetry table** — `brain_turns(ts, surface, model, profile, first_token_ms, total_ms, tokens_in/out, tools_used, outcome)` from `brain-claude.js` + `spawn-agent.js` (use `--output-format json`); show on the OPS tab. Without it every "faster/smarter" claim is unmeasured and the subscription→API move is blind. **S · J.**
25. **Tests that carry the incident** for brain-claude/brain-tools/agent.js (fake `query()`): auth failover-and-continue; both dead → one alert/day + no re-warm; cross-surface recap; `authHeld` honoured by a mock orchestrator. **M · J.**
26. **Delete the unreachable metered loop** (`agent.js:295-586`) or put it behind a real flag file — 300 lines that can never run mislead every reader; keep `ANTHROPIC_API_KEY` only for the Haiku classifier. **S · J.**

### C. The Command Deck on the phone (27–36)

27. **Phone login: done today** (move A-1 of the deck). Remaining Craig step: Tailscale ON + VPN On Demand on the iPhone. **C.**
28. **PWA plumbing.** Manifest is behind auth and `<link rel=manifest>` lacks `crossorigin="use-credentials"` → the manifest 403s and no real install is ever offered (`deck-server.js:239-249`, `command-deck.html:7`). Make manifest + icons public; add `scope`, `shortcuts`; add a minimal service worker that precaches the shell and shows a deck-branded "you're off the tailnet — open Tailscale" page instead of Safari's error. **S · J.**
29. **Reconnect on foreground + silence the greeting.** No `visibilitychange`/`pageshow`/`online` hook (`command-deck.html:2194-2197`) → up to ~105 s dead after unlocking the phone; then "Live link established, sir" is spoken on EVERY reconnect (`:2344`). **S · J.**
30. **iOS-aware mic: push-to-talk.** iOS is one-shot, no interim → no wake-word chime; the 3-s watchdog + relisten loop restarts the recogniser forever (`:1685-1696`, `:1742-1753`) → battery drain and `service-not-allowed`. On iOS default to hold-to-talk, stop the watchdog, give up after N errors with an on-screen remedy, never persist `off` on a one-time `not-allowed`. **M · J.**
31. **Mobile layout pass (one CSS block).** `100vh` → `100dvh`; `env(safe-area-inset-*)` on cmdbar/topbar; `#cmd` 14px → 16px (iOS auto-zoom); tabs → bottom bar under 700 px; findings `title=` hover → tap-to-expand (`:24,:40,:94,:704-709`). **S · J.**
32. **Voice that survives iOS.** Set `u.lang='en-GB'` (`:1222`); reload voices inside `primeTTS`; start `voiceEngine` at `browser` when `/health` says `tts:false` instead of probing `/tts` every session; add a Voice settings sheet (pick/rate/lang/test). Google UK English Male stays first. **S · J.**
33. **Honest brain state on screen.** Push provider/health + `authbroken` into the link badge on every connect (`deck-server.js:999-1007`) so a phone that joins mid-outage sees "BRAIN DOWN — basic mode", not dumb answers; surface situation failures as a stale banner. **S · J.**
34. **Web Push for alerts** via service worker + VAPID (`/api/push/subscribe`; fan-out beside ntfy in `push.js`). Today the phone only buzzes if the ntfy app is installed and subscribed to a secret topic. iOS needs the home-screen install (move 28). **M · J.**
35. **Quick actions + share.** Chips for status / briefing / what-needs-me / show-me-last; `navigator.share` on the show panel; `?q=` deep link into `sendCommand`. **S · J.**
36. **Extract the deck's state machine** into `src/lib/deck-*.js` ESM served same-origin, one `busy()` predicate, typed state; retire `public/gateway.html` (unserved since `gateway-server.js:103`) and the test that keeps it "in step". The 2,611-line file with 32 mutable globals is why every voice fix regresses another. **L · J.**

### D. "Ask Marco anything about my PC" (37–42)

37. **Server-side gate for PC mutation.** `/pc/action` mutating verbs and `/dispatch` to `craig-pc` require a signed, single-use confirmation token minted by `resolveDispatchGate`, bound to the verb+args hash; loopback callers without it get 403 (`orchestrator.js:776-854`). Today it is root-agent RCE on Craig's PC. **M · J.**
38. **A real read-only verb set** (all `mutates:false`, instant): `cpu.top` (sampled % — today `process.list` reports lifetime CPU-seconds, so "what's using my CPU" is answered with the wrong metric, `pc-actions.js:97-102`), `disk.usage`, `gpu.info`, `net.info`, `apps.list`, `windows.list`, `battery`, `updates.status`, `sessions.who`, `files.find/recent` (allowlisted roots), `startup.list`, `tasks.list`, `screen.capture` → deck `/internal/show`. Plus a `pc_snapshot` composite cached 60 s so "how's my PC" is one hop. **M · J.**
39. **Split `shell`** into `shell.read` (Get-*/Test-*/Measure-* allowlist, instant) and `shell.exec` (gated, FULL command shown on the deck — today the preview truncates at 200 chars, `pc-actions.js:277`, and TTS of PowerShell is unintelligible). Log every exec to the inbox on success too. **S · J.**
40. **Late-result delivery.** After the 45-s wait a PC answer goes nowhere (`orchestrator.js:827-838`); attach a watcher that speaks it when it lands; short-circuit when `last_seen > 120 s`; fix `gate.launched.ok` truth (`conversation.js:680`) and "Done, sir." swallowing the output (`:651`). **S · J.**
41. **Long-poll then WebSocket.** `claim?wait=25` is a one-line server change (3 s → ~100 ms); then an outbound WSS from the PC carrying claim/heartbeat/result/stream/cancel on one connection. ~40k idle requests/day today. **S then M · J.**
42. **Bind the worker identity + elevated install.** Server-assigned `worker_id`, HMAC'd results, rate-limited `/worker/*`, tailscale identity on that path; Craig runs `install-pc-worker.ps1` as admin ONCE (unblocks service control + SYSTEM watchdog). **S · J + C.**

### E. The autonomous org — efficient, not busy (43–47)

43. **Stop the burn:** review-runner must not spawn in dry-run (`review-runner.js:163` runs before the mode check at `:190`; `pickForReview` wraps → same proposals re-reviewed forever); situation fingerprint excludes job churn. **S · J.**
44. **Batch + dedupe:** one verifier turn per code-health sweep over all new findings; one harvester turn per N small sessions; review only proposals whose artifact HEAD changed. **M · J.**
45. **Kill noise, merge duplicates:** site-medic → a code-health lens filing `code_findings`; social-media ×9 daily (63 drafts/week, no posting path) → weekly or retired until a publish pipeline exists; accountants/legal → NZ only unless Craig names a jurisdiction; role budgets count only `completed` jobs (`agent-scheduler.js:96-105` counts failures → "over budget" warns + 3 notifications per failed job). **S · C (ruling) + J.**
46. **Quality feedback loops:** rubric-score each agent report with Haiku (specificity, novelty vs last, actionability) → auto-hold low scorers; track verifier precision per lens; track fix-runner merge rate. **M · J.**
47. **SDK instead of CLI for structured one-shots** (verifier, recheck, distill, situation, officer verdict) — in-process `query()` with a typed output schema and no tools; removes spawn cost, gives JSON reliably, enables batching. Second leg: run read-only sweeps on 158 in parallel (its own login — it works today while the master's doesn't). **M · J.**

### F. Product — own platforms first, sellable second (48–50)

48. **Licensing first, plainly:** a product cannot run on Craig's claude.ai subscription. The product path is the metered Anthropic API (Agent SDK with `ANTHROPIC_API_KEY`) or BYO key per customer — which also forces the cost accounting (move 24) that doesn't exist. The subscription stays for Craig's own estate. **Ruling · C.**
49. **Tenant + brand as config:** `tenant_id` on every table, a `users` table with roles replacing three static tokens, per-tenant `platforms.json`/secrets/personas, `PRINCIPAL_NAME`/honorific/assistant name/wake word as env (≈500 literal "Craig"/"sir" sites: `brain-tools.js:46`, `agent.js:143`, `deck-server.js:1181`, personas), `JARVIS_HOME`/`JARVIS_USER` instead of `/opt/jarvis` + `root` (134 + 45 literals), systemd templates, an installer that brings up deck/dashboard/worker auth (19+ env vars missing from `secrets.env.example`). **L · J.**
50. **Package the governance layer as the headline** — PROPOSE → REVIEW → APPROVE → EXECUTE with an append-only audit trail is the defensible, already-tested, tenant-agnostic part; and split the product repo from the estate repo (this one is PUBLIC and carries IPs, tailnet names and topology in `platforms.json` notes). **M · C + J.**

---

## 3. Suggested order (what to do this week)

1. **Craig (10 min):** Tailscale ON on the iPhone + open the deck; `claude setup-token` for both accounts (or `claude login` ×2 today).
2. **Jarvis, unattended, in this order:** 2 → 3 → 4 → 6 → 43 → 13 → 16 → 29 → 31 → 32 → 33 → 28 → 38 → 39 → 40 → 41 (long-poll) → 10 → 7 → 21 → 24.
3. **Then the M-sized brain moves:** 14 → 15 → 17 → 18 → 19 → 20, each with a regression test carrying its incident.
4. **Rulings for Craig:** 45 (which agents to keep), 10 (what `stale` means for the backlog number), 48 (product licensing), 37 (PC gate design).

## 4. Standing diagnostics (one line each)

- Fleet quiet but green? `claude --model claude-opus-5 --print hi` on the box, both profiles.
- Phone can't open the deck? `journalctl -u jarvis-deck | grep "403 for"` — if the line carries `(ccantynz@gmail.com)` the deck is the problem; if nothing, Tailscale is off on the phone.
- Voice weird? `curl 127.0.0.1:9200/memory/kv/jarvis-conversation`.
- Situation spam? `journalctl -u jarvis-deck | grep -c "situation"` per hour should be ≤6.

# Marco in the Loop — Design Spec

**Date:** 2026-08-31
**Status:** Approved direction (Approach A); spec pending Craig's review
**Owner:** Craig Canty / Jarvis
**Origin:** Craig, 2026-08-31: all agents must mirror to Marco ("marco in the loop") so the
fleet's flywheel is learning all the time and compounding knowledge. Plus two companion
asks in the same session: elastic job capacity ("spawn more agents if I load more jobs,
never stop current production") and a lean, self-maintaining box ("daily automated
maintenance, real smart intelligent box").

This is Phase 1 (Memory & Learning core) of the Jarvis advanced roadmap, named Marco.

---

## 1. What Marco is

Marco is two things working as one:

1. **A central shared brain** — an event + lesson store inside the existing Jarvis memory
   DB, exposed through the existing memory-server (:9200) under new `/marco/*` routes.
   Every agent in the fleet writes what it did and learned; every agent reads relevant
   lessons before and during work.
2. **A curator agent** — a daily headless Claude cron job that distills the day's events
   into durable lessons, prunes stale ones, and keeps the store sharp. The store is the
   memory; the curator is the intelligence.

No single agent *is* Marco. Marco is the loop itself.

**Decisions locked in during brainstorm:**
- Capture scope: **structured events + distilled lessons** (not raw transcripts, not
  lessons-only).
- V1 sources: **all four** — Jarvis-box agents, gateway conversations, vapron watchdog
  (remote box), Codex/TRIP runs.
- Loop back: **all three** — start-of-run briefing, ask-Marco query API, periodic digest
  to Craig.
- Build: **Approach A** — evolve the existing memory core; schema kept portable for a
  later lift onto the PG16 platform database with no agent-side changes.

## 2. The Marco store

New tables in `/opt/jarvis/memory/jarvis.db`, served by `src/memory-server.js`:

### `marco_events`
| column | notes |
|---|---|
| `id` | integer pk |
| `ts` | ISO timestamp (server-assigned) |
| `agent` | reporting agent id, e.g. `self-heal`, `accountant-uk`, `gateway`, `vapron-watchdog`, `codex-run`, `claude-session` |
| `host` | `vultr` \| `vapron` \| `pc` — where it ran |
| `platform` | platform slug from `config/platforms.json`, or `box`/`fleet` |
| `action` | short verb phrase: what the agent did |
| `outcome` | `ok` \| `fixed` \| `failed` \| `blocked` \| `noop` |
| `detail` | ≤2 KB free text: what happened, error text, fix applied |
| `tags` | comma-separated lowercase tags for retrieval |
| `session_id` | optional link to sessions table |

### `marco_lessons`
| column | notes |
|---|---|
| `id` | integer pk |
| `created_ts` / `updated_ts` | timestamps |
| `lesson` | the rule itself, imperative, ≤500 chars |
| `why` | evidence in one or two sentences |
| `kind` | `gotcha` \| `workflow` \| `environment` \| `fix` \| `policy` |
| `scope_tags` | platforms/areas this applies to (`vapron`, `deploy`, `box`, `all`, …) |
| `source_event_ids` | comma-separated event ids that produced it |
| `status` | `active` \| `stale` \| `contradicted` |
| `author` | `curator` \| `agent:<id>` \| `craig` |

Existing lesson-like data (session-start lessons feed, `/memory/repair/log` history,
`agent-report` gotchas) is **bridged, not migrated**: new writes flow into Marco; old
tables stay as-is and the briefing endpoint unions the legacy lessons feed until the
curator has re-distilled it (expected within its first week of runs).

## 3. Ingest — everything reports

**Endpoint:** `POST /marco/event` on :9200. Validates fields, assigns `ts`, appends.
Append-only: no update/delete route exists on events.

**Local writers (Jarvis box):**
- `scripts/marco-report.sh <agent> <platform> <outcome> "<action>" "<detail>" [tags]` —
  thin curl wrapper, same ergonomics as `agent-report.sh`.
- `session-end.sh` posts a session-summary event automatically.
- Agent-org jobs: `agent-report.sh` gains a mirror call so existing agents need no change.
- Self-heal: `src/self-heal.js` mirrors each repair (already logged to
  `/memory/repair/log`) as a Marco event — bridge, one code path.
- Gateway: `src/session-harvester.js` distills each finished gateway conversation into
  one event (decisions made, facts learned). No raw transcripts into Marco.
- Codex/TRIP: the TRIP release/implement wrappers post an outcome event per run.

**Remote writer (vapron box):** the watchdog on mail.vapron.ai posts to
`http://jarvis.tailbd6217.ts.net:9200/marco/event` over the tailnet with a bearer token
(`MARCO_INGEST_TOKEN`, stored in each box's env, not in git). :9200 stays bound to
127.0.0.1 + tailnet interface only — never public. If unreachable, the watchdog spools
events to a local JSONL file and retries on its next tick (no data loss, no blocking).

## 4. The loop back

- **Briefing:** `GET /marco/briefing?platform=X&tags=a,b&limit=N` → active lessons scoped
  by platform/tags, most recently confirmed first, capped (default 15) so prompts stay
  lean. Wired into `session-start.sh` (replacing/extending the current lessons feed) and
  into the orchestrator so every spawned job's prompt begins with its briefing.
- **Ask-Marco:** `GET /marco/ask?q=...` → keyword/tag search over lessons and recent
  events (SQLite FTS5). Any agent can call it mid-task. Semantic/embedding search is
  explicitly deferred to the PG16 lift.
- **Digest:** weekly (Sunday) curator output posted to the Command Deck notifications
  and #jarvis-cclabs: new lessons, retired lessons, notable failures, box-health trend.
  Craig stays in the loop too.

## 5. The curator

A daily cron job (03:30, after the janitor) running headless Claude with a fixed prompt:

1. Read yesterday's events + the current active lessons.
2. Distill: propose new lessons (with `source_event_ids`), merge duplicates, mark
   superseded ones `stale`.
3. On contradiction (event disproves an active lesson): mark `contradicted`, flag in the
   digest for Craig — never silently rewrite history.
4. Emit its own run event (`agent=curator`).

**Authority:** write access to `marco_lessons` only, via the API. It can never touch
code, config, services, or other tables. First 48h in dry-run: it writes proposals to
`reports/agents/curator/` instead of the DB.

## 6. Smart box — daily janitor

A second daily cron agent (03:00), whitelist-only, same philosophy as self-heal:

- Log rotation + cleanup: `/opt/jarvis/logs`, stray `*.bak.*` files older than 14 days
  (report first week, delete only after Craig confirms in review), journal vacuum.
- Disk watch: alert threshold 75% (box is at 62% today), with largest-growth offenders.
- Process sweep: zombie processes, dead/failed systemd units, orphaned browser/chrome
  processes from the screenshot service.
- Memory-DB care: SQLite `VACUUM`+`ANALYZE` weekly, verify `backup-memory.sh` output is
  recent and restorable (size + integrity check).
- Security quick-check: failed SSH attempt count, listening-port diff vs a committed
  baseline (`config/ports-baseline.json`), report drift.
- Posts one `box-health` event to Marco daily; anything outside its whitelist becomes an
  `action_needed` agent report to Craig. It repairs only from the whitelist above.

## 7. Elastic capacity — never stop production

`MAX_CONCURRENT_JOBS` in `src/orchestrator.js` (currently fixed guardrail = 3) becomes
adaptive:

- **Scale up** with queue backlog: `slots = clamp(1, ceil(queued/2), ceiling)`.
- **Ceiling from live headroom**, recomputed each tick: base 4 (4-core box); drops
  toward 1 while 1-min load/core > 0.7 or available RAM < 1.5 GB; extends to 6 only
  while the box is clearly idle (load/core < 0.4 and available RAM > 3 GB).
- **Production is sacred:** monitoring, self-heal, memory-server, deck, gateway are never
  competed with — job workers spawn with `nice 10` and `ionice -c3`, and the scheduler
  stops adding slots (existing jobs finish, none are killed) whenever headroom checks
  fail. A running job is never preempted by scaling decisions.
- Manual override respected: if `MAX_CONCURRENT_JOBS` is explicitly set in env, adaptive
  mode is off and the fixed value is used (safe rollback path).
- Every scale-up/down decision is logged as a Marco event (`agent=orchestrator`).

## 8. Guardrails

- **Kill switch:** `config/marco.env` with `MARCO_MODE=off|observe|full` (self-heal
  pattern). `off`: endpoints return 503, crons no-op. `observe`: ingest + briefing live,
  curator/janitor dry-run. `full`: everything live. Launch in `observe`.
- **Flood control:** per-agent daily event cap (default 200) and 2 KB detail cap; over
  the cap, events are dropped with a single warning notification — a crash-looping agent
  cannot flood the DB or the briefing.
- **Auth:** tailnet ingest requires `MARCO_INGEST_TOKEN`; localhost writers exempt.
- **Curator/janitor:** dry-run first 48h; janitor deletes nothing in week 1.
- **DB safety:** Marco tables included in the existing `backup-memory.sh` path
  (verified by the janitor).

## 9. Testing

- Unit: schema + endpoint tests alongside existing memory-server tests (`test/`).
- Integration: post events from each writer type, assert briefing scoping and FTS
  retrieval; simulate vapron push with a wrong/missing token (rejected) and a spool-and-
  retry cycle.
- Curator/janitor: first runs in dry-run reviewed by Craig before `MARCO_MODE=full`.
- Elastic capacity: load a synthetic batch of 12 no-op jobs; assert slots scale to
  ceiling, production services stay responsive (deck health endpoint latency), and slots
  fall back to 1 when idle. Stress check: pin CPU with a test load, assert scheduler
  stops adding slots.

## 10. Rollout order

1. Store + ingest + briefing (the flywheel core) — `MARCO_MODE=observe`.
2. Curator (dry-run → live).
3. Janitor (dry-run → live, delete rights after week-1 review).
4. Elastic capacity (behind explicit-env fallback).
5. Vapron cross-box ingest (token + spool).
6. Gateway + Codex writers.
7. `MARCO_MODE=full`; weekly digest begins.

Each step verified live before the next. Never `git add -A` in /opt/jarvis — the repo
carries live-modified files; commit only files this work touches.

## 11. Out of scope (deferred)

- Embedding/semantic retrieval — arrives with the PG16 platform-database lift.
- Mirroring raw transcripts — events + lessons only, by decision.
- Multi-tenant/product packaging — Jarvis is Craig-only per the north star.
- PC-worker (Windows box) as a Marco writer — revisit after v1 proves out.

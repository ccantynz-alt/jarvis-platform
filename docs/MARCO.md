# Marco — fleet usage guide

Marco is the Jarvis fleet's shared brain: a central event + lesson store (inside the
existing memory-server on :9200) that every agent, session, and platform mirrors into, so
the fleet's flywheel is learning all the time instead of each session starting cold. Full
design: `docs/superpowers/specs/2026-08-31-marco-in-the-loop-design.md`.

## The four calls

Every working session or agent should touch Marco at these points:

1. **`GET /marco/briefing?platform=<p>&limit=8`** — at the start of work. You don't call
   this by hand; it is auto-injected two ways:
   - `scripts/session-start.sh <platform>` fetches it and prints "LESSONS FROM PAST
     SESSIONS" before you start.
   - `src/orchestrator.js`'s `buildPrompt` fetches it for every spawned agent job and
     folds it into the agent's own prompt (2s budget, degrades to empty silently if
     memory-server is slow or down — never blocks a dispatch).

2. **`bash /opt/jarvis/scripts/marco-report.sh <agent> <platform> <ok|fixed|failed|blocked|noop> "<action>" ["<detail>"] ["tag1,tag2"]`**
   — after each meaningful action (a fix, a deploy, a decision, a job outcome). Never
   fails the caller: if Marco is down the script still exits 0, because reporting must
   never break the work being reported.

3. **`GET /marco/ask?q=<text>&limit=10`** — when stuck. Full-text search over prior
   lessons and events; use it to check whether the fleet has already hit this problem.

4. **`bash /opt/jarvis/scripts/agent-report.sh <agent> <job_id> <ok|action_needed|escalate> "<summary>" ["<details>"]`**
   — unchanged, still the role-agent's mandatory end-of-job report to
   `POST /memory/agent-report`. It is bridged into Marco server-side (mirrored as a
   `marco_events` row), so filing it already counts as a Marco touch — no separate call
   needed on top of it.

## The TRIP rule

`TRIP-2-implement` and `TRIP-3-release` runs end with a `marco-report.sh` call, agent name
`codex-run`:

```bash
bash /opt/jarvis/scripts/marco-report.sh codex-run <platform> <ok|failed> "<what shipped>" "<notes>" trip
```

Do this as the last step of the run, after the work is committed/released — it's the
signal that closes the loop for that TRIP pass.

## Privacy boundary

Marco mirrors what agents and the memory pen (`POST /memory/notes`) explicitly choose to
remember — reports, repairs, job outcomes, saved notes/facts/preferences. It does **not**
mirror gateway or brain **conversations**. That boundary is deliberate: the 2026-08-06
live-mic eavesdrop (`docs/LESSONS.md`) is the reason raw conversation capture is off
limits — a held-open mic transcribed 23 minutes of a private household conversation, and
the fix was to bound and gate live capture, not to widen what gets stored. The gateway
notes bridge (`POST /memory/notes` in `src/memory-server.js`) mirrors exactly one thing:
a note the brain already chose to save via the memory pen, as a single `noted: <text>`
event — never the surrounding conversation that led to it.

## MARCO_MODE semantics

Set in `config/marco.env`, hot-reloaded (5s cache, no restart needed):

- **`off`** — kill switch. All `/marco/*` endpoints return 503. Curator and janitor no-op.
- **`observe`** — ingest, briefing, and ask are all live. The curator (lesson
  distillation) runs dry-run only. The janitor is report-only (never deletes).
- **`full`** — everything live, including curator writes and janitor deletions (subject
  to `JANITOR_MODE`).

`config/marco.env` also carries `JANITOR_MODE` (`report` = never delete, only file
reports; `clean` = whitelist deletions allowed) and `MARCO_EVENT_CAP` (per-agent per-day
event cap; flood control — one warning at the cap, silent drops after).

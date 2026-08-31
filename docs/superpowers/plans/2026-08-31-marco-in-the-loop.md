# Marco in the Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fleet agent mirrors structured events into a central Marco store and gets distilled lessons back, with a daily curator, a daily box janitor, and elastic job concurrency that never squeezes production.

**Architecture:** Extend the existing memory-server (:9200, better-sqlite3, WAL) with a `marco_events` table + `/marco/*` routes; **reuse the existing `lessons` table** (additive columns) as the lesson store; bridge existing write paths (agent reports, repair log, job transitions) inside memory-server so most agents need zero changes. Curator = a scheduled role in `config/agents.json`. Janitor = a deterministic bash script on a systemd timer (whitelist maintenance needs no LLM). Elastic capacity = a pure `computeSlots()` in the orchestrator tick.

**Tech Stack:** Node 20 ES modules, express, better-sqlite3 (FTS5 confirmed working), `node --test`, bash + jq + curl scripts, systemd timers, tailscale serve.

**Spec:** `docs/superpowers/specs/2026-08-31-marco-in-the-loop-design.md`

## Global Constraints

- Work happens in `/opt/jarvis` on the live box. **Never `git add -A`** — the repo carries live-modified files (`src/code-health.js`, `src/fix-runner.js`, `src/lib/findings.js`, `src/lib/fix-dispatch.js`, `src/memory-server.js` are already dirty from other work). `git add` only the exact files each task names. If `src/memory-server.js` has uncommitted changes when you start, commit YOUR hunks only (`git add -p`) or coordinate — never sweep up someone else's diff.
- Every env-sourced numeric limit goes through `guardrail()` / `clampLimit()` from `src/lib/guardrail.js` (NaN fails closed, see the file's header for why).
- `config/*.env` files: comments on their OWN lines only — systemd EnvironmentFile does not strip inline comments.
- All timestamps ISO-8601 UTC via `new Date().toISOString()`.
- Table changes are additive only (`CREATE TABLE IF NOT EXISTS`, `try { ALTER TABLE ... } catch {}` — the established migration pattern at `src/memory-server.js:297`).
- Restarting a service: `systemctl restart jarvis-memory` (or `jarvis-orchestrator`); verify with `curl -s http://127.0.0.1:9200/memory/health`.
- Tests: `cd /opt/jarvis && node --test test/<file>.test.js`; lint with `npx eslint <files>` before each commit.
- Secrets (`MARCO_INGEST_TOKEN`) live in `config/secrets.env`, never in git. `config/marco.env` (non-secret modes/caps) IS committed.
- Launch state is `MARCO_MODE=observe`. Nothing in this plan flips it to `full` — that is Craig's call after dry-run review (Task 12 checklist).
- Redact before store: any free text persisted from agents runs through `redactSecrets()` from `src/lib/harvest.js`.
- Privacy hard rule (docs/LESSONS.md, 2026-08-06): brain/gateway *conversations* are never harvested. The gateway feeds Marco only via explicitly saved notes (Task 11).

---

### Task 1: Pure logic — `src/lib/marco.js`

**Files:**
- Create: `src/lib/marco.js`
- Test: `test/marco.test.js`

**Interfaces:**
- Consumes: `redactSecrets(text)` from `src/lib/marco` sibling `./harvest.js`.
- Produces (later tasks rely on these exact signatures):
  - `normalizeEvent(raw) -> {ok: true, event} | {ok: false, error: string}` — event fields: `agent, host, platform, action, outcome, detail, tags, session_id`
  - `OUTCOMES` — `['ok','fixed','failed','blocked','noop']`
  - `capVerdict(countToday, cap) -> {allowed: boolean, warn: boolean}` — `warn` is true exactly when `countToday === cap` (fire ONE warning, then drop silently)
  - `parseMarcoEnv(text) -> {mode: 'off'|'observe'|'full', janitor: 'report'|'clean', eventCap: number}`

- [ ] **Step 1: Write the failing tests**

```js
// test/marco.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, capVerdict, parseMarcoEnv, OUTCOMES } from '../src/lib/marco.js';

test('normalizeEvent accepts a minimal valid event and fills defaults', () => {
  const r = normalizeEvent({ agent: 'self-heal', platform: 'vapron', action: 'restarted unit', outcome: 'fixed' });
  assert.equal(r.ok, true);
  assert.equal(r.event.host, 'vultr');           // default host
  assert.equal(r.event.detail, '');
  assert.equal(r.event.tags, '');
});

test('normalizeEvent rejects missing agent/action and bad outcome', () => {
  assert.equal(normalizeEvent({ platform: 'x', action: 'y', outcome: 'ok' }).ok, false);
  assert.equal(normalizeEvent({ agent: 'a', platform: 'x', outcome: 'ok' }).ok, false);
  assert.equal(normalizeEvent({ agent: 'a', platform: 'x', action: 'y', outcome: 'great' }).ok, false);
  assert.ok(OUTCOMES.includes('blocked'));
});

test('normalizeEvent clamps detail to 2048 chars and redacts secrets', () => {
  const r = normalizeEvent({ agent: 'a', platform: 'box', action: 'x', outcome: 'ok',
    detail: 'key sk-ant-abcdefghijk1234567890 ' + 'z'.repeat(3000) });
  assert.equal(r.event.detail.length <= 2048, true);
  assert.equal(r.event.detail.includes('sk-ant-abcdefghijk'), false);
});

test('normalizeEvent normalizes tags: lowercase, trimmed, deduped, comma-joined', () => {
  const r = normalizeEvent({ agent: 'a', platform: 'box', action: 'x', outcome: 'ok',
    tags: ['Deploy', ' deploy ', 'SSH'] });
  assert.equal(r.event.tags, 'deploy,ssh');
});

test('capVerdict: allowed under cap, warns exactly at cap, silent-drops past cap', () => {
  assert.deepEqual(capVerdict(10, 200), { allowed: true, warn: false });
  assert.deepEqual(capVerdict(200, 200), { allowed: false, warn: true });
  assert.deepEqual(capVerdict(201, 200), { allowed: false, warn: false });
});

test('parseMarcoEnv: defaults, valid values, junk falls back safe', () => {
  assert.deepEqual(parseMarcoEnv(''), { mode: 'off', janitor: 'report', eventCap: 200 });
  const t = 'MARCO_MODE=observe\nJANITOR_MODE=clean\nMARCO_EVENT_CAP=500\n';
  assert.deepEqual(parseMarcoEnv(t), { mode: 'observe', janitor: 'clean', eventCap: 500 });
  // inline comment poisons the value (systemd lesson) -> falls back, not NaN
  assert.equal(parseMarcoEnv('MARCO_EVENT_CAP=500 # cap').eventCap, 200);
  assert.equal(parseMarcoEnv('MARCO_MODE=banana').mode, 'off');
});
```

- [ ] **Step 2: Run to verify failure** — `node --test test/marco.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement `src/lib/marco.js`**

```js
// marco.js — pure logic for the Marco fleet-knowledge flywheel (2026-08-31).
// Spec: docs/superpowers/specs/2026-08-31-marco-in-the-loop-design.md
// Everything here is testable without a DB or a server, same contract as harvest.js.
import { redactSecrets } from './harvest.js';

export const OUTCOMES = ['ok', 'fixed', 'failed', 'blocked', 'noop'];
const DETAIL_MAX = 2048;

export function normalizeEvent(raw) {
  const r = raw || {};
  for (const f of ['agent', 'platform', 'action']) {
    if (typeof r[f] !== 'string' || !r[f].trim()) return { ok: false, error: `missing ${f}` };
  }
  if (!OUTCOMES.includes(r.outcome)) return { ok: false, error: `outcome must be one of ${OUTCOMES.join('|')}` };
  const tags = Array.isArray(r.tags) ? r.tags
    : typeof r.tags === 'string' ? r.tags.split(',') : [];
  const cleanTags = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].join(',');
  return {
    ok: true,
    event: {
      agent: r.agent.trim().slice(0, 64),
      host: (typeof r.host === 'string' && r.host.trim()) ? r.host.trim().slice(0, 32) : 'vultr',
      platform: r.platform.trim().toLowerCase().slice(0, 64),
      action: redactSecrets(r.action.trim()).slice(0, 200),
      outcome: r.outcome,
      detail: redactSecrets(String(r.detail || '')).slice(0, DETAIL_MAX),
      tags: cleanTags,
      session_id: Number.isInteger(r.session_id) ? r.session_id : null,
    },
  };
}

// Flood control: one loud warning AT the cap, silence past it — a crash-looping
// agent must not turn the warning channel into the flood.
export function capVerdict(countToday, cap) {
  if (countToday < cap) return { allowed: true, warn: false };
  return { allowed: false, warn: countToday === cap };
}

// config/marco.env parser. Malformed values fall back CLOSED (mode off, default
// cap) — the guardrail.js lesson: never let a bad value silently fail open.
export function parseMarcoEnv(text) {
  const kv = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  const mode = ['off', 'observe', 'full'].includes(kv.MARCO_MODE) ? kv.MARCO_MODE : 'off';
  const janitor = ['report', 'clean'].includes(kv.JANITOR_MODE) ? kv.JANITOR_MODE : 'report';
  const capRaw = kv.MARCO_EVENT_CAP;
  const cap = /^[0-9]+$/.test(capRaw || '') && parseInt(capRaw, 10) > 0 ? parseInt(capRaw, 10) : 200;
  return { mode, janitor, eventCap: cap };
}
```

- [ ] **Step 4: Run tests** — `node --test test/marco.test.js` → all PASS. Run `npx eslint src/lib/marco.js test/marco.test.js` → clean.
- [ ] **Step 5: Commit**

```bash
cd /opt/jarvis
git add src/lib/marco.js test/marco.test.js
git commit -m "feat(marco): pure event/env logic for the fleet knowledge flywheel"
```

---

### Task 2: Mode file + store + ingest — `config/marco.env`, `marco_events`, `POST /marco/event`

**Files:**
- Create: `config/marco.env`
- Modify: `src/memory-server.js` (schema block after the `reminders` table ~line 295; routes after the lessons routes ~line 1180)
- Test: manual curl verification (route handlers live in the monolith; logic already unit-tested in Task 1)

**Interfaces:**
- Consumes: `normalizeEvent`, `capVerdict`, `parseMarcoEnv` from `./lib/marco.js` (Task 1).
- Produces: `POST /marco/event` (JSON body = raw event, optional `Authorization: Bearer <MARCO_INGEST_TOKEN>`); `GET /marco/events?agent=&platform=&limit=&since=`; internal helper `marcoMode()` and `insertMarcoEvent(raw, res|null)` reused by Tasks 3, 6.

- [ ] **Step 1: Create `config/marco.env`**

```bash
cat > /opt/jarvis/config/marco.env <<'EOF'
# Marco fleet-knowledge flywheel. Read fresh (5s cache) on every /marco/* request —
# flip and it takes effect without a restart, same hot-reload contract as platforms.json.
#   off     = kill switch: /marco/* returns 503, curator/janitor no-op
#   observe = ingest + briefing + ask live; curator dry-run; janitor report-only
#   full    = everything live
MARCO_MODE=observe
# janitor: report = never delete, only file reports; clean = whitelist deletions allowed
JANITOR_MODE=report
# per-agent per-day event cap (flood control; one warning at the cap, silent drops after)
MARCO_EVENT_CAP=200
EOF
```

- [ ] **Step 2: Add schema to `src/memory-server.js`.** In the imports, extend the existing `./lib/marco.js` import line (new): `import { normalizeEvent, capVerdict, parseMarcoEnv } from './lib/marco.js';`. Directly after the `reminders` index inside the big `db.exec` block (before the closing backtick), add:

```sql
  -- Marco in the Loop (2026-08-31): the fleet's shared event stream. Lessons
  -- REUSE the existing lessons table above (additive columns below). Spec:
  -- docs/superpowers/specs/2026-08-31-marco-in-the-loop-design.md
  CREATE TABLE IF NOT EXISTS marco_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    agent TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT 'vultr',
    platform TEXT NOT NULL,
    action TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT,
    tags TEXT,
    session_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_marco_events_ts ON marco_events(ts);
  CREATE INDEX IF NOT EXISTS idx_marco_events_agent ON marco_events(agent, ts);
  CREATE INDEX IF NOT EXISTS idx_marco_events_platform ON marco_events(platform, ts);
```

After the existing `ALTER TABLE` migration block (~line 325), add the lesson-table extensions and the FTS index:

```js
try { db.exec('ALTER TABLE lessons ADD COLUMN source_event_ids TEXT'); } catch { /* already present */ }
try { db.exec("ALTER TABLE lessons ADD COLUMN author TEXT DEFAULT 'harvester'"); } catch { /* already present */ }
// FTS over lessons + events for /marco/ask. External-content-free (contentless
// would forbid the delete triggers); rebuilt cheap, sized small by the caps.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS marco_fts USING fts5(kind, ref_id, text);
`);
```

- [ ] **Step 3: Add mode helper + ingest route** (place after the lessons routes, ~line 1180):

```js
// ── Marco in the Loop: fleet event ingest ──────────────────────────────────
const MARCO_ENV_PATH = '/opt/jarvis/config/marco.env';
let marcoEnvCache = { at: 0, val: parseMarcoEnv('') };
function marcoEnv() {
  if (Date.now() - marcoEnvCache.at > 5000) {
    let text = '';
    try { text = readFileSync(MARCO_ENV_PATH, 'utf8'); } catch { /* missing file = mode off */ }
    marcoEnvCache = { at: Date.now(), val: parseMarcoEnv(text) };
  }
  return marcoEnvCache.val;
}

function marcoTokenOk(req) {
  let expected = process.env.MARCO_INGEST_TOKEN || '';
  if (!expected) {
    try {
      const m = readFileSync('/opt/jarvis/config/secrets.env', 'utf8').match(/^MARCO_INGEST_TOKEN=(.+)$/m);
      if (m) expected = m[1].trim();
    } catch { /* no secrets file */ }
  }
  if (!expected) return true;   // fails OPEN pre-rollout, same contract as internal-http.js
  const got = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return got === expected;
}

function insertMarcoEvent(raw) {
  const norm = normalizeEvent(raw);
  if (!norm.ok) return { status: 400, body: { error: norm.error } };
  const env = marcoEnv();
  const today = new Date().toISOString().slice(0, 10);
  const n = db.prepare("SELECT COUNT(*) c FROM marco_events WHERE agent = ? AND ts >= ?")
    .get(norm.event.agent, today).c;
  const cap = capVerdict(n, env.eventCap);
  if (!cap.allowed) {
    if (cap.warn) {
      db.prepare('INSERT INTO notifications (ts, level, title, body) VALUES (?,?,?,?)')
        .run(new Date().toISOString(), 'warn', 'Marco flood cap hit',
          `agent ${norm.event.agent} hit ${env.eventCap} events today; dropping further events until UTC midnight`);
    }
    return { status: 429, body: { dropped: true } };
  }
  const e = norm.event;
  const info = db.prepare(`INSERT INTO marco_events (ts, agent, host, platform, action, outcome, detail, tags, session_id)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(new Date().toISOString(), e.agent, e.host, e.platform, e.action, e.outcome, e.detail, e.tags, e.session_id);
  db.prepare("INSERT INTO marco_fts (kind, ref_id, text) VALUES ('event', ?, ?)")
    .run(String(info.lastInsertRowid), `${e.agent} ${e.platform} ${e.action} ${e.outcome} ${e.detail} ${e.tags}`);
  return { status: 200, body: { id: info.lastInsertRowid } };
}

app.post('/marco/event', (req, res) => {
  if (marcoEnv().mode === 'off') return res.status(503).json({ error: 'MARCO_MODE=off' });
  if (!marcoTokenOk(req)) return res.status(401).json({ error: 'bad ingest token' });
  const r = insertMarcoEvent(req.body);
  res.status(r.status).json(r.body);
});

app.get('/marco/events', (req, res) => {
  if (marcoEnv().mode === 'off') return res.status(503).json({ error: 'MARCO_MODE=off' });
  const limit = clampLimit(req.query.limit, 50, 500);
  const where = ['1=1']; const params = [];
  if (req.query.agent) { where.push('agent = ?'); params.push(req.query.agent); }
  if (req.query.platform) { where.push('platform = ?'); params.push(req.query.platform); }
  if (req.query.since) { where.push('ts >= ?'); params.push(req.query.since); }
  res.json(db.prepare(`SELECT * FROM marco_events WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit));
});
```

*(The existing `notifications` table columns are `ts, level, title, body` — verify with `.schema notifications` via `sqlite3 /opt/jarvis/memory/jarvis.db` before wiring the warn insert; adjust column names to match if they differ.)*

- [ ] **Step 4: Restart + verify live**

```bash
npx eslint src/memory-server.js
systemctl restart jarvis-memory && sleep 1
curl -s http://127.0.0.1:9200/memory/health
# ingest one event
curl -s -X POST http://127.0.0.1:9200/marco/event -H 'Content-Type: application/json' \
  -d '{"agent":"plan-test","platform":"box","action":"marco ingest smoke test","outcome":"ok","tags":["smoke"]}'
# expect {"id":1}; read it back
curl -s 'http://127.0.0.1:9200/marco/events?agent=plan-test'
# bad outcome -> 400; MARCO_MODE=off in config/marco.env -> 503 (flip back to observe after checking)
```

- [ ] **Step 5: Commit**

```bash
git add config/marco.env
git add -p src/memory-server.js   # stage ONLY the marco hunks
git commit -m "feat(marco): event store, mode gate, flood-capped ingest on :9200"
```

---

### Task 3: The loop back — `GET /marco/briefing` and `GET /marco/ask`

**Files:**
- Modify: `src/memory-server.js` (directly under the Task 2 routes)

**Interfaces:**
- Consumes: `marcoEnv()`, `marco_fts`, existing `lessons` table.
- Produces: `GET /marco/briefing?platform=X&tags=a,b&limit=N` → `{lessons: [...], recent_failures: [...]}`; `GET /marco/ask?q=...&limit=N` → `{lessons: [...], events: [...]}`.

- [ ] **Step 1: Add the two routes**

```js
// Briefing: what an agent should know before starting work on <platform>.
// Active lessons for the platform (and 'all'), most-seen first — the exact
// ordering session-start.sh already trusts — plus the platform's recent failures
// so an agent never repeats yesterday's dead end.
app.get('/marco/briefing', (req, res) => {
  if (marcoEnv().mode === 'off') return res.status(503).json({ error: 'MARCO_MODE=off' });
  const platform = String(req.query.platform || 'all').toLowerCase();
  const limit = clampLimit(req.query.limit, 15, 50);
  const lessons = db.prepare(`
    SELECT id, platform, kind, lesson, evidence, seen_count, last_seen FROM lessons
    WHERE status = 'active' AND (platform = ? OR platform = 'all')
    ORDER BY seen_count DESC, last_seen DESC LIMIT ?`).all(platform, limit);
  const recent_failures = db.prepare(`
    SELECT ts, agent, action, outcome, detail FROM marco_events
    WHERE platform = ? AND outcome IN ('failed','blocked') AND ts >= ?
    ORDER BY ts DESC LIMIT 5`)
    .all(platform, new Date(Date.now() - 7 * 864e5).toISOString());
  res.json({ platform, lessons, recent_failures });
});

// Ask-Marco: keyword search over lessons + events (FTS5). Quotes stripped so a
// caller's natural phrasing can't inject FTS syntax errors.
app.get('/marco/ask', (req, res) => {
  if (marcoEnv().mode === 'off') return res.status(503).json({ error: 'MARCO_MODE=off' });
  const q = String(req.query.q || '').replace(/["'^*()]/g, ' ').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  const limit = clampLimit(req.query.limit, 10, 50);
  let hits = [];
  try {
    hits = db.prepare("SELECT kind, ref_id FROM marco_fts WHERE marco_fts MATCH ? LIMIT ?")
      .all(q.split(/\s+/).map((w) => `"${w}"`).join(' OR '), limit * 2);
  } catch { /* malformed query after sanitizing — return empty rather than 500 */ }
  const lessonIds = hits.filter((h) => h.kind === 'lesson').map((h) => h.ref_id).slice(0, limit);
  const eventIds = hits.filter((h) => h.kind === 'event').map((h) => h.ref_id).slice(0, limit);
  const inList = (ids) => ids.map(() => '?').join(',') || 'NULL';
  res.json({
    lessons: db.prepare(`SELECT id, platform, kind, lesson, evidence, status FROM lessons WHERE id IN (${inList(lessonIds)})`).all(...lessonIds),
    events: db.prepare(`SELECT id, ts, agent, platform, action, outcome, detail FROM marco_events WHERE id IN (${inList(eventIds)})`).all(...eventIds),
  });
});
```

- [ ] **Step 2: Backfill lessons into FTS once** (idempotent — run after restart):

```js
// place immediately after the marco_fts CREATE in the schema section:
const ftsCount = db.prepare("SELECT COUNT(*) c FROM marco_fts WHERE kind = 'lesson'").get().c;
if (ftsCount === 0) {
  for (const l of db.prepare('SELECT id, platform, kind, lesson, evidence FROM lessons').all()) {
    db.prepare("INSERT INTO marco_fts (kind, ref_id, text) VALUES ('lesson', ?, ?)")
      .run(String(l.id), `${l.platform} ${l.kind} ${l.lesson} ${l.evidence || ''}`);
  }
}
```

Also find the lesson-INSERT inside the existing `POST /memory/harvest/distilled` handler (~line 1147) and add, right after it, the FTS mirror for NEW lessons:

```js
db.prepare("INSERT INTO marco_fts (kind, ref_id, text) VALUES ('lesson', ?, ?)")
  .run(String(db.prepare('SELECT last_insert_rowid() id').get().id), `${platform} ${norm.kind} ${norm.lesson} ${norm.evidence || ''}`);
```

*(Adapt local variable names to what that handler actually uses — read the surrounding ten lines first.)*

- [ ] **Step 3: Restart + verify**

```bash
npx eslint src/memory-server.js && systemctl restart jarvis-memory && sleep 1
curl -s 'http://127.0.0.1:9200/marco/briefing?platform=vapron' | jq '.lessons | length'   # > 0 (existing lessons)
curl -s 'http://127.0.0.1:9200/marco/ask?q=traefik' | jq                                  # finds the docker-network lesson
curl -s 'http://127.0.0.1:9200/marco/ask?q=smoke' | jq '.events | length'                 # finds Task 2's test event
```

- [ ] **Step 4: Commit** — `git add -p src/memory-server.js && git commit -m "feat(marco): briefing + ask endpoints over lessons and events"`

---

### Task 4: Writers — `marco-report.sh`, session scripts

**Files:**
- Create: `scripts/marco-report.sh`
- Modify: `scripts/session-end.sh` (after the existing `/memory/session/end` curl at line 43), `scripts/session-start.sh` (the lessons block at lines 72–85)

**Interfaces:**
- Produces: `scripts/marco-report.sh <agent> <platform> <ok|fixed|failed|blocked|noop> "<action>" ["<detail>"] ["tag1,tag2"]` — exit 0 even when memory is down (reporting must never break a caller).

- [ ] **Step 1: Create `scripts/marco-report.sh`** (mirror of `agent-report.sh`):

```bash
#!/usr/bin/env bash
# marco-report.sh — any agent mirrors one event into the Marco flywheel.
# Usage: marco-report.sh <agent> <platform> <ok|fixed|failed|blocked|noop> "<action>" ["<detail>"] ["tag1,tag2"]
# Never fails the caller: Marco being down must not break the work being reported.
set -uo pipefail
if [ $# -lt 4 ]; then
  echo "usage: marco-report.sh <agent> <platform> <outcome> \"action\" [\"detail\"] [\"tags\"]" >&2
  exit 64
fi
TOKEN=$(grep -m1 '^MARCO_INGEST_TOKEN=' /opt/jarvis/config/secrets.env 2>/dev/null | cut -d= -f2- || true)
jq -n --arg agent "$1" --arg platform "$2" --arg outcome "$3" --arg action "$4" \
      --arg detail "${5:-}" --arg tags "${6:-}" \
      '{agent:$agent, platform:$platform, outcome:$outcome, action:$action, detail:$detail, tags:$tags}' \
| curl -s -m 5 -X POST http://127.0.0.1:9200/marco/event \
    -H 'Content-Type: application/json' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
    --data-binary @- || true
echo
```

`chmod +x scripts/marco-report.sh`

- [ ] **Step 2: Wire `session-end.sh`.** After the existing session/end curl (line 43), add:

```bash
bash /opt/jarvis/scripts/marco-report.sh "claude-session" "$PLATFORM" "ok" \
  "session $SESSION_ID ended" "$SUMMARY" "session"
```

*(Use the variable names the script actually has — `$PLATFORM`/`$SESSION_ID`/summary arg; read the script's argument parsing at the top first.)*

- [ ] **Step 3: Wire `session-start.sh`.** Replace the `/memory/lessons` curl in the lessons block (line 73) with `/marco/briefing`, keeping the output format identical, and add the failures section:

```bash
curl -sf "${MEMORY_URL}/marco/briefing?platform=$PLATFORM&limit=8" 2>/dev/null | \
  jq -r '(.lessons[] | "• [\(.kind)] \(.lesson)"),
         (if (.recent_failures|length) > 0 then "━━ RECENT FAILURES (don'\''t repeat) ━━" else empty end),
         (.recent_failures[] | "✗ \(.agent): \(.action) → \(.outcome)")' \
  || echo "Marco not responding for briefing."
```

- [ ] **Step 4: Verify** — `bash scripts/marco-report.sh plan-test box ok "writer smoke" "" test` returns `{"id":N}`; run `bash scripts/session-start.sh jarvis 2>&1 | grep -A12 LESSONS` and confirm lessons still render.
- [ ] **Step 5: Commit** — `git add scripts/marco-report.sh scripts/session-end.sh scripts/session-start.sh && git commit -m "feat(marco): shell writer + session protocol wiring"`

---

### Task 5: Central bridges — reports, repairs, and job outcomes become events

**Files:**
- Modify: `src/memory-server.js` — three existing handlers: `POST /memory/agent-report` (line 873), `POST /memory/repair/log` (line 684), `POST /memory/jobs/:id/transition` (line 851)

**Interfaces:**
- Consumes: `insertMarcoEvent(raw)` from Task 2.
- Produces: every agent report, self-heal repair, and orchestrated job outcome (`done`/`failed`) lands in `marco_events` with **zero changes to any agent** — the whole agent org, self-heal, and all Claude/Codex/cloud jobs are covered at the choke points.

- [ ] **Step 1:** In each of the three handlers, after the existing successful insert/update, add (adapting field names to the handler's local variables — read each handler before editing):

```js
// agent-report handler:
insertMarcoEvent({ agent, platform: 'fleet', action: `report: ${summary}`.slice(0, 200),
  outcome: status === 'ok' ? 'ok' : 'blocked', detail: details || '', tags: `agent-org,${status}` });

// repair/log handler:
insertMarcoEvent({ agent: 'self-heal', platform, action: `repair: ${issue}`.slice(0, 200),
  outcome: fix_applied ? 'fixed' : 'failed', detail: fix_applied || '', tags: 'self-heal,repair' });

// jobs/:id/transition handler — only for terminal transitions:
if (to === 'done' || to === 'failed') {
  const job = db.prepare('SELECT platform, task, agent FROM jobs WHERE id = ?').get(req.params.id);
  if (job) insertMarcoEvent({ agent: job.agent || 'orchestrator', platform: job.platform || 'fleet',
    action: `job ${req.params.id}: ${String(job.task || '').slice(0, 150)}`,
    outcome: to === 'done' ? 'ok' : 'failed', tags: 'job' });
}
```

*(Verify the `jobs` table column names — `.schema jobs` — and the transition handler's variable for the target state before wiring.)*

- [ ] **Step 2: Verify live** — restart, then file a test report and confirm the mirror:

```bash
bash scripts/agent-report.sh plan-test 0 ok "bridge smoke test" && \
curl -s 'http://127.0.0.1:9200/marco/events?agent=plan-test&limit=3' | jq '.[0].action'
```

- [ ] **Step 3: Commit** — `git add -p src/memory-server.js && git commit -m "feat(marco): bridge agent reports, repairs, and job outcomes into events"`

---

### Task 6: Curator — persona + scheduled role (starts held)

**Files:**
- Create: `config/personas/curator.md`
- Modify: `config/agents.json` (one new entry in `agents`)

**Interfaces:**
- Consumes: `/marco/events`, `/memory/lessons`, `POST /memory/harvest/distilled` (existing lesson filer, dedups by fingerprint), `PATCH /memory/lessons/:id`, `scripts/agent-report.sh`.
- Produces: daily distillation run; reports under `reports/agents/curator/`.

- [ ] **Step 1: Write `config/personas/curator.md`**

```markdown
# Curator — Marco's librarian

You are the curator of the Marco knowledge flywheel. You run once daily. Your ONLY
write powers are: filing lessons via the memory API and filing your report. You never
touch code, config, services, or files outside reports/agents/curator/.

## Daily job
1. Read yesterday's events: `curl -s 'http://127.0.0.1:9200/marco/events?since=<yesterday UTC date>&limit=500'`
2. Read active lessons: `curl -s 'http://127.0.0.1:9200/memory/lessons?limit=100&all=1'`
3. Distill: propose NEW lessons only where events show a repeatable rule (a fix that
   worked, a gotcha that cost time, an environment fact). Max 5/day. File each via
   `POST http://127.0.0.1:9200/memory/harvest/distilled` with body
   `{"session_id": null, "status": "ok", "lessons": [{"kind":"gotcha|workflow|environment|fix","lesson":"...","evidence":"...","platform":"<platform|all>"}]}`
   (fingerprint dedup means re-filing a known lesson just bumps seen_count — safe).
4. Prune: a lesson contradicted by newer events → `PATCH /memory/lessons/<id>` body
   `{"status":"stale"}` AND list it in your report under "Contradicted — Craig review".
   Never silently rewrite history.
5. On Sundays (UTC) also write a weekly digest — new lessons, retired lessons, notable
   failures, event counts by agent — to reports/agents/curator/<date>-digest.md and file
   your report with status action_needed so it surfaces to Craig.

## Mode gate — check FIRST
Read /opt/jarvis/config/marco.env. If MARCO_MODE=off: file an ok report "marco off,
no-op" and stop. If MARCO_MODE=observe: DRY-RUN — write everything you WOULD file
(steps 3-4) into reports/agents/curator/<date>-dryrun.md instead of calling the API,
and file your report. Only MARCO_MODE=full does the real thing.

## Always
Finish with: `bash /opt/jarvis/scripts/agent-report.sh curator <job_id> <status> "<summary>"`
```

- [ ] **Step 2: Add the role to `config/agents.json`** (schedule 04:00 UTC — after the 03:30 memory backup; hot-reloaded, no restart):

```json
"curator": {
  "display_name": "Curator — Marco's librarian",
  "persona": "config/personas/curator.md",
  "schedule": "0 4 * * *",
  "budget": { "max_jobs_per_day": 1, "timeout_min": 15 },
  "status": "active"
}
```

Validate: `jq . config/agents.json > /dev/null`.

- [ ] **Step 3: First run** — either wait for 04:00 UTC or trigger one job through the scheduler's dispatch path the way other roles run (check `src/agent-scheduler.js` for its manual-dispatch/test route; if none exists, wait for the scheduled run). Confirm a dry-run file appears in `reports/agents/curator/` and the report was filed (`curl -s 'http://127.0.0.1:9200/memory/agent-reports?limit=5'`).
- [ ] **Step 4: Commit** — `git add config/personas/curator.md config/agents.json && git commit -m "feat(marco): curator role — daily lesson distillation (dry-run under observe)"`

---

### Task 7: Janitor — deterministic daily maintenance script + timer

**Files:**
- Create: `scripts/janitor.sh`, `systemd/jarvis-janitor.service`, `systemd/jarvis-janitor.timer`, `config/ports-baseline.json`

**Interfaces:**
- Consumes: `scripts/marco-report.sh` (Task 4), `scripts/agent-report.sh`, `JANITOR_MODE` from `config/marco.env`.
- Produces: one `box-health` Marco event daily; `action_needed` agent report on any anomaly.

- [ ] **Step 1: Capture the ports baseline**

```bash
ss -tlnp | awk 'NR>1 {print $4}' | sed 's/.*://' | sort -un | jq -R . | jq -s '{ports: map(tonumber)}' \
  > /opt/jarvis/config/ports-baseline.json
cat /opt/jarvis/config/ports-baseline.json   # eyeball it: expect 22, 9200-9211 range, coolify ports…
```

- [ ] **Step 2: Write `scripts/janitor.sh`**

```bash
#!/usr/bin/env bash
# janitor.sh — daily whitelist-only box maintenance (Marco spec §6, 2026-08-31).
# JANITOR_MODE=report (default): observe + report, delete nothing.
# JANITOR_MODE=clean: the whitelisted deletions below are allowed. Nothing else ever.
set -uo pipefail
MODE=$(grep -m1 '^JANITOR_MODE=' /opt/jarvis/config/marco.env 2>/dev/null | cut -d= -f2)
MODE=${MODE:-report}
ISSUES=(); ACTIONS=()

# 1. Disk
DISK_PCT=$(df --output=pcent / | tail -1 | tr -dc '0-9')
if [ "$DISK_PCT" -ge 75 ]; then
  ISSUES+=("disk ${DISK_PCT}% (threshold 75%); top growth: $(du -xhs /opt/* 2>/dev/null | sort -rh | head -3 | tr '\n' ' ')")
fi

# 2. Old .bak clutter + old logs (whitelist: only these patterns, only these dirs)
BAKS=$(find /opt/jarvis/src /opt/jarvis/scripts /opt/jarvis/config -maxdepth 2 -name '*.bak.*' -o -name '*.bak-*' 2>/dev/null | head -50)
OLDLOGS=$(find /opt/jarvis/logs -type f -mtime +14 2>/dev/null | head -50)
if [ -n "$BAKS$OLDLOGS" ]; then
  if [ "$MODE" = "clean" ]; then
    echo "$OLDLOGS" | xargs -r rm -f && ACTIONS+=("deleted $(echo "$OLDLOGS" | grep -c .) logs >14d")
    ISSUES+=("bak files present (never auto-deleted, listed for review): $(echo "$BAKS" | tr '\n' ' ')")
  else
    ISSUES+=("cleanup candidates (report mode): $(echo "$BAKS $OLDLOGS" | wc -w) files")
  fi
fi

# 3. Failed units + zombies + orphaned chrome
FAILED=$(systemctl --failed --no-legend | awk '{print $1}' | tr '\n' ' ')
[ -n "${FAILED// /}" ] && ISSUES+=("failed units: $FAILED")
ZOMBIES=$(ps -eo stat,pid,comm | awk '$1 ~ /Z/ {print $2}' | wc -l)
[ "$ZOMBIES" -gt 0 ] && ISSUES+=("$ZOMBIES zombie processes")
ORPHANS=$(pgrep -f 'chrom.*--headless' --older 7200 2>/dev/null | wc -l || echo 0)
if [ "$ORPHANS" -gt 0 ]; then
  if [ "$MODE" = "clean" ]; then pkill -f 'chrom.*--headless' --older 7200 && ACTIONS+=("killed $ORPHANS headless-chrome orphans >2h"); else ISSUES+=("$ORPHANS headless-chrome orphans >2h (report mode)"); fi
fi

# 4. Memory DB care: weekly VACUUM (Sunday), daily backup freshness
if [ "$(date -u +%u)" = "7" ] && [ "$MODE" = "clean" ]; then
  sqlite3 /opt/jarvis/memory/jarvis.db 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM; ANALYZE;' && ACTIONS+=("weekly VACUUM+ANALYZE")
fi
NEWEST_BACKUP=$(ls -t /opt/jarvis/backups/*.db* 2>/dev/null | head -1)
if [ -z "$NEWEST_BACKUP" ] || [ -n "$(find "$NEWEST_BACKUP" -mtime +2 2>/dev/null)" ]; then
  ISSUES+=("memory backup missing or older than 48h: ${NEWEST_BACKUP:-none}")
fi

# 5. Security quick-check
SSH_FAILS=$(journalctl -u ssh --since yesterday 2>/dev/null | grep -c 'Failed password' || echo 0)
[ "$SSH_FAILS" -gt 200 ] && ISSUES+=("$SSH_FAILS failed SSH attempts in 24h")
DRIFT=$(comm -13 <(jq -r '.ports[]' /opt/jarvis/config/ports-baseline.json | sort -n) \
  <(ss -tln | awk 'NR>1 {print $4}' | sed 's/.*://' | sort -un))
[ -n "$DRIFT" ] && ISSUES+=("NEW listening ports vs baseline: $(echo "$DRIFT" | tr '\n' ' ')")

# Report
SUMMARY="disk ${DISK_PCT}%, ${#ISSUES[@]} issues, ${#ACTIONS[@]} actions [$MODE]"
DETAIL=$(printf '%s; ' "${ISSUES[@]:-none}" "${ACTIONS[@]:-}")
bash /opt/jarvis/scripts/marco-report.sh janitor box "$([ ${#ISSUES[@]} -eq 0 ] && echo ok || echo blocked)" \
  "daily box-health sweep" "$DETAIL" "janitor,box-health"
if [ ${#ISSUES[@]} -gt 0 ]; then
  bash /opt/jarvis/scripts/agent-report.sh janitor 0 action_needed "$SUMMARY" "$DETAIL"
fi
echo "$SUMMARY"
```

`chmod +x scripts/janitor.sh`. **Sanity-run it now** (`bash scripts/janitor.sh`) — report mode touches nothing; fix any command that errors on this box's tool versions (e.g. `pgrep --older` needs procps ≥ 4; if absent, replace with an `etimes`-based `ps` filter: `ps -eo etimes,pid,args | awk '/chrom.*--headless/ && $1>7200 {print $2}'`).

- [ ] **Step 3: systemd units**

```ini
# systemd/jarvis-janitor.service
[Unit]
Description=Jarvis daily box janitor (Marco spec §6) — whitelist maintenance
[Service]
Type=oneshot
ExecStart=/usr/bin/bash /opt/jarvis/scripts/janitor.sh
Nice=10
```

```ini
# systemd/jarvis-janitor.timer
[Unit]
Description=Daily Jarvis janitor at 03:00 UTC
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
```

Install the way the other units are installed (check how `systemd/jarvis-backup.timer` is linked: `systemctl cat jarvis-backup.timer | head -1` shows the live path; copy or symlink the same way), then `systemctl daemon-reload && systemctl enable --now jarvis-janitor.timer && systemctl start jarvis-janitor.service`. Verify: `journalctl -u jarvis-janitor -n 20` and `curl -s 'http://127.0.0.1:9200/marco/events?agent=janitor'`.

- [ ] **Step 4: Commit** — `git add scripts/janitor.sh systemd/jarvis-janitor.service systemd/jarvis-janitor.timer config/ports-baseline.json && git commit -m "feat(marco): daily janitor — whitelist box maintenance, report-only by default"`

---

### Task 8: Elastic capacity — `computeSlots()` + orchestrator wiring

**Files:**
- Create: `src/lib/capacity.js`
- Modify: `src/orchestrator.js` (const at line 97, slot math at line 540, status at line 1410, log line at 1606)
- Modify: `src/lib/spawn-agent.js` (spawn at line 56)
- Test: `test/capacity.test.js`

**Interfaces:**
- Produces: `computeSlots({queued, running, load1, cores, freeMemGB, fixed}) -> number` (workers to allow NOW, ≥0); `ceilingFor({load1, cores, freeMemGB}) -> 1..6`.

- [ ] **Step 1: Failing tests**

```js
// test/capacity.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, ceilingFor } from '../src/lib/capacity.js';

const idle = { load1: 0.5, cores: 4, freeMemGB: 4.0 };
const busy = { load1: 3.2, cores: 4, freeMemGB: 1.2 };

test('ceiling: base 4, extends to 6 only when clearly idle, floors at 1 under pressure', () => {
  assert.equal(ceilingFor({ load1: 2.0, cores: 4, freeMemGB: 2.0 }), 4);   // normal
  assert.equal(ceilingFor(idle), 6);                                        // load/core<0.4 && >3GB
  assert.equal(ceilingFor(busy), 1);                                        // load/core>0.7 || <1.5GB
});

test('slots scale with backlog under the ceiling', () => {
  assert.equal(computeSlots({ queued: 0, running: 0, ...idle }), 0);        // nothing to do
  assert.equal(computeSlots({ queued: 2, running: 0, ...idle }), 1);        // ceil(2/2)=1
  assert.equal(computeSlots({ queued: 20, running: 0, ...idle }), 6);       // capped at ceiling
  assert.equal(computeSlots({ queued: 20, running: 6, ...idle }), 0);       // ceiling full
});

test('pressure only stops NEW slots — running jobs are never negative-counted', () => {
  assert.equal(computeSlots({ queued: 20, running: 3, ...busy }), 0);       // ceiling 1 < running 3 → 0, not -2
});

test('fixed env override bypasses adaptation entirely', () => {
  assert.equal(computeSlots({ queued: 20, running: 1, ...busy, fixed: 3 }), 2);
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3: Implement**

```js
// capacity.js — adaptive job concurrency (Marco spec §7, 2026-08-31). Pure: the
// orchestrator feeds it os.loadavg()/os.freemem(); nothing here touches the OS.
// Production is protected by the CEILING (never add pressure), never by
// preemption: a shrinking ceiling stops NEW spawns, running jobs always finish.

export function ceilingFor({ load1, cores, freeMemGB }) {
  const perCore = load1 / cores;
  if (perCore > 0.7 || freeMemGB < 1.5) return 1;
  if (perCore < 0.4 && freeMemGB > 3.0) return 6;
  return 4;
}

export function computeSlots({ queued, running, load1, cores, freeMemGB, fixed = null }) {
  const ceiling = fixed !== null ? fixed : ceilingFor({ load1, cores, freeMemGB });
  const wanted = Math.min(Math.ceil(queued / 2), ceiling);
  return Math.max(0, Math.min(wanted, ceiling - running));
}
```

- [ ] **Step 4:** Tests pass. **Step 5: Wire the orchestrator.** At line 97, keep the guardrail as the fixed override, off by default:

```js
// Adaptive capacity (Marco spec §7): MAX_CONCURRENT_JOBS set explicitly in the
// env pins a fixed cap (rollback path); unset, computeSlots adapts per tick.
const FIXED_CONCURRENCY = process.env.MAX_CONCURRENT_JOBS
  ? guardrail('MAX_CONCURRENT_JOBS', 3, { source: 'orchestrator' }) : null;
```

At the tick (line ~540) replace `const slots = MAX_CONCURRENT_JOBS - running.length;` with:

```js
const slots = computeSlots({
  queued: queued.length, running: running.length,
  load1: os.loadavg()[0], cores: os.cpus().length,
  freeMemGB: os.freemem() / 1073741824, fixed: FIXED_CONCURRENCY,
});
```

(add `import os from 'os';` and `import { computeSlots } from './lib/capacity.js';` at the top). Update the two reporting sites: line 1410 `maxConcurrent: FIXED_CONCURRENCY ?? 'adaptive'`, line 1606 log message likewise. **Every scale decision visible:** where the tick starts jobs, when `slots > 0`, add `logEvent('JOB', \`capacity: ${running.length} running, ${queued.length} queued → ${slots} new slot(s)\`);` (the existing `logEvent` at line 181). Fix any other `MAX_CONCURRENT_JOBS` references the grep finds: `grep -n MAX_CONCURRENT_JOBS src/orchestrator.js`.

- [ ] **Step 6: Lower worker priority.** In `src/lib/spawn-agent.js` line 56, prefix local spawns:

```js
const proc = spawn('nice', ['-n', '10', 'ionice', '-c', '3', cmd, ...args], {
```

(verify `ionice` exists: `command -v ionice`; if absent, drop to `nice` only. The remote/ssh path is untouched — remote boxes manage their own load.)

- [ ] **Step 7:** `npx eslint src/lib/capacity.js src/orchestrator.js src/lib/spawn-agent.js`, `node --test test/capacity.test.js`, `systemctl restart jarvis-orchestrator`, then `curl -s http://127.0.0.1:9205/status | jq .maxConcurrent` (adjust path — line 1410's route — expect `"adaptive"`).
- [ ] **Step 8: Commit** — `git add src/lib/capacity.js test/capacity.test.js && git add -p src/orchestrator.js src/lib/spawn-agent.js && git commit -m "feat(marco): adaptive job capacity — backlog-scaled, headroom-capped, nice'd workers"`

---

### Task 9: Vapron cross-box ingest

**Files:**
- Modify (jarvis box): `config/secrets.env` (add `MARCO_INGEST_TOKEN`), tailscale serve config
- Modify (vapron box, over ssh to `mail.vapron.ai`): the watchdog script under `/opt/vapron` (locate: `grep -rl "watchdog" /opt/vapron --include='*.sh' | head`), its env file

**Interfaces:**
- Consumes: `POST /marco/event` with `Authorization: Bearer <MARCO_INGEST_TOKEN>` (Task 2 already enforces it once the token exists).
- Produces: vapron watchdog events in `marco_events` with `host: 'vapron'`; offline spool at `/opt/vapron/marco-spool.jsonl`.

- [ ] **Step 1: Mint + install the token (jarvis box)**

```bash
TOKEN=$(openssl rand -hex 24)
grep -q '^MARCO_INGEST_TOKEN=' /opt/jarvis/config/secrets.env || echo "MARCO_INGEST_TOKEN=$TOKEN" >> /opt/jarvis/config/secrets.env
systemctl restart jarvis-memory
# from now on /marco/event REQUIRES the bearer token (fails closed once set) —
# confirm marco-report.sh still works (it reads secrets.env): 
bash /opt/jarvis/scripts/marco-report.sh plan-test box ok "token smoke" && echo OK
# and a tokenless remote-style post is refused:
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:9200/marco/event \
  -H 'Content-Type: application/json' -d '{"agent":"x","platform":"x","action":"x","outcome":"ok"}'   # expect 401
```

- [ ] **Step 2: Expose over the tailnet** — `tailscale serve --bg --https=9245 http://127.0.0.1:9200` (check current serves first with `tailscale serve status` so nothing is clobbered; if 9245 is taken pick a free port and use it consistently). Verify from vapron in Step 3.
- [ ] **Step 3: Vapron watchdog push + spool.** On `mail.vapron.ai`, add to the watchdog a `marco_push` function and call it wherever the watchdog currently alerts/acts:

```bash
MARCO_URL="https://jarvis.tailbd6217.ts.net:9245/marco/event"
MARCO_SPOOL="/opt/vapron/marco-spool.jsonl"
marco_push() {   # $1 action  $2 outcome  $3 detail
  local body; body=$(jq -n --arg a "$1" --arg o "$2" --arg d "$3" \
    '{agent:"vapron-watchdog", host:"vapron", platform:"vapron", action:$a, outcome:$o, detail:$d, tags:"watchdog"}')
  if ! echo "$body" | curl -sf -m 8 -X POST "$MARCO_URL" \
      -H "Authorization: Bearer $MARCO_INGEST_TOKEN" -H 'Content-Type: application/json' \
      --data-binary @- > /dev/null; then
    echo "$body" >> "$MARCO_SPOOL"   # spool on failure, drain next tick
  fi
  # drain spool (one attempt per line; keep what still fails)
  if [ -s "$MARCO_SPOOL" ]; then
    local keep; keep=$(mktemp)
    while IFS= read -r line; do
      echo "$line" | curl -sf -m 8 -X POST "$MARCO_URL" \
        -H "Authorization: Bearer $MARCO_INGEST_TOKEN" -H 'Content-Type: application/json' \
        --data-binary @- > /dev/null || echo "$line" >> "$keep"
    done < "$MARCO_SPOOL"
    mv "$keep" "$MARCO_SPOOL"
  fi
}
```

Put `MARCO_INGEST_TOKEN=<the token>` in the watchdog's env file (find how it loads env; vapron has the legacy-unit trap — confirm which unit is LIVE with `systemctl status | grep -i vapron` before editing, per the watchdog memory). Test: `marco_push "cross-box smoke" ok "hello from vapron"` then on jarvis: `curl -s 'http://127.0.0.1:9200/marco/events?agent=vapron-watchdog' | jq '.[0]'`. Test the spool: temporarily set a wrong URL, push, confirm the line lands in the spool, restore, push again, confirm drain.
- [ ] **Step 4: Commit (jarvis side only** — vapron box is not this repo; record its change in the task report): `git add -p config/secrets.env.example && git commit -m "docs(marco): MARCO_INGEST_TOKEN in secrets template"` (add the key name to `config/secrets.env.example` with a placeholder — never the real token).

---

### Task 10: Gateway + Codex writers

**Files:**
- Modify: `src/memory-server.js` (`POST /memory/notes` handler at line 420)
- Modify: `~/.claude` TRIP skill usage docs — **no**: instead create `docs/MARCO.md` (usage doc other sessions and TRIP runs follow)

**Interfaces:**
- Consumes: `insertMarcoEvent` (Task 2).
- Produces: every note/fact the brain explicitly saves is mirrored as a Marco event; `docs/MARCO.md` instructs Claude/Codex sessions to call `marco-report.sh` at milestones.

- [ ] **Step 1: Notes bridge.** Privacy rule (Global Constraints) forbids harvesting gateway *conversations* — the bridge mirrors only what the brain explicitly chose to remember via the memory PEN. In the `POST /memory/notes` handler, after the existing insert:

```js
insertMarcoEvent({ agent: 'gateway-brain', platform: 'fleet', action: `noted: ${String(text).slice(0, 150)}`,
  outcome: 'ok', detail: '', tags: `note,${kind}` });
```

*(match the handler's local variable names — it destructures the body at line ~424).*

- [ ] **Step 2: Write `docs/MARCO.md`** — one page: what Marco is (link the spec), the four calls every working session/agent should make (`/marco/briefing` at start — automatic via session-start.sh; `marco-report.sh` after each meaningful action; `/marco/ask` when stuck; `agent-report.sh` unchanged), and the TRIP rule: *TRIP-2/TRIP-3 runs end with `bash /opt/jarvis/scripts/marco-report.sh codex-run <platform> <ok|failed> "<what shipped>" "<notes>" trip`*. Reference `docs/MARCO.md` from `CLAUDE.md`'s session-protocol section (one line, `git add -p`).
- [ ] **Step 3: Verify** — save a note through the brain path or curl `POST /memory/notes` with `{"text":"marco bridge smoke","kind":"note"}`, confirm the mirrored event.
- [ ] **Step 4: Commit** — `git add docs/MARCO.md && git add -p src/memory-server.js CLAUDE.md && git commit -m "feat(marco): gateway notes bridge + fleet usage doc"`

---

### Task 11: Load test — elastic capacity under synthetic load

**Files:** none created (throwaway jobs via API)

- [ ] **Step 1: Baseline** — `uptime`, deck health latency: `time curl -s -o /dev/null https://127.0.0.1:9210/ -k` (use the deck's actual health path — check `grep -n health src/deck-server.js | head -3`).
- [ ] **Step 2: Load 12 no-op jobs** through the existing queue API (`POST /memory/jobs` — check its required body fields at line 785 first; task text like `echo marco load test — do nothing and exit`, lowest priority). Watch: `watch -n5 "curl -s http://127.0.0.1:9205/status | jq '{running: .running, maxConcurrent}'"` — expect slots to climb toward the ceiling and never past it; `logEvent` capacity lines appear in orchestrator logs.
- [ ] **Step 3: Pressure test** — `nice -n 19 stress-ng --cpu 4 --timeout 120 &` (install if missing, or use `yes > /dev/null &` ×4, killed after). Confirm: no NEW jobs start while loaded (capacity log shows 0 slots), running jobs finish, deck health latency stays within 2× baseline.
- [ ] **Step 4: Drain + record** — kill the load, confirm queue drains, then `bash scripts/marco-report.sh plan-test box ok "elastic capacity load test passed" "<numbers observed>" capacity`. Clean up the test jobs' rows if the jobs API supports it; otherwise leave them (they're `done`, harmless).

---

### Task 12: Go-live checklist (Craig's call — prepare, don't flip)

**Files:**
- Create: `reports/marco-go-live.md`

- [ ] **Step 1:** After ≥2 days in observe: collect curator dry-run files, janitor daily reports, capacity log lines, event counts by agent (`sqlite3 /opt/jarvis/memory/jarvis.db "SELECT agent, COUNT(*) FROM marco_events GROUP BY 1 ORDER BY 2 DESC"`).
- [ ] **Step 2:** Write `reports/marco-go-live.md`: what ran, what the curator WOULD have filed (sane?), what the janitor WOULD have deleted (sane?), any flood-cap warnings, capacity behavior. End with the two flips Craig makes: `MARCO_MODE=full` and (if janitor output was sane) `JANITOR_MODE=clean` in `config/marco.env` — no restart needed.
- [ ] **Step 3:** File it: `bash scripts/agent-report.sh curator 0 action_needed "Marco go-live review ready" "reports/marco-go-live.md"` and tell Craig directly.
- [ ] **Step 4: Commit** — `git add reports/marco-go-live.md && git commit -m "docs(marco): go-live review for Craig"`

---

## Self-review notes (done at planning time)

- **Spec coverage:** §2 store → Tasks 2–3 (deviation: reuse `lessons` table, spec's "bridge" taken to its conclusion); §3 ingest → Tasks 2, 4, 5, 9; §4 loop-back → Tasks 3, 4 (digest in curator persona, Task 6); §5 curator → Task 6; §6 janitor → Task 7; §7 elastic → Tasks 8, 11; §8 guardrails → Tasks 1, 2 (mode+caps), 9 (token), 6/7 (dry-run/report-only); §9 testing → per-task verifies + Task 11; §10 rollout = task order; MARCO_MODE=full flip → Task 12 (Craig).
- **Spec deviations, with reasons:** (1) lessons table reused, not duplicated — same API the fleet already reads; (2) janitor is a deterministic script, not an LLM agent — a whitelist doesn't need a model, and it can't hallucinate an `rm`; (3) gateway conversations are NOT distilled (spec §3 said harvester would) — that violates the codebase's documented privacy hard rule (harvest.js header, 2026-08-06 incident); only explicitly saved notes are mirrored. Flag all three to Craig at review.
- **Type consistency:** `insertMarcoEvent(raw)` (Tasks 2→5→10), `computeSlots`/`ceilingFor` (Task 8 test↔impl), `marco-report.sh` arg order (Tasks 4→7→9→10) checked.

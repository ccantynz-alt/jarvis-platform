import Database from 'better-sqlite3';
import express from 'express';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { clampLimit } from './lib/guardrail.js';
// The one definition of a finding's identity, shared with code-health.js so the
// producer and the store cannot disagree about what counts as the same defect.
import { fingerprint } from './lib/findings.js';
import { validateProposal, canTransition, describeDecision } from './lib/proposals.js';
// Lesson identity is computed server-side, same reasoning as finding
// fingerprints: the field that decides new-vs-recurring must not be a caller's.
import { normalizeLesson, lessonFingerprint } from './lib/harvest.js';
import { internalGuard } from './lib/internal-http.js';
import { normalizeEvent, capVerdict, parseMarcoEnv } from './lib/marco.js';

mkdirSync('/opt/jarvis/memory', { recursive: true });
mkdirSync('/opt/jarvis/logs', { recursive: true });

const db = new Database('/opt/jarvis/memory/jarvis.db');
// WAL so readers never block on a writer — this DB is the spine every Jarvis
// service reads on a hot path. (Was journal_mode=delete despite the backup
// script's name; online db.backup() still works fine under WAL.)
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
const app = express();
app.use(express.json());

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    objective TEXT,
    summary TEXT,
    files_changed TEXT,
    issues_found TEXT,
    issues_fixed TEXT,
    issues_open TEXT,
    proof TEXT
  );

  CREATE TABLE IF NOT EXISTS platform_state (
    platform TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_known_errors TEXT,
    last_audit TEXT,
    last_screenshot TEXT,
    health_score INTEGER DEFAULT 0,
    notes TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repair_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    file_path TEXT NOT NULL,
    issue TEXT NOT NULL,
    fix_applied TEXT,
    fix_verified INTEGER DEFAULT 0,
    attempted_at TEXT NOT NULL,
    verified_at TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_context (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'jarvis',
    level TEXT NOT NULL DEFAULT 'info',
    title TEXT NOT NULL,
    body TEXT,
    speech TEXT,
    read_at TEXT
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    platform TEXT,
    agent TEXT,
    parent_job_id TEXT,
    enqueued_by TEXT NOT NULL DEFAULT 'api',
    task TEXT NOT NULL,
    prompt TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    executor TEXT,
    runtime TEXT NOT NULL DEFAULT 'claude',
    server TEXT,
    path TEXT,
    priority INTEGER NOT NULL DEFAULT 5,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    timeout_min INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    exit_code INTEGER,
    output TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_agent ON jobs(agent, created_at);

  CREATE TABLE IF NOT EXISTS agent_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT,
    agent TEXT NOT NULL,
    ts TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ok',
    summary TEXT NOT NULL,
    details TEXT,
    routed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_agent_reports_agent ON agent_reports(agent, ts);

  CREATE TABLE IF NOT EXISTS job_transitions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_job_transitions_job ON job_transitions(job_id);

  -- Code-level defects found by the code-health spine (src/code-health.js).
  -- Deliberately NOT agent_reports: a report is a moment ("here is what I did
  -- today"), a finding is a THING WITH A LIFE — it is discovered, verified or
  -- refuted, fixed, and can come back. fingerprint is what gives it that life:
  -- the same defect found on ten consecutive sweeps is one row with seen_count
  -- 10, not ten rows Craig has to re-read. Without it a deep-review loop
  -- becomes its own firehose within a week.
  CREATE TABLE IF NOT EXISTS code_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL UNIQUE,
    platform TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'medium',
    kind TEXT NOT NULL DEFAULT 'correctness',
    title TEXT NOT NULL,
    file_path TEXT,
    line INTEGER,
    evidence TEXT,
    suggested_fix TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    verdict TEXT,
    lens TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    seen_count INTEGER NOT NULL DEFAULT 1,
    job_id TEXT,
    fix_job_id TEXT,
    resolved_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_code_findings_platform ON code_findings(platform, status, severity);

  -- Governance (2026-08-05, docs/GOVERNANCE.md). A PROPOSAL is a change an
  -- agent wants to make and has NOT made. It is distinct from a finding (a
  -- defect that exists) and from a job (work being executed): the proposal is
  -- the thing a human or an officer can refuse.
  --
  -- artifact_url is the PR — the proposal's evidence that the change is real
  -- and reviewable without being applied.
  CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    platform TEXT,
    change_class TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'medium',
    title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    evidence TEXT NOT NULL,
    artifact_url TEXT,
    artifact_kind TEXT,
    finding_id INTEGER,
    job_id TEXT,
    status TEXT NOT NULL DEFAULT 'proposed',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    reviewed_by TEXT,
    reviewed_at TEXT,
    review_notes TEXT,
    executed_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, domain);

  -- APPEND-ONLY. Nothing in this codebase may UPDATE or DELETE a row here —
  -- a trail that can be edited proves nothing, and this is the table that
  -- answers "who approved this change, on what basis" during due diligence.
  CREATE TABLE IF NOT EXISTS proposal_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    notes TEXT,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_proposal_audit_proposal ON proposal_audit(proposal_id, id);

  -- The intelligent flywheel (2026-08-07, src/session-harvester.js). A
  -- coding_session is the INDEX of a CLI transcript (metadata + redacted
  -- outcome, never the raw text — that stays on disk at raw_path); a lesson is
  -- what a distillation agent extracted from it. NOT the \`sessions\` table
  -- above: that one is the manual session-start/end protocol, this one is
  -- automatic harvest. Lessons dedupe by fingerprint (the code_findings
  -- argument: the same lesson learned ten times is one row seen 10×).
  CREATE TABLE IF NOT EXISTS coding_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL UNIQUE,
    machine TEXT NOT NULL DEFAULT 'vultr',
    platform TEXT,
    cwd TEXT,
    started_at TEXT,
    ended_at TEXT,
    user_turns INTEGER DEFAULT 0,
    assistant_turns INTEGER DEFAULT 0,
    tool_calls INTEGER DEFAULT 0,
    files_touched TEXT,
    outcome TEXT,
    raw_path TEXT NOT NULL,
    harvested_at TEXT NOT NULL,
    distilled_at TEXT,
    distill_status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE INDEX IF NOT EXISTS idx_coding_sessions_distill ON coding_sessions(distill_status, harvested_at);
  CREATE INDEX IF NOT EXISTS idx_coding_sessions_platform ON coding_sessions(platform, ended_at);

  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL UNIQUE,
    session_id INTEGER,
    platform TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'gotcha',
    lesson TEXT NOT NULL,
    evidence TEXT,
    confidence TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'active',
    seen_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lessons_platform ON lessons(platform, status, seen_count);

  -- Brain turn telemetry (2026-08-19, audit move 24). Every "faster/smarter"
  -- claim about the brain was unmeasured, and the subscription→metered-API move
  -- (product path) is blind without per-turn latency and token counts. One row
  -- per conversational turn; subject to the same retention sweep as the other
  -- telemetry tables.
  CREATE TABLE IF NOT EXISTS brain_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    surface TEXT,           -- deck | gateway
    provider TEXT,          -- claude | openai | …
    model TEXT,
    effort TEXT,
    first_token_ms INTEGER,
    total_ms INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    tools_used INTEGER,
    outcome TEXT            -- ok | error | timeout
  );
  CREATE INDEX IF NOT EXISTS idx_brain_turns_ts ON brain_turns(ts);

  -- The memory PEN (2026-08-19, audit move 14). Until now nothing Marco learned
  -- in conversation survived the 24-message window: no way to remember a fact
  -- Craig told him, recall it later, or set a reminder. Two additive tables.
  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',   -- note | preference | fact
    text TEXT NOT NULL,
    tags TEXT,
    source TEXT DEFAULT 'brain',
    archived_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_notes_ts ON notes(ts);
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    due_at TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | fired | canceled
    fired_at TEXT,
    source TEXT DEFAULT 'brain'
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, due_at);

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
`);

// Additive migrations for columns added after a table first shipped.
try { db.exec('ALTER TABLE jobs ADD COLUMN model TEXT'); } catch { /* already present */ }
// PC-worker lease (pull-based dispatch, 2026-07-19): a claimed job records
// WHO holds it and UNTIL WHEN — the orchestrator reaps an expired lease
// (worker slept/crashed) back to queued instead of waiting forever.
try { db.exec('ALTER TABLE jobs ADD COLUMN lease_until TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE jobs ADD COLUMN worker_id TEXT'); } catch { /* already present */ }
// Which commit a code finding was found IN (2026-07-30). Local checkouts drift:
// /opt/alecrae was 28 commits behind its remote during the first live sweep, so
// a finding can be real for the code on this box and already fixed upstream.
// Without the sha, nobody can tell those two cases apart later.
// platform_state.consecutive_critical is read AND written by this file's
// /memory/platform/update, but the only migration that created it lived in
// audit-runner.js — a different service (2026-07-30, found by the code-health
// spine). On a fresh box or a rebuilt DB, if jarvis-audit hasn't started yet (or
// is masked, or failed), better-sqlite3 throws "no such column" on every call:
// express 500s, fleet-check.sh's 10-minute writes are all discarded, and
// self-heal sees an empty fleet. A table's owner must create its own columns.
try { db.exec('ALTER TABLE platform_state ADD COLUMN consecutive_critical INTEGER DEFAULT 0'); } catch { /* already present */ }
// Same reasoning for audit-runner.js's repeat bookkeeping (2026-08-05): this
// service must not be the one that 500s because another service hasn't started.
try { db.exec('ALTER TABLE platform_state ADD COLUMN audit_fingerprint TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE platform_state ADD COLUMN audit_repeat INTEGER DEFAULT 0'); } catch { /* already present */ }
try { db.exec('ALTER TABLE code_findings ADD COLUMN commit_sha TEXT'); } catch { /* already present */ }
// When a finding was last RE-CHECKED against current code (2026-07-30). Without
// this the table only ever grows: nothing marked anything `fixed`, so a confirmed
// finding stayed confirmed after it was repaired and get_code_findings would keep
// reciting repaired bugs — the same firehose failure this design fights, one
// level up. Re-check candidates are ordered by COALESCE(last_checked, first_seen).
try { db.exec('ALTER TABLE code_findings ADD COLUMN last_checked TEXT'); } catch { /* already present */ }
try { db.exec('ALTER TABLE lessons ADD COLUMN source_event_ids TEXT'); } catch { /* already present */ }
try { db.exec("ALTER TABLE lessons ADD COLUMN author TEXT DEFAULT 'harvester'"); } catch { /* already present */ }
// FTS over lessons + events for /marco/ask. External-content-free (contentless
// would forbid the delete triggers); rebuilt cheap, sized small by the caps.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS marco_fts USING fts5(kind, ref_id, text);
`);

// One-time backfill: mirror existing lessons into marco_fts so /marco/ask can
// find lessons filed before this table existed. Idempotent — skips once any
// lesson row is present.
const marcoFtsLessonCount = db.prepare("SELECT COUNT(*) c FROM marco_fts WHERE kind = 'lesson'").get().c;
if (marcoFtsLessonCount === 0) {
  for (const l of db.prepare('SELECT id, platform, kind, lesson, evidence FROM lessons').all()) {
    db.prepare("INSERT INTO marco_fts (kind, ref_id, text) VALUES ('lesson', ?, ?)")
      .run(String(l.id), `${l.platform} ${l.kind} ${l.lesson} ${l.evidence || ''}`);
  }
}

// ── Indexes + retention (2026-08-19, audit move 10) ──────────────────────────
// `notifications` had NO index: the 10-minute dedupe in POST /memory/notifications
// (source, level, title, ts) and the deck's 15-second unread polls were full
// scans of a table nothing ever pruned. And nothing in this file DELETEd
// anything, ever — notifications, job_transitions, agent_reports, proposal_audit
// and coding_sessions grew forever (16 MB on 2026-08-19 and climbing).
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(source, level, title, ts);
  CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts);
  CREATE INDEX IF NOT EXISTS idx_job_transitions_ts ON job_transitions(ts);
`);

// Retention: a daily age-out of the append-only telemetry tables. Days via
// guardrail-style env (NaN/0 never means "delete everything": < 7 is refused
// and falls back). Jobs, findings, proposals, lessons and platform_state are
// NOT touched — they are state, not telemetry.
//
// `FINDINGS_STALE_DAYS` ages untouched `open` low/medium findings to the
// `stale` status the schema already allows and nothing ever set (debt #8: 371
// rows with no exit path). OFF by default (0) — turning it on changes what the
// backlog number means, which is Craig's call.
const envDays = (k, dflt) => { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 7 ? Math.floor(n) : dflt; };
const RETENTION_DAYS = envDays('MEMORY_RETENTION_DAYS', 90);
const STALE_DAYS = (() => { const n = Number(process.env.FINDINGS_STALE_DAYS); return Number.isFinite(n) && n >= 14 ? Math.floor(n) : 0; })();
export function runRetention(now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400_000).toISOString();
  const out = {};
  const run = (label, sql, ...params) => { try { out[label] = db.prepare(sql).run(...params).changes; } catch (e) { out[label] = `ERR ${e.message}`; } };
  run('notifications', 'DELETE FROM notifications WHERE ts < ?', cutoff);
  run('job_transitions', 'DELETE FROM job_transitions WHERE ts < ?', cutoff);
  run('agent_reports', 'DELETE FROM agent_reports WHERE ts < ?', cutoff);
  // proposal_audit is the governance trail: only rows of proposals that are
  // themselves terminal AND older than the window; never the trail of a live one.
  run('proposal_audit', `DELETE FROM proposal_audit WHERE at < ? AND proposal_id IN
      (SELECT id FROM proposals WHERE status IN ('rejected','withdrawn','executed') AND updated_at < ?)`, cutoff, cutoff);
  run('coding_sessions', 'DELETE FROM coding_sessions WHERE ended_at < ? AND distill_status IN (\'done\',\'skipped\',\'failed\')', cutoff);
  run('brain_turns', 'DELETE FROM brain_turns WHERE ts < ?', cutoff);
  // Delivered/canceled reminders are telemetry once past; a pending one is
  // never aged out however old. Notes are DURABLE memory — never aged.
  run('reminders', "DELETE FROM reminders WHERE status IN ('fired','canceled') AND COALESCE(fired_at, created_at) < ?", cutoff);
  if (STALE_DAYS) {
    const staleCut = new Date(now.getTime() - STALE_DAYS * 86400_000).toISOString();
    run('findings_stale', `UPDATE code_findings SET status = 'stale', resolved_at = ?
        WHERE status = 'open' AND severity IN ('low','medium') AND COALESCE(last_checked, last_seen) < ?`, now.toISOString(), staleCut);
  }
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch { /* best effort */ }
  return out;
}
// Once an hour after boot (cheap when there is nothing to do), so a restart
// never skips a day and a long-running process still prunes.
setTimeout(() => {
  const tick = () => { const r = runRetention(); const n = Object.values(r).filter(v => typeof v === 'number' && v > 0); if (n.length) console.log(`[memory] retention (${RETENTION_DAYS}d): ${JSON.stringify(r)}`); };
  tick();
  setInterval(tick, 3600_000).unref?.();
}, 60_000).unref?.();

// Platform names from the registry (2026-08-19, audit move 21): two hardcoded
// lists here drifted from config/platforms.json — the seed still named the
// retired `esim` and omitted every platform added since, and the query router's
// list omitted davenroe and gluecron. One loader, read at boot; falls back to a
// minimal seed only if the registry is unreadable.
function registryPlatforms() {
  try {
    const reg = JSON.parse(readFileSync('/opt/jarvis/config/platforms.json', 'utf8')).platforms || {};
    return Object.keys(reg).filter(k => k !== 'craig-pc');   // craig-pc is the PC worker, not a platform_state row
  } catch {
    return ['zoobicon', 'vapron', 'alecrae', 'gatetest'];
  }
}
const PLATFORMS = registryPlatforms();
PLATFORMS.forEach(p => {
  db.prepare(`
    INSERT OR IGNORE INTO platform_state (platform, status, updated_at)
    VALUES (?, 'unknown', ?)
  `).run(p, new Date().toISOString());
});

// ── Notes + reminders: the memory pen (move 14) ──────────────────────────────
// POST /memory/notes {text, kind?, tags?, source?}
app.post('/memory/notes', (req, res) => {
  const { text, kind = 'note', tags = null, source = 'brain' } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  const k = ['note', 'preference', 'fact'].includes(kind) ? kind : 'note';
  const info = db.prepare('INSERT INTO notes (ts, kind, text, tags, source) VALUES (?,?,?,?,?)')
    .run(new Date().toISOString(), k, String(text).slice(0, 4000), tags ? String(tags).slice(0, 300) : null, source);
  try {
    insertMarcoEvent({ agent: 'gateway-brain', platform: 'fleet', action: `noted: ${String(text).slice(0, 150)}`,
      outcome: 'ok', detail: '', tags: `note,${k}` });
  } catch { /* Marco bridge must never break the primary notes write */ }
  res.json({ ok: true, id: info.lastInsertRowid });
});
// GET /memory/notes?q=&kind=&limit= — recall (LIKE over text+tags, newest first)
app.get('/memory/notes', (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 100);
  const q = String(req.query.q || '').trim();
  const kind = String(req.query.kind || '').trim();
  const where = ['archived_at IS NULL'];
  const params = {};
  if (q) { where.push('(text LIKE @q OR tags LIKE @q)'); params.q = `%${q}%`; }
  if (['note', 'preference', 'fact'].includes(kind)) { where.push('kind = @kind'); params.kind = kind; }
  const rows = db.prepare(`SELECT id, ts, kind, text, tags FROM notes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${limit}`).all(params);
  res.json({ notes: rows });
});
// POST /memory/notes/:id/archive — forget a note
app.post('/memory/notes/:id/archive', (req, res) => {
  const info = db.prepare('UPDATE notes SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(new Date().toISOString(), req.params.id);
  res.json({ ok: info.changes > 0 });
});

// POST /memory/reminders {due_at (ISO), text}
app.post('/memory/reminders', (req, res) => {
  const { due_at, text, source = 'brain' } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text required' });
  const due = Date.parse(due_at);
  if (!Number.isFinite(due)) return res.status(400).json({ error: 'due_at must be an ISO timestamp' });
  const info = db.prepare('INSERT INTO reminders (created_at, due_at, text, source) VALUES (?,?,?,?)')
    .run(new Date().toISOString(), new Date(due).toISOString(), String(text).slice(0, 1000), source);
  res.json({ ok: true, id: info.lastInsertRowid, due_at: new Date(due).toISOString() });
});
// GET /memory/reminders?status=pending&due=1&limit=
app.get('/memory/reminders', (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 100);
  const status = ['pending', 'fired', 'canceled'].includes(String(req.query.status)) ? String(req.query.status) : 'pending';
  const dueOnly = String(req.query.due) === '1';
  const where = ['status = @status'];
  const params = { status };
  if (dueOnly) { where.push('due_at <= @now'); params.now = new Date().toISOString(); }
  const rows = db.prepare(`SELECT id, created_at, due_at, text, status FROM reminders WHERE ${where.join(' AND ')} ORDER BY due_at ASC LIMIT ${limit}`).all(params);
  res.json({ reminders: rows });
});
// POST /memory/reminders/:id/fired — the poller marks a reminder delivered
app.post('/memory/reminders/:id/fired', (req, res) => {
  const info = db.prepare("UPDATE reminders SET status='fired', fired_at=? WHERE id=? AND status='pending'").run(new Date().toISOString(), req.params.id);
  res.json({ ok: info.changes > 0 });
});
// POST /memory/reminders/:id/cancel
app.post('/memory/reminders/:id/cancel', (req, res) => {
  const info = db.prepare("UPDATE reminders SET status='canceled' WHERE id=? AND status='pending'").run(req.params.id);
  res.json({ ok: info.changes > 0 });
});

// POST /memory/brain-turn — one row of brain telemetry (move 24).
app.post('/memory/brain-turn', (req, res) => {
  const b = req.body || {};
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  try {
    const info = db.prepare(`INSERT INTO brain_turns
      (ts, surface, provider, model, effort, first_token_ms, total_ms, input_tokens, output_tokens, cost_usd, tools_used, outcome)
      VALUES (@ts,@surface,@provider,@model,@effort,@first_token_ms,@total_ms,@input_tokens,@output_tokens,@cost_usd,@tools_used,@outcome)`).run({
      ts: new Date().toISOString(),
      surface: b.surface || null, provider: b.provider || null, model: b.model || null, effort: b.effort || null,
      first_token_ms: num(b.first_token_ms), total_ms: num(b.total_ms),
      input_tokens: num(b.input_tokens), output_tokens: num(b.output_tokens), cost_usd: num(b.cost_usd),
      tools_used: num(b.tools_used), outcome: b.outcome || null,
    });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /memory/brain-turns/summary?hours=24 — rollup for the deck / a quick check.
app.get('/memory/brain-turns/summary', (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 720);
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  try {
    const byModel = db.prepare(`SELECT model, provider, COUNT(*) turns,
        ROUND(AVG(first_token_ms)) avg_first_token_ms, ROUND(AVG(total_ms)) avg_total_ms,
        SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
        ROUND(SUM(COALESCE(cost_usd,0)),4) cost_usd,
        SUM(CASE WHEN outcome='ok' THEN 1 ELSE 0 END) ok
      FROM brain_turns WHERE ts >= ? GROUP BY model, provider ORDER BY turns DESC`).all(since);
    const total = db.prepare('SELECT COUNT(*) turns FROM brain_turns WHERE ts >= ?').get(since);
    res.json({ hours, turns: total.turns, by_model: byModel });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /memory/health
app.get('/memory/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), db: '/opt/jarvis/memory/jarvis.db' });
});

// GET /memory/context?platform=zoobicon
app.get('/memory/context', (req, res) => {
  const { platform } = req.query;

  const state = platform
    ? db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(platform)
    : db.prepare('SELECT * FROM platform_state ORDER BY updated_at DESC').all();

  const recentSessions = db.prepare(`
    SELECT * FROM sessions
    WHERE (? IS NULL OR platform = ?)
    ORDER BY started_at DESC LIMIT 10
  `).all(platform || null, platform || null);

  const openIssues = db.prepare(`
    SELECT * FROM repair_log
    WHERE fix_verified = 0
    AND (? IS NULL OR platform = ?)
    ORDER BY attempted_at DESC LIMIT 30
  `).all(platform || null, platform || null);

  res.json({
    generated_at: new Date().toISOString(),
    platform_filter: platform || 'all',
    platform_state: state,
    recent_sessions: recentSessions,
    open_issues: openIssues,
    instruction: 'READ THIS BEFORE TOUCHING ANY CODE. This is ground truth.'
  });
});

// POST /memory/session/start
app.post('/memory/session/start', (req, res) => {
  const { platform, objective } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform required' });
  const result = db.prepare(`
    INSERT INTO sessions (platform, started_at, objective)
    VALUES (?, ?, ?)
  `).run(platform, new Date().toISOString(), objective || 'No objective stated');
  res.json({ session_id: result.lastInsertRowid, started_at: new Date().toISOString() });
});

// POST /memory/session/end
app.post('/memory/session/end', (req, res) => {
  const { session_id, summary, files_changed, issues_found, issues_fixed, issues_open, proof } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  const info = db.prepare(`
    UPDATE sessions SET
      ended_at = ?,
      summary = ?,
      files_changed = ?,
      issues_found = ?,
      issues_fixed = ?,
      issues_open = ?,
      proof = ?
    WHERE id = ?
  `).run(
    new Date().toISOString(),
    summary || 'No summary',
    JSON.stringify(files_changed || []),
    JSON.stringify(issues_found || []),
    JSON.stringify(issues_fixed || []),
    JSON.stringify(issues_open || []),
    proof || 'none',
    session_id
  );
  // Honest about a miss (2026-08-19): an UPDATE that matched no row returned
  // ok:true, so session-end.sh printed "recorded" for an id that did not exist
  // — the summary was gone and nobody knew.
  if (!info.changes) return res.status(404).json({ ok: false, error: `no session ${session_id}` });
  res.json({ ok: true, session_id });
});

// GET /memory/platform/:name — read side of /memory/platform/update.
// conversation.js handlePlatformStatus expects {name,status,health_score,
// last_issue,last_audit,notes}; an unknown platform returns 200 {} so the
// caller's "no memory data yet" branch runs instead of an error message.
app.get('/memory/platform/:name', (req, res) => {
  const row = db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(req.params.name);
  if (!row) return res.json({});
  let lastIssue = null;
  try { lastIssue = JSON.parse(row.last_known_errors || '[]')[0] || null; } catch { /* legacy free-text errors */ }
  res.json({
    name: row.platform,
    status: row.status,
    health_score: row.health_score,
    last_issue: lastIssue,
    last_audit: row.updated_at,
    notes: row.notes,
  });
});

// POST /memory/platform/update
app.post('/memory/platform/update', (req, res) => {
  const { platform, status, last_known_errors, health_score, notes } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform required' });
  // Preserve columns this endpoint doesn't manage (2026-07-23 fix — found via
  // Craig reporting Vapron flip-flopping between "critical" and "healthy").
  // INSERT OR REPLACE deletes+reinserts the WHOLE row, and this statement
  // never touched last_audit/last_screenshot/consecutive_critical — so every
  // call here (fleet-check.sh runs this every 10 minutes) silently wiped
  // those back to null/0, wiping out audit-runner.js's own bookkeeping
  // between its daily runs, including the consecutive_critical counter the
  // self-repair guardrail depends on. Read-then-preserve fixes it.
  //
  // 2026-07-30 (found by the code-health spine): that 2026-07-23 fix preserved
  // the three columns it listed and left the OTHER three being destroyed by
  // omission. `JSON.stringify(last_known_errors || [])` wrote `[]` and
  // `health_score || 0` wrote 0 whenever a caller simply didn't mention them:
  //   - fleet-check.sh posts status/health_score/notes every 10 minutes and never
  //     sends last_known_errors, so the audit's recorded errors were erased six
  //     times an hour;
  //   - orchestrator.js's logToMemory posts status/notes only, so EVERY job
  //     completion zeroed health_score — and conversation.js reads
  //     `health_score > 80` as healthy, so a perfectly fine platform showed as
  //     unhealthy right after any agent ran. That is the "false reports of
  //     websites being down" family all over again.
  // Omission now means "leave it alone"; only an explicit value writes. An
  // explicit 0 or [] still lands, which is why these are `!== undefined` checks
  // and not `||`.
  // 2026-08-05: the read-then-preserve version of this was fixed twice and broke
  // a THIRD time the moment audit-runner.js added audit_fingerprint/audit_repeat
  // — every 10-minute fleet-check write nulled them, so the repeat counter
  // could never reach its threshold and the suppression it feeds silently did
  // nothing. Caught only because the behaviour was verified live rather than
  // read.
  //
  // The pattern was the defect, not any individual omission: with INSERT OR
  // REPLACE, a column is destroyed by NOT being mentioned, so every future
  // column added by any other service is wiped by default and the failure is
  // silent. An UPSERT inverts that — it touches exactly the columns named here
  // and leaves every other column, present or future, alone by construction.
  // Do not turn this back into INSERT OR REPLACE.
  //
  // Omission still means "leave it alone" (COALESCE against the stored value),
  // while an explicit 0 or [] still lands — which is why these are null checks
  // and not `||`.
  // The parameters are referenced directly rather than through `excluded.`
  // because the two branches need different fallbacks for the same null:
  // a fresh row falls back to the column default, an existing row falls back to
  // its stored value. `status` is NOT NULL, and a column DEFAULT does not apply
  // when NULL is passed explicitly — so the INSERT half must spell 'unknown'
  // out, while `excluded.status` would then carry that 'unknown' into the
  // UPDATE half and overwrite a real status with it.
  db.prepare(`
    INSERT INTO platform_state (platform, status, last_known_errors, health_score, notes, updated_at)
    VALUES (@platform, COALESCE(@status, 'unknown'), @last_known_errors, COALESCE(@health_score, 0), @notes, @updated_at)
    ON CONFLICT(platform) DO UPDATE SET
      status            = COALESCE(@status,            platform_state.status),
      last_known_errors = COALESCE(@last_known_errors, platform_state.last_known_errors),
      health_score      = COALESCE(@health_score,      platform_state.health_score),
      notes             = COALESCE(@notes,             platform_state.notes),
      updated_at        = @updated_at
  `).run({
    platform,
    status: status ?? null,
    last_known_errors: last_known_errors === undefined || last_known_errors === null
      ? null
      : JSON.stringify(last_known_errors),
    health_score: health_score ?? null,
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// POST /memory/repair/log
app.post('/memory/repair/log', (req, res) => {
  const { platform, file_path, issue, fix_applied } = req.body;
  if (!platform || !file_path || !issue) {
    return res.status(400).json({ error: 'platform, file_path, issue required' });
  }
  const result = db.prepare(`
    INSERT INTO repair_log (platform, file_path, issue, fix_applied, attempted_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(platform, file_path, issue, fix_applied || null, new Date().toISOString());
  try {
    insertMarcoEvent({ agent: 'self-heal', platform, action: `repair: ${issue}`.slice(0, 200),
      outcome: fix_applied ? 'fixed' : 'failed', detail: fix_applied || '', tags: 'self-heal,repair' });
  } catch { /* Marco bridge must never break the primary repair-log write */ }
  res.json({ repair_id: result.lastInsertRowid });
});

// POST /memory/repair/verify
app.post('/memory/repair/verify', (req, res) => {
  const { repair_id, verified } = req.body;
  if (!repair_id) return res.status(400).json({ error: 'repair_id required' });
  db.prepare(`
    UPDATE repair_log SET fix_verified = ?, verified_at = ? WHERE id = ?
  `).run(verified ? 1 : 0, new Date().toISOString(), repair_id);
  res.json({ ok: true });
});

// ── Notifications (Gateway inbox — durable store, see docs/GATEWAY.md) ──────

// POST /memory/notifications — record a notification
app.post('/memory/notifications', (req, res) => {
  const { source = 'jarvis', level = 'info', title, body, speech } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  // Dedup: a repeatedly-firing condition (a flapping probe, a stuck job) must
  // not mint a new row — and a new spoken alert — every time. Collapse an
  // identical (source, level, title) within a short window onto the last row.
  const DEDUP_WINDOW_MS = 10 * 60 * 1000;
  const recent = db.prepare(`
    SELECT id FROM notifications
    WHERE source = ? AND level = ? AND title = ?
      AND ts > ? ORDER BY id DESC LIMIT 1
  `).get(source, level, title, new Date(Date.now() - DEDUP_WINDOW_MS).toISOString());
  if (recent) return res.json({ id: recent.id, deduped: true });
  const result = db.prepare(`
    INSERT INTO notifications (ts, source, level, title, body, speech)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(new Date().toISOString(), source, level, title, body || null, speech || null);
  res.json({ id: result.lastInsertRowid });
});

// GET /memory/notifications?unread=1&limit=50
app.get('/memory/notifications', (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 200);
  const rows = req.query.unread
    ? db.prepare('SELECT * FROM notifications WHERE read_at IS NULL ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(limit);
  const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL').get().c;
  res.json({ notifications: rows, unread });
});

// POST /memory/notifications/read-all
app.post('/memory/notifications/read-all', (req, res) => {
  const r = db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL')
    .run(new Date().toISOString());
  res.json({ ok: true, marked: r.changes });
});

// POST /memory/notifications/:id/read
app.post('/memory/notifications/:id/read', (req, res) => {
  const r = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL')
    .run(new Date().toISOString(), req.params.id);
  res.json({ ok: true, marked: r.changes });
});

// ── Durable job queue (orchestrator's system of record — see plan Phase 1) ──

const JOB_STATUSES = ['queued', 'running', 'completed', 'failed', 'interrupted', 'held', 'canceled'];
// Fields a transition is allowed to update alongside the status change.
const JOB_MUTABLE = ['executor', 'attempts', 'started_at', 'finished_at', 'exit_code', 'output', 'error', 'lease_until', 'worker_id'];

const insertTransition = db.prepare(`
  INSERT INTO job_transitions (job_id, ts, from_status, to_status, detail)
  VALUES (?, ?, ?, ?, ?)
`);

// requireFrom, when set, makes the UPDATE conditional on the CURRENT status
// still matching it (single synchronous statement — better-sqlite3 never
// yields mid-call, so this is atomic across concurrent HTTP requests, e.g.
// two PC-worker claims racing for the same queued job). Returns false
// (no-op, no transition row written) when the row had already moved on.
const transitionJob = db.transaction((job, to, detail, fields, requireFrom) => {
  const sets = ['status = ?'];
  const vals = [to];
  for (const k of JOB_MUTABLE) {
    if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(fields[k]); }
  }
  vals.push(job.id);
  const where = requireFrom ? ' AND status = ?' : '';
  if (requireFrom) vals.push(requireFrom);
  const r = db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?${where}`).run(...vals);
  if (r.changes === 0) return false;
  insertTransition.run(job.id, new Date().toISOString(), job.status, to, detail || null);
  return true;
});

// POST /memory/jobs — enqueue a job
app.post('/memory/jobs', (req, res) => {
  const b = req.body || {};
  if (!b.id || !b.task) return res.status(400).json({ error: 'id and task required' });
  try {
    db.prepare(`
      INSERT INTO jobs (id, platform, agent, parent_job_id, enqueued_by, task, prompt,
                        status, executor, runtime, model, server, path, priority, max_attempts,
                        timeout_min, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      b.id, b.platform || null, b.agent || null, b.parent_job_id || null,
      b.enqueued_by || 'api', b.task, b.prompt || null,
      b.executor || null, b.runtime || 'claude', b.model || null, b.server || null, b.path || null,
      b.priority ?? 5, b.max_attempts ?? 1, b.timeout_min ?? 30,
      new Date().toISOString()
    );
    insertTransition.run(b.id, new Date().toISOString(), null, 'queued', b.enqueued_by || 'api');
    res.json({ id: b.id, status: 'queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /memory/jobs/counts?window=today — per-agent job counts (budget checks)
app.get('/memory/jobs/counts', (req, res) => {
  const since = req.query.window === 'today'
    ? new Date(new Date().setHours(0, 0, 0, 0)).toISOString()
    : (req.query.since || new Date(Date.now() - 86400_000).toISOString());
  const rows = db.prepare(`
    SELECT COALESCE(agent, '(none)') AS agent, COUNT(*) AS count
    FROM jobs WHERE created_at >= ? AND status != 'canceled'
    GROUP BY agent
  `).all(since);
  const byStatus = db.prepare(`SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`).all();
  res.json({ since, by_agent: rows, by_status: byStatus });
});

// GET /memory/jobs?status=&agent=&platform=&limit=
app.get('/memory/jobs', (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 500);
  const where = [];
  const vals = [];
  for (const f of ['status', 'agent', 'platform', 'executor']) {
    if (req.query[f]) { where.push(`${f} = ?`); vals.push(req.query[f]); }
  }
  const rows = db.prepare(`
    SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC LIMIT ?
  `).all(...vals, limit);
  res.json(rows);
});

// GET /memory/jobs/:id
app.get('/memory/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const transitions = db.prepare('SELECT * FROM job_transitions WHERE job_id = ? ORDER BY id').all(job.id);
  res.json({ ...job, transitions });
});

// POST /memory/jobs/:id/transition — { to, detail, fields, from }
// `from`: guard the write to only apply if the job is still in that status —
// the atomic-claim primitive for anything that competes for queued jobs
// (e.g. multiple PC workers polling /worker/claim at once). A guard miss is
// NOT an error: it means someone else claimed it first, so this returns
// 409 with the row's actual current status for the caller to react to.
app.post('/memory/jobs/:id/transition', (req, res) => {
  const { to, detail, fields = {}, from } = req.body || {};
  if (!JOB_STATUSES.includes(to)) {
    return res.status(400).json({ error: `to must be one of: ${JOB_STATUSES.join(', ')}` });
  }
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  try {
    const applied = transitionJob(job, to, detail, fields, from);
    if (!applied) {
      const now = db.prepare('SELECT status FROM jobs WHERE id = ?').get(req.params.id);
      return res.status(409).json({ error: 'status changed since read', expected: from, actual: now?.status });
    }
    if (to === 'completed' || to === 'failed') {
      try {
        insertMarcoEvent({ agent: job.agent || 'orchestrator', platform: job.platform || 'fleet',
          action: `job ${req.params.id}: ${String(job.task || '').slice(0, 150)}`,
          outcome: to === 'completed' ? 'ok' : 'failed', tags: 'job' });
      } catch { /* Marco bridge must never break the primary job transition */ }
    }
    res.json({ ok: true, id: job.id, from: job.status, to });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Agent reports (role agents file these as their mandatory last step) ────

// POST /memory/agent-report — { agent, job_id, status, summary, details }
app.post('/memory/agent-report', (req, res) => {
  const { agent, job_id, status = 'ok', summary, details } = req.body || {};
  if (!agent || !summary) return res.status(400).json({ error: 'agent and summary required' });
  if (!['ok', 'action_needed', 'escalate'].includes(status)) {
    return res.status(400).json({ error: 'status must be ok|action_needed|escalate' });
  }
  const result = db.prepare(`
    INSERT INTO agent_reports (job_id, agent, ts, status, summary, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(job_id || null, agent, new Date().toISOString(), status, summary, details || null);
  try {
    insertMarcoEvent({ agent, platform: 'fleet', action: `report: ${summary}`.slice(0, 200),
      outcome: status === 'ok' ? 'ok' : 'blocked', detail: details || '', tags: `agent-org,${status}` });
  } catch { /* Marco bridge must never break the primary agent-report write */ }
  res.json({ id: result.lastInsertRowid });
});

// GET /memory/agent-reports?agent=&status=&since=&unrouted=1&limit=
app.get('/memory/agent-reports', (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 500);
  const where = [];
  const vals = [];
  if (req.query.agent)  { where.push('agent = ?');  vals.push(req.query.agent); }
  if (req.query.status) { where.push('status = ?'); vals.push(req.query.status); }
  if (req.query.since)  { where.push('ts >= ?');    vals.push(req.query.since); }
  if (req.query.unrouted) where.push('routed_at IS NULL');
  const rows = db.prepare(`
    SELECT * FROM agent_reports ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?
  `).all(...vals, limit);
  res.json(rows);
});

// POST /memory/agent-reports/:id/routed — scheduler marks a report as handled
app.post('/memory/agent-reports/:id/routed', (req, res) => {
  const r = db.prepare('UPDATE agent_reports SET routed_at = ? WHERE id = ? AND routed_at IS NULL')
    .run(new Date().toISOString(), req.params.id);
  res.json({ ok: true, marked: r.changes });
});

/**
 * POST /memory/kv/incr — { key, by } → { value }
 *
 * An ATOMIC counter, because a read-modify-write across the network is not one
 * (2026-07-30, found by the code-health spine's concurrency lens on the
 * ElevenLabs budget). lib/tts.js read the day's spend, made a multi-second TTS
 * call, then POSTed `snapshot + chars` — so three clients fetching /tts for the
 * same alert all read 1000 and all wrote 1000+N, recording ONE utterance instead
 * of three. A spend cap that under-counts is not a cap.
 *
 * Safe here and nowhere else: this process is single-threaded and better-sqlite3
 * is synchronous, so the read and the write inside this handler cannot interleave
 * with another request. Any caller doing the same arithmetic in its own process
 * has the race by construction.
 */
app.post('/memory/kv/incr', (req, res) => {
  const { key, by } = req.body || {};
  if (!key) return res.status(400).json({ error: 'key required' });
  const delta = Number(by);
  if (!Number.isFinite(delta)) return res.status(400).json({ error: 'by must be a finite number' });

  const row = db.prepare('SELECT value FROM agent_context WHERE key = ?').get(key);
  const current = parseInt(row?.value, 10) || 0;
  const next = current + delta;
  db.prepare(`
    INSERT INTO agent_context (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(next), new Date().toISOString());
  res.json({ key, value: next, previous: current });
});

// ── code_findings API (the code-health spine, src/code-health.js) ───────────

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const FINDING_STATUSES = ['open', 'confirmed', 'dismissed', 'fixed', 'stale'];

/**
 * POST /memory/findings — upsert ONE finding by fingerprint.
 *
 * Re-finding a defect must not create a second row, and must not overwrite what
 * we already learned about it. So:
 *   - a known finding bumps last_seen/seen_count and can only ESCALATE severity,
 *     never quietly downgrade it (one sweep calling it 'low' does not undo
 *     another that proved it 'critical');
 *   - a finding that was marked `fixed` and has come BACK is reopened as a
 *     regression — that is the single most valuable signal this table holds, and
 *     a plain INSERT OR IGNORE would have thrown it away;
 *   - `dismissed` is sticky. A verifier refuted it once; re-reporting it every
 *     sweep is exactly the noise that gets a channel muted.
 */
app.post('/memory/findings', internalGuard, (req, res) => {
  const f = req.body || {};
  if (!f.platform || !f.title) {
    return res.status(400).json({ error: 'platform and title required' });
  }
  // The SERVER computes the fingerprint (2026-07-31). It used to trust whatever
  // the caller sent, and the fingerprint is the identity of a row — it decides
  // whether a report is a new defect, a duplicate, or a REGRESSION of something
  // already fixed. Trusting a caller's value put the most consequential field in
  // this table outside the table's control.
  //
  // It bit immediately. `fingerprint()` takes three positional arguments
  // (platform, filePath, title); a hand-written filing script of mine called it
  // with a single object, so platform stringified to "[object Object]", the other
  // two were undefined, and EVERY finding filed that way hashed to the same
  // value. Two unrelated findings collided: the second was read as the first
  // reappearing, and a row that was correctly `fixed` was flipped to `regressed`
  // — which is the single most valuable signal this table carries, so corrupting
  // it is worse than dropping the write. Nothing rejected the obviously-wrong
  // `sha1("[object object]:(unknown):")` because nothing was checking.
  //
  // A caller may still send one; it is compared, not obeyed, and a mismatch is
  // logged loudly rather than silently honoured.
  const computed = fingerprint(f.platform, f.file_path, f.title);
  if (f.fingerprint && f.fingerprint !== computed) {
    console.warn(`[memory] findings: caller sent fingerprint ${f.fingerprint} but the content hashes to ${computed} — using the computed one (${f.platform} ${f.file_path || '?'})`);
  }
  f.fingerprint = computed;
  const severity = SEVERITIES.includes(f.severity) ? f.severity : 'medium';
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT * FROM code_findings WHERE fingerprint = ?').get(f.fingerprint);

  if (!existing) {
    const r = db.prepare(`
      INSERT INTO code_findings
        (fingerprint, platform, severity, kind, title, file_path, line, evidence,
         suggested_fix, status, lens, first_seen, last_seen, seen_count, job_id, commit_sha)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(f.fingerprint, f.platform, severity, f.kind || 'correctness', f.title,
      f.file_path || null, Number.isFinite(f.line) ? f.line : null, f.evidence || null,
      f.suggested_fix || null, FINDING_STATUSES.includes(f.status) ? f.status : 'open',
      f.lens || null, now, now, f.job_id || null, f.commit_sha || null);
    return res.json({ id: r.lastInsertRowid, created: true });
  }

  if (existing.status === 'dismissed') {
    db.prepare('UPDATE code_findings SET last_seen = ?, seen_count = seen_count + 1 WHERE id = ?')
      .run(now, existing.id);
    return res.json({ id: existing.id, created: false, suppressed: 'dismissed' });
  }

  const regressed = existing.status === 'fixed';
  const worse = SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(existing.severity);
  db.prepare(`
    UPDATE code_findings SET
      last_seen = ?, seen_count = seen_count + 1,
      severity = ?, status = ?, resolved_at = ?,
      evidence = COALESCE(?, evidence), suggested_fix = COALESCE(?, suggested_fix),
      line = COALESCE(?, line), job_id = COALESCE(?, job_id)
    WHERE id = ?
  `).run(now, worse ? severity : existing.severity,
    regressed ? 'open' : existing.status, regressed ? null : existing.resolved_at,
    f.evidence || null, f.suggested_fix || null,
    Number.isFinite(f.line) ? f.line : null, f.job_id || null, existing.id);

  res.json({ id: existing.id, created: false, regressed, escalated: worse });
});

// GET /memory/findings?platform=&status=&severity=&kind=&limit=
app.get('/memory/findings', (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 500);
  const where = [];
  const vals = [];
  for (const col of ['platform', 'status', 'severity', 'kind']) {
    if (req.query[col]) { where.push(`${col} = ?`); vals.push(req.query[col]); }
  }
  if (req.query.open_only) where.push("status IN ('open','confirmed')");
  const rows = db.prepare(`
    SELECT * FROM code_findings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             last_seen DESC
    LIMIT ?
  `).all(...vals, limit);
  res.json(rows);
});

// GET /memory/findings/summary — what the deck and the brain ask for
app.get('/memory/findings/summary', (req, res) => {
  const rows = db.prepare(`
    SELECT platform, severity, status, COUNT(*) AS n
    FROM code_findings GROUP BY platform, severity, status
  `).all();
  const openBySeverity = db.prepare(`
    SELECT severity, COUNT(*) AS n FROM code_findings
    WHERE status IN ('open','confirmed') GROUP BY severity
  `).all();
  res.json({ rows, openBySeverity });
});

// ── The intelligent flywheel: harvested sessions + lessons ─────────────────
//
// The harvester (src/session-harvester.js) indexes CLI transcripts and files
// distilled lessons; session-start.sh and the brain read them back. The server
// computes the lesson fingerprint the same way it computes finding
// fingerprints — identity fields stay inside the table's control.

// POST /memory/harvest/session — upsert a harvested session by source_id.
// UPSERT touching only harvest-owned columns (the platform_state lesson):
// distill_status/distilled_at survive a re-harvest of a grown file, except
// that a GROWN session gets re-distilled (more happened since we read it).
app.post('/memory/harvest/session', (req, res) => {
  const s = req.body || {};
  if (!s.source_id || !s.raw_path) {
    return res.status(400).json({ error: 'source_id and raw_path required' });
  }
  const now = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO coding_sessions
      (source_id, machine, platform, cwd, started_at, ended_at, user_turns,
       assistant_turns, tool_calls, files_touched, outcome, raw_path,
       harvested_at, distill_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id) DO UPDATE SET
      platform = excluded.platform, cwd = excluded.cwd,
      started_at = excluded.started_at, ended_at = excluded.ended_at,
      user_turns = excluded.user_turns, assistant_turns = excluded.assistant_turns,
      tool_calls = excluded.tool_calls, files_touched = excluded.files_touched,
      outcome = excluded.outcome, harvested_at = excluded.harvested_at,
      distill_status = CASE WHEN coding_sessions.tool_calls <> excluded.tool_calls
                            THEN excluded.distill_status
                            ELSE coding_sessions.distill_status END
  `).run(s.source_id, s.machine || 'vultr', s.platform || null, s.cwd || null,
    s.started_at || null, s.ended_at || null, s.user_turns | 0,
    s.assistant_turns | 0, s.tool_calls | 0,
    JSON.stringify(s.files_touched || []), s.outcome || null, s.raw_path,
    now, s.distill_status || 'pending');
  const row = db.prepare('SELECT id, distill_status FROM coding_sessions WHERE source_id = ?').get(s.source_id);
  res.json({ id: row.id, distill_status: row.distill_status, changes: r.changes });
});

// GET /memory/harvest/pending?limit= — sessions awaiting distillation.
// Newest session FIRST (by ended_at): current knowledge is worth more than a
// month-old backlog session, and while burning the backlog (2026-08-08) this
// means the most relevant lessons land first. Falls back to harvested_at for
// rows with no ended_at.
app.get('/memory/harvest/pending', (req, res) => {
  const limit = clampLimit(req.query.limit, 5, 25);
  res.json(db.prepare(`
    SELECT * FROM coding_sessions WHERE distill_status = 'pending'
    ORDER BY COALESCE(ended_at, harvested_at) DESC LIMIT ?
  `).all(limit));
});

// POST /memory/harvest/distilled — record a distillation's outcome + lessons
app.post('/memory/harvest/distilled', (req, res) => {
  const { session_id, status, lessons } = req.body || {};
  const sess = db.prepare('SELECT * FROM coding_sessions WHERE id = ?').get(session_id);
  if (!sess) return res.status(404).json({ error: 'no such session' });
  const ok = ['done', 'skipped', 'failed'].includes(status) ? status : 'failed';
  const now = new Date().toISOString();
  db.prepare('UPDATE coding_sessions SET distill_status = ?, distilled_at = ? WHERE id = ?')
    .run(ok, now, session_id);

  const filed = [];
  for (const raw of Array.isArray(lessons) ? lessons.slice(0, 5) : []) {
    const l = normalizeLesson(raw, raw.platform || sess.platform);
    if (!l) continue;
    const fp = lessonFingerprint(l);
    const existing = db.prepare('SELECT id, status FROM lessons WHERE fingerprint = ?').get(fp);
    if (existing) {
      // A retired lesson stays retired (the dismissed-findings rule): retiring
      // is a human/officer judgement and re-learning must not undo it.
      db.prepare('UPDATE lessons SET seen_count = seen_count + 1, last_seen = ? WHERE id = ?')
        .run(now, existing.id);
      filed.push({ id: existing.id, created: false });
    } else {
      const r = db.prepare(`
        INSERT INTO lessons (fingerprint, session_id, platform, kind, lesson,
                             evidence, confidence, created_at, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fp, session_id, l.platform, l.kind, l.lesson, l.evidence || null,
        l.confidence, now, now);
      db.prepare("INSERT INTO marco_fts (kind, ref_id, text) VALUES ('lesson', ?, ?)")
        .run(String(r.lastInsertRowid), `${l.platform} ${l.kind} ${l.lesson} ${l.evidence || ''}`);
      filed.push({ id: r.lastInsertRowid, created: true });
    }
  }
  res.json({ session_id, distill_status: ok, lessons: filed });
});

// GET /memory/lessons?platform=&limit=&all= — what future sessions inject.
// Ordered by how often the lesson has recurred, then recency: a lesson three
// sessions independently learned outranks one heard once.
app.get('/memory/lessons', (req, res) => {
  const limit = clampLimit(req.query.limit, 10, 100);
  const where = ["status = 'active'"];
  const vals = [];
  if (req.query.platform) { where.push('platform = ?'); vals.push(String(req.query.platform).toLowerCase()); }
  const rows = db.prepare(`
    SELECT * FROM lessons WHERE ${where.join(' AND ')}
    ORDER BY seen_count DESC, last_seen DESC LIMIT ?
  `).all(...vals, limit);
  res.json(rows);
});

// PATCH /memory/lessons/:id — retire (or reactivate) a lesson that aged out
app.patch('/memory/lessons/:id', (req, res) => {
  const status = ['active', 'retired'].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: "status must be 'active' or 'retired'" });
  const r = db.prepare('UPDATE lessons SET status = ? WHERE id = ?').run(status, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'no such lesson' });
  res.json({ id: Number(req.params.id), status });
});

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
  if (marcoEnv().mode === 'off') return { status: 503, body: { error: 'MARCO_MODE=off' } };
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

// POST /marco/lesson — the curator's write path (Task 6 fix round 1). The
// harvest/distilled route is transcript-bound (needs a coding_sessions row);
// curator lessons come from events, so they file here. Same fingerprint
// dedup contract: re-filing a known lesson bumps seen_count, never duplicates.
app.post('/marco/lesson', (req, res) => {
  if (marcoEnv().mode === 'off') return res.status(503).json({ error: 'MARCO_MODE=off' });
  const platform = String(req.body?.platform || 'all').toLowerCase();
  const norm = normalizeLesson(req.body, platform);
  if (!norm) return res.status(400).json({ error: 'lesson text required' });
  const fp = lessonFingerprint(norm);
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM lessons WHERE fingerprint = ?').get(fp);
  if (existing) {
    db.prepare('UPDATE lessons SET seen_count = seen_count + 1, last_seen = ? WHERE id = ?').run(now, existing.id);
    return res.json({ id: existing.id, deduped: true });
  }
  const source = String(req.body?.source_event_ids || '').slice(0, 500);
  const info = db.prepare(`INSERT INTO lessons (fingerprint, session_id, platform, kind, lesson, evidence, confidence, status, seen_count, created_at, last_seen, source_event_ids, author)
    VALUES (?, NULL, ?, ?, ?, ?, 'medium', 'active', 1, ?, ?, ?, 'curator')`)
    .run(fp, norm.platform, norm.kind, norm.lesson, norm.evidence || '', now, now, source);
  db.prepare("INSERT INTO marco_fts (kind, ref_id, text) VALUES ('lesson', ?, ?)")
    .run(String(info.lastInsertRowid), `${norm.platform} ${norm.kind} ${norm.lesson} ${norm.evidence || ''}`);
  res.json({ id: info.lastInsertRowid });
});

// ── Governance: proposals (docs/GOVERNANCE.md) ──────────────────────────────
//
// The gate is enforced HERE, server-side, not in the callers. Every caller is
// an agent, and an agent that can talk itself past a control is not gated by
// it. canTransition() is the single authority; this endpoint refuses anything
// it refuses, and records every accepted move in the append-only trail.

// POST /memory/proposals — an agent proposes a change it has NOT made
app.post('/memory/proposals', (req, res) => {
  const p = req.body || {};
  const v = validateProposal(p);
  if (!v.valid) return res.status(400).json({ error: 'incomplete proposal', missing: v.missing });
  const now = new Date().toISOString();
  const r = db.prepare(`
    INSERT INTO proposals
      (domain, platform, change_class, risk, title, rationale, evidence,
       artifact_url, artifact_kind, finding_id, job_id, status, created_by, created_at, updated_at)
    VALUES (@domain, @platform, @change_class, @risk, @title, @rationale, @evidence,
       @artifact_url, @artifact_kind, @finding_id, @job_id, 'proposed', @created_by, @now, @now)
  `).run({
    domain: p.domain, platform: p.platform ?? null, change_class: p.change_class,
    risk: p.risk, title: p.title, rationale: p.rationale, evidence: p.evidence,
    artifact_url: p.artifact_url ?? null, artifact_kind: p.artifact_kind ?? null,
    finding_id: p.finding_id ?? null, job_id: p.job_id ?? null,
    created_by: p.created_by, now,
  });
  db.prepare(`INSERT INTO proposal_audit (proposal_id, from_status, to_status, actor_id, actor_kind, notes, at)
              VALUES (?, NULL, 'proposed', ?, ?, ?, ?)`)
    .run(r.lastInsertRowid, p.created_by, 'agent', p.notes || null, now);
  res.json({ ok: true, id: r.lastInsertRowid, status: 'proposed' });
});

// GET /memory/proposals?status=&domain=&awaiting_human=1
app.get('/memory/proposals', (req, res) => {
  const limit = clampLimit(req.query.limit, 50, 500);
  const where = [];
  const vals = [];
  for (const col of ['status', 'domain', 'platform', 'created_by']) {
    if (req.query[col]) { where.push(`${col} = ?`); vals.push(req.query[col]); }
  }
  if (req.query.awaiting_human) where.push("status = 'escalated'");
  if (req.query.open_only) where.push("status IN ('proposed','under_review','escalated','approved')");
  const rows = db.prepare(`
    SELECT * FROM proposals ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC LIMIT ?
  `).all(...vals, limit);
  res.json(rows);
});

// GET /memory/proposals/:id — the proposal plus its full trail
app.get('/memory/proposals/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'proposal not found' });
  const trail = db.prepare('SELECT * FROM proposal_audit WHERE proposal_id = ? ORDER BY id').all(req.params.id);
  res.json({ ...row, audit: trail, decision: describeDecision(row) });
});

// POST /memory/proposals/:id/transition {to, actor_id, actor_kind, notes}
//
// The ONE way a proposal changes state. Deliberately not a PATCH of arbitrary
// columns: `status` must never be settable directly, or the gate becomes
// advisory. A refusal returns 409 with the reason, so the caller learns WHY
// rather than retrying blindly.
app.post('/memory/proposals/:id/transition', internalGuard, (req, res) => {
  const { to, actor_id, actor_kind = 'agent', notes } = req.body || {};
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'proposal not found' });

  const actor = { id: actor_id, kind: actor_kind };
  const check = canTransition(row, to, actor);
  if (!check.allowed) return res.status(409).json({ error: 'transition refused', reason: check.reason });

  const now = new Date().toISOString();
  const isDecision = ['approved', 'rejected', 'escalated'].includes(to);
  db.prepare(`
    UPDATE proposals SET
      status = ?,
      reviewed_by  = CASE WHEN ? THEN ? ELSE reviewed_by END,
      reviewed_at  = CASE WHEN ? THEN ? ELSE reviewed_at END,
      review_notes = COALESCE(?, review_notes),
      executed_at  = CASE WHEN ? = 'executed' THEN ? ELSE executed_at END,
      updated_at = ?
    WHERE id = ?
  `).run(to, isDecision ? 1 : 0, actor_id, isDecision ? 1 : 0, now, notes || null, to, now, now, row.id);

  db.prepare(`INSERT INTO proposal_audit (proposal_id, from_status, to_status, actor_id, actor_kind, notes, at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.status, to, actor_id, actor_kind, notes || null, now);

  const after = db.prepare('SELECT * FROM proposals WHERE id = ?').get(row.id);
  res.json({ ok: true, id: row.id, status: to, decision: describeDecision(after) });
});

// POST /memory/proposals/:id/artifact {artifact_url, artifact_kind}
//
// The agent attaches what it produced — a pushed branch and its compare URL.
// Separate from /transition on purpose: attaching evidence is not a state
// change and must not require (or imply) a decision. Only allowed while the
// proposal is still awaiting one, so an artifact cannot be swapped underneath
// an approval that was granted against a different diff.
app.post('/memory/proposals/:id/artifact', (req, res) => {
  const { artifact_url, artifact_kind = 'branch' } = req.body || {};
  if (!artifact_url) return res.status(400).json({ error: 'artifact_url required' });
  const row = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'proposal not found' });
  if (!['proposed', 'under_review'].includes(row.status)) {
    return res.status(409).json({ error: `cannot attach an artifact to a ${row.status} proposal` });
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE proposals SET artifact_url = ?, artifact_kind = ?, updated_at = ? WHERE id = ?')
    .run(artifact_url, artifact_kind, now, row.id);
  db.prepare(`INSERT INTO proposal_audit (proposal_id, from_status, to_status, actor_id, actor_kind, notes, at)
              VALUES (?, ?, ?, ?, 'agent', ?, ?)`)
    .run(row.id, row.status, row.status, req.body.actor_id || row.created_by, `artifact attached: ${artifact_url}`, now);
  res.json({ ok: true, id: row.id, artifact_url });
});

// GET /memory/proposals-summary — counts for the deck
app.get('/memory/proposals-summary', (req, res) => {
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM proposals GROUP BY status').all();
  const byDomain = db.prepare(`SELECT domain, COUNT(*) AS n FROM proposals
                               WHERE status IN ('proposed','under_review','escalated') GROUP BY domain`).all();
  res.json({ byStatus, byDomain });
});

// POST /memory/findings/:id/reattribute {platform, file_path}
//
// A finding filed against the wrong platform (2026-08-05). code-health swept
// universal-ai-operator, walked into `target_code/zoobicon` — that CrewAI
// engine's working copy of the FLAGSHIP — and filed nine of Zoobicon's
// criticals under the operator's name, with a `target_code/zoobicon/` path
// prefix. Attributed there they were unfixable: the operator has no git remote,
// so every auto-fix path correctly refused them.
//
// This is a correction, not an edit: the defect and its verification stand, only
// the label was wrong. The fingerprint MUST be recomputed because it keys on
// `platform:file:title` (lib/findings.js) — leave it stale and the next sweep of
// the correct platform files a duplicate of a finding already in the table.
// A collision means the correct row already exists, so this reports rather than
// clobbering it: UNIQUE on fingerprint would throw, and a 409 is the honest answer.
app.post('/memory/findings/:id/reattribute', internalGuard, (req, res) => {
  const { platform, file_path } = req.body || {};
  if (!platform && !file_path) return res.status(400).json({ error: 'platform and/or file_path required' });
  const row = db.prepare('SELECT * FROM code_findings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'finding not found' });

  const nextPlatform = platform || row.platform;
  const nextPath     = file_path || row.file_path;
  const nextFp       = fingerprint(nextPlatform, nextPath, row.title);

  const clash = db.prepare('SELECT id FROM code_findings WHERE fingerprint = ? AND id != ?').get(nextFp, row.id);
  if (clash) {
    return res.status(409).json({ error: 'a finding with that identity already exists', existing_id: clash.id });
  }
  db.prepare('UPDATE code_findings SET platform = ?, file_path = ?, fingerprint = ? WHERE id = ?')
    .run(nextPlatform, nextPath, nextFp, row.id);
  res.json({ ok: true, id: row.id, platform: nextPlatform, file_path: nextPath, fingerprint: nextFp });
});

// PATCH /memory/findings/:id — a verifier's verdict, or a fix landing
app.patch('/memory/findings/:id', internalGuard, (req, res) => {
  const { status, verdict, fix_job_id, severity, checked } = req.body || {};
  if (status && !FINDING_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${FINDING_STATUSES.join('|')}` });
  }
  const now = new Date().toISOString();
  const resolved = status === 'fixed' || status === 'dismissed' ? now : null;
  const r = db.prepare(`
    UPDATE code_findings SET
      status = COALESCE(?, status),
      verdict = COALESCE(?, verdict),
      fix_job_id = COALESCE(?, fix_job_id),
      severity = COALESCE(?, severity),
      last_checked = COALESCE(?, last_checked),
      resolved_at = CASE WHEN ? IS NOT NULL THEN ? ELSE resolved_at END
    WHERE id = ?
  `).run(status || null, verdict || null, fix_job_id || null,
    SEVERITIES.includes(severity) ? severity : null,
    checked ? now : null, resolved, resolved, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'finding not found' });
  res.json({ ok: true });
});

// ── agent_context key/value API (canary gate state, etc.) ──────────────────

// GET /memory/kv/:key
app.get('/memory/kv/:key', (req, res) => {
  const row = db.prepare('SELECT * FROM agent_context WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'key not found' });
  res.json(row);
});

// POST /memory/kv — { key, value }
app.post('/memory/kv', (req, res) => {
  const { key, value } = req.body || {};
  if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
  db.prepare(`
    INSERT INTO agent_context (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), new Date().toISOString());
  res.json({ ok: true, key });
});

// GET /memory/summary — human-readable summary for Slack
app.get('/memory/summary', (req, res) => {
  const platforms = db.prepare('SELECT * FROM platform_state ORDER BY health_score ASC').all();
  const openCount = db.prepare('SELECT COUNT(*) as c FROM repair_log WHERE fix_verified = 0').get().c;
  const lastSession = db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1').get();

  res.json({
    platforms: platforms.map(p => ({
      name: p.platform,
      status: p.status,
      health_score: p.health_score,
      last_audit: p.last_audit,
      notes: p.notes
    })),
    open_issues: openCount,
    last_session: lastSession || null
  });
});

// POST /memory/query — natural language query over the memory database
app.post('/memory/query', (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  const q = question.toLowerCase();

  // Extract platform name from question — from the registry, plus 'jarvis'
  // (this box; not a registry product entry). One source, no drift (move 21).
  const KNOWN_PLATFORMS = [...registryPlatforms(), 'jarvis'];
  const platform = KNOWN_PLATFORMS.find(p => q.includes(p)) || null;

  // Extract time window
  let sinceDate = null;
  if (/\btoday\b/.test(q)) {
    sinceDate = new Date(); sinceDate.setHours(0, 0, 0, 0);
  } else if (/\bthis week\b|\brecently\b|\blatest\b/.test(q)) {
    sinceDate = new Date(Date.now() - 7 * 86400_000);
  } else if (/\bthis month\b/.test(q)) {
    sinceDate = new Date(Date.now() - 30 * 86400_000);
  }
  const sinceSql = sinceDate ? sinceDate.toISOString() : null;

  // Route by question intent
  const isIssues   = /\bbroke?\b|\bissue|\berror|\bfail|\bwrong|\bproblem/.test(q);
  const isFixes    = /\bfix(es|ed)?\b|\brepair|\bsolv|\bresol/.test(q);
  const isSessions = /\bhappened\b|\bdid\b|\bsession|\bwork(ed)?\b|\bshipped/.test(q);
  const isHealth   = /\bhealth\b|\bscore\b|\bstatus\b|\brank/.test(q);
  const isMost     = /\bmost\b|\bworst\b|\bbest\b/.test(q);

  try {
    // "which platform has the most issues"
    if (isMost && isIssues) {
      const rows = db.prepare(`
        SELECT platform, COUNT(*) as count FROM repair_log
        WHERE fix_verified = 0
        GROUP BY platform ORDER BY count DESC LIMIT 5
      `).all();
      if (!rows.length) return res.json({ answer: 'No open issues recorded for any platform.' });
      const lines = rows.map(r => `• *${r.platform}*: ${r.count} open issue(s)`).join('\n');
      return res.json({ answer: `*Platforms by open issue count:*\n${lines}` });
    }

    // Issues / what broke
    if (isIssues && !isFixes) {
      let stmt = platform
        ? `SELECT * FROM repair_log WHERE platform = ? ${sinceSql ? "AND attempted_at >= '" + sinceSql + "'" : ''} ORDER BY attempted_at DESC LIMIT 10`
        : `SELECT * FROM repair_log WHERE fix_verified = 0 ORDER BY attempted_at DESC LIMIT 10`;
      const rows = platform
        ? db.prepare(stmt).all(platform)
        : db.prepare(stmt).all();

      if (!rows.length) return res.json({ answer: `No issues found${platform ? ` for ${platform}` : ''}.` });
      const lines = rows.map(r =>
        `• [${r.attempted_at?.slice(0, 10)}] *${r.platform}* — \`${r.file_path}\`: ${String(r.issue).slice(0, 100)}`
      ).join('\n');
      return res.json({ answer: `*Issues${platform ? ' for ' + platform : ''}:*\n${lines}` });
    }

    // Fixes tried
    if (isFixes) {
      let rows;
      if (platform && sinceSql) {
        rows = db.prepare(`SELECT * FROM repair_log WHERE platform = ? AND attempted_at >= ? ORDER BY attempted_at DESC LIMIT 10`).all(platform, sinceSql);
      } else if (platform) {
        rows = db.prepare(`SELECT * FROM repair_log WHERE platform = ? ORDER BY attempted_at DESC LIMIT 10`).all(platform);
      } else {
        rows = db.prepare(`SELECT * FROM repair_log ORDER BY attempted_at DESC LIMIT 10`).all();
      }
      if (!rows.length) return res.json({ answer: `No fixes recorded${platform ? ` for ${platform}` : ''}.` });
      const lines = rows.map(r => {
        const status = r.fix_verified ? '✅' : '🔄';
        return `${status} [${r.attempted_at?.slice(0, 10)}] *${r.platform}*: ${String(r.fix_applied || r.issue).slice(0, 100)}`;
      }).join('\n');
      return res.json({ answer: `*Fixes${platform ? ' for ' + platform : ''}:*\n${lines}` });
    }

    // Sessions / what happened
    if (isSessions) {
      const rows = platform
        ? db.prepare(`SELECT * FROM sessions WHERE platform = ? ORDER BY started_at DESC LIMIT 5`).all(platform)
        : db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 5`).all();
      if (!rows.length) return res.json({ answer: `No sessions found${platform ? ` for ${platform}` : ''}.` });
      const lines = rows.map(r =>
        `• [${r.started_at?.slice(0, 10)}] *${r.platform}*: ${String(r.summary || r.objective || 'no summary').slice(0, 120)}`
      ).join('\n');
      return res.json({ answer: `*Recent sessions${platform ? ' for ' + platform : ''}:*\n${lines}` });
    }

    // Health / status
    if (isHealth) {
      const rows = platform
        ? db.prepare(`SELECT * FROM platform_state WHERE platform = ?`).all(platform)
        : db.prepare(`SELECT * FROM platform_state ORDER BY health_score DESC`).all();
      if (!rows.length) return res.json({ answer: `No health data${platform ? ` for ${platform}` : ''}.` });
      const lines = rows.map(r => {
        const e = r.health_score > 80 ? '✅' : r.health_score > 50 ? '⚠️' : '🔴';
        return `${e} *${r.platform}*: ${r.status} (${r.health_score}/100)${r.notes ? ' — ' + String(r.notes).slice(0, 80) : ''}`;
      }).join('\n');
      return res.json({ answer: `*Platform health:*\n${lines}` });
    }

    // Fallback — recent activity for the platform (or all)
    if (platform) {
      const state = db.prepare(`SELECT * FROM platform_state WHERE platform = ?`).get(platform);
      const sessions = db.prepare(`SELECT * FROM sessions WHERE platform = ? ORDER BY started_at DESC LIMIT 3`).all(platform);
      const issues = db.prepare(`SELECT COUNT(*) as c FROM repair_log WHERE platform = ? AND fix_verified = 0`).get(platform);
      let answer = `*${platform}* summary:\n`;
      if (state) answer += `Status: ${state.status} (score ${state.health_score}/100)\n`;
      answer += `Open issues: ${issues?.c ?? 0}\n`;
      if (sessions.length) {
        answer += `Recent sessions:\n` + sessions.map(s =>
          `• [${s.started_at?.slice(0, 10)}] ${String(s.summary || s.objective || '—').slice(0, 100)}`
        ).join('\n');
      }
      return res.json({ answer });
    }

    return res.json({ answer: 'I can answer questions about: issues, fixes, sessions, or platform health. Try "what broke on vapron this week" or "which platform has the most issues".' });

  } catch (e) {
    console.error('[memory/query] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

const PORT = 9200;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-memory] Running on http://127.0.0.1:${PORT}`);
  try { writeFileSync('/opt/jarvis/logs/memory.pid', String(process.pid)); } catch {}
});

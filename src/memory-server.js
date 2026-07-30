import Database from 'better-sqlite3';
import express from 'express';
import { writeFileSync, mkdirSync } from 'fs';

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
try { db.exec('ALTER TABLE code_findings ADD COLUMN commit_sha TEXT'); } catch { /* already present */ }
// When a finding was last RE-CHECKED against current code (2026-07-30). Without
// this the table only ever grows: nothing marked anything `fixed`, so a confirmed
// finding stayed confirmed after it was repaired and get_code_findings would keep
// reciting repaired bugs — the same firehose failure this design fights, one
// level up. Re-check candidates are ordered by COALESCE(last_checked, first_seen).
try { db.exec('ALTER TABLE code_findings ADD COLUMN last_checked TEXT'); } catch { /* already present */ }

const PLATFORMS = ['zoobicon', 'vapron', 'alecrae', 'marcoreid', 'gatetest', 'esim'];
PLATFORMS.forEach(p => {
  db.prepare(`
    INSERT OR IGNORE INTO platform_state (platform, status, updated_at)
    VALUES (?, 'unknown', ?)
  `).run(p, new Date().toISOString());
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
  db.prepare(`
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
  const existing = db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(platform);
  const keep = (v, fallback) => (v === undefined || v === null ? fallback : v);
  db.prepare(`
    INSERT OR REPLACE INTO platform_state
    (platform, status, last_known_errors, last_audit, last_screenshot, health_score, consecutive_critical, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform,
    keep(status, existing?.status ?? 'unknown'),
    last_known_errors === undefined || last_known_errors === null
      ? (existing?.last_known_errors ?? '[]')
      : JSON.stringify(last_known_errors),
    existing?.last_audit ?? null,
    existing?.last_screenshot ?? null,
    keep(health_score, existing?.health_score ?? 0),
    existing?.consecutive_critical ?? 0,
    keep(notes, existing?.notes ?? null),
    new Date().toISOString()
  );
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
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
  res.json({ id: result.lastInsertRowid });
});

// GET /memory/agent-reports?agent=&status=&since=&unrouted=1&limit=
app.get('/memory/agent-reports', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
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
app.post('/memory/findings', (req, res) => {
  const f = req.body || {};
  if (!f.fingerprint || !f.platform || !f.title) {
    return res.status(400).json({ error: 'fingerprint, platform and title required' });
  }
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
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 500);
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

// PATCH /memory/findings/:id — a verifier's verdict, or a fix landing
app.patch('/memory/findings/:id', (req, res) => {
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

  // Extract platform name from question
  const KNOWN_PLATFORMS = ['zoobicon', 'vapron', 'alecrae', 'gatetest', 'voxlen', 'bookaride', 'jarvis'];
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
      const params = platform
        ? { platform, since: sinceSql }
        : { since: sinceSql };
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

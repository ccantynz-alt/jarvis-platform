import Database from 'better-sqlite3';
import express from 'express';
import { writeFileSync, mkdirSync } from 'fs';

mkdirSync('/opt/jarvis/memory', { recursive: true });
mkdirSync('/opt/jarvis/logs', { recursive: true });

const db = new Database('/opt/jarvis/memory/jarvis.db');
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
`);

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

// POST /memory/platform/update
app.post('/memory/platform/update', (req, res) => {
  const { platform, status, last_known_errors, health_score, notes } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform required' });
  db.prepare(`
    INSERT OR REPLACE INTO platform_state
    (platform, status, last_known_errors, health_score, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    platform,
    status || 'unknown',
    JSON.stringify(last_known_errors || []),
    health_score || 0,
    notes || null,
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
      last_audit: p.last_audit
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

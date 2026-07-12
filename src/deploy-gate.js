/**
 * Jarvis Deploy Gate — src/deploy-gate.js
 *
 * Wires GateTest into Jarvis so a platform deploy gets scanned before
 * anyone assumes it's actually live and healthy.
 *
 * "New deployment" detection: Jarvis has no separate deploy-event bus —
 * a platform going live IS "a Claude Code session for that platform
 * ended with files_changed non-empty" (per session-start.sh /
 * session-end.sh, the same lifecycle this very session used). This
 * service polls the `sessions` table in the Jarvis memory service's own
 * sqlite DB (jarvis.db) for newly-ended sessions and treats each one
 * with real file changes as a deploy signal for that platform.
 *
 * For each: runs a real GateTest scan (the CLI, `--suite web`) against
 * the platform's live URL, and:
 *   - critical (gate-blocking) findings → writes platform_state
 *     status=deploy-gate-blocked via the memory service, posts a loud
 *     Slack alert with the diff to #javis-cclabs.
 *   - clean → writes status=deploy-gate-passed, no alert (avoid noise —
 *     Bible's "painkiller, not bottleneck" philosophy).
 *
 * HONEST LIMITATION: this does NOT have a technical hook to stop
 * traffic from reaching a bad deploy (no reverse proxy / DNS control
 * from this box) — "blocks the deploy" here means the SAME advisory
 * posture the Bible already establishes for the local pre-push hook:
 * loud, immediate, hard-to-miss (#javis-cclabs alert + platform_state
 * flip visible in every future session-start.sh) but not a hard stop.
 * A real hard stop needs the GitHub Actions deployGate
 * (integrations/github-actions/gatetest-deploy-gate.yml, shipped
 * 2026-07-01) wired as a required status check on each platform's repo
 * — that's the actual enforcement layer; this is the fast, always-on
 * safety net for platforms that don't have it wired yet.
 */

import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(text) {
  return String(text || '').replace(ANSI_RE, '');
}
import Database from 'better-sqlite3';

const PORT = 9207;
const POLL_INTERVAL_MS = 60_000;
const SCAN_TIMEOUT_MS = 180_000;
const GATETEST_PATH = process.env.GATETEST_PATH || '/opt/gatetest';
const MEMORY_SVC = 'http://127.0.0.1:9200';
const SLACK_SVC = 'http://127.0.0.1:9203';

// Same platform → live-URL map orchestrator.js's cronDailyScreenshots
// already uses — single source of truth would need a shared config file,
// tracked as a known small duplication (both are ~6-line literals) rather
// than a bigger refactor of an already-running service for this session.
const PLATFORM_URLS = {
  zoobicon:  'https://zoobicon.com',
  vapron:    'https://vapron.ai',
  alecrae:   'https://alecrae.com',
  gatetest:  'https://gatetest.ai',
  voxlen:    'https://voxlen.com',
  bookaride: 'https://bookaride.com',
};

mkdirSync('/opt/jarvis/memory', { recursive: true });
mkdirSync('/opt/jarvis/logs', { recursive: true });
mkdirSync('/opt/jarvis/deploy-gate-workspace', { recursive: true });

const db = new Database('/opt/jarvis/memory/jarvis.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS deploy_gate_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    url TEXT,
    status TEXT NOT NULL,
    critical_count INTEGER DEFAULT 0,
    summary TEXT,
    ran_at TEXT NOT NULL
  );
`);

function logEvent(category, message) {
  const line = `[${new Date().toISOString()}] [${category}] ${message}\n`;
  try { writeFileSync('/opt/jarvis/logs/deploy-gate.log', line, { flag: 'a' }); } catch { /* logging must never crash the loop */ }
  console.log(line.trim());
}

async function slackSend(text, level = 'warning', key = null) {
  try {
    await fetch(`${SLACK_SVC}/slack/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, level, key }),
    });
  } catch (e) {
    logEvent('SLACK_FAIL', e.message);
  }
}

async function updatePlatformState(platform, status, healthScore, lastKnownErrors, notes) {
  try {
    await fetch(`${MEMORY_SVC}/memory/platform/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, status, health_score: healthScore, last_known_errors: lastKnownErrors, notes }),
    });
  } catch (e) {
    logEvent('MEMORY_UPDATE_FAIL', e.message);
  }
}

function lastProcessedSessionId() {
  const row = db.prepare('SELECT MAX(session_id) as maxId FROM deploy_gate_runs').get();
  return row?.maxId || 0;
}

function newlyEndedSessions(afterId) {
  return db.prepare(`
    SELECT * FROM sessions
    WHERE ended_at IS NOT NULL AND id > ?
    ORDER BY id ASC
  `).all(afterId);
}

function hasRealFileChanges(session) {
  try {
    const changed = JSON.parse(session.files_changed || '[]');
    return Array.isArray(changed) && changed.length > 0;
  } catch {
    return false;
  }
}

/**
 * Runs the real GateTest CLI's `web` suite against a live URL in a
 * scratch workspace, mirroring the SAME config-write pattern
 * gatetest-deploy-gate.yml uses in CI (webUrl/wpUrl/targetUrl — the
 * shared fallback chain every live module already reads).
 */
function runGateTestScan(url) {
  const workspace = mktempWorkspace();
  try {
    mkdirSync(join(workspace, '.gatetest'), { recursive: true });
    writeFileSync(
      join(workspace, '.gatetest', 'config.json'),
      JSON.stringify({ webUrl: url, wpUrl: url, targetUrl: url })
    );

    let exitCode = 0;
    let output = '';
    try {
      output = execSync(
        `node "${GATETEST_PATH}/bin/gatetest.js" --suite web --project "${workspace}"`,
        { encoding: 'utf8', timeout: SCAN_TIMEOUT_MS, stdio: 'pipe' }
      );
    } catch (e) {
      exitCode = typeof e.status === 'number' ? e.status : 1;
      output = (e.stdout || '') + '\n' + (e.stderr || '');
    }

    let report = null;
    try {
      report = JSON.parse(readFileSync(join(workspace, '.gatetest', 'reports', 'gatetest-report-latest.json'), 'utf8'));
    } catch { /* report may not exist if the run crashed before writing one */ }

    const criticalCount = report?.summary?.checks?.errors ?? (exitCode !== 0 ? 1 : 0);
    const failedModuleNames = (report?.failures || []).map((f) => f.module || f.name).filter(Boolean);

    return {
      blocked: exitCode !== 0,
      criticalCount,
      summary: failedModuleNames.length > 0
        ? `${criticalCount} error(s) across: ${failedModuleNames.slice(0, 10).join(', ')}`
        : stripAnsi(output).slice(-1500),
    };
  } finally {
    try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

function mktempWorkspace() {
  return mkdtempSync(join(tmpdir(), 'jarvis-deploy-gate-'));
}

async function processSession(session) {
  const platform = session.platform;
  const url = PLATFORM_URLS[platform];

  if (!hasRealFileChanges(session)) {
    logEvent('SKIP', `session ${session.id} (${platform}) — no files changed, not a deploy`);
    recordRun(session.id, platform, url || null, 'skipped-no-changes', 0, null);
    return;
  }
  if (!url) {
    logEvent('SKIP', `session ${session.id} (${platform}) — no known live URL for this platform`);
    recordRun(session.id, platform, null, 'skipped-no-url', 0, null);
    return;
  }

  logEvent('SCAN', `session ${session.id} (${platform}) deployed — scanning ${url}`);
  let result;
  try {
    result = runGateTestScan(url);
  } catch (e) {
    logEvent('SCAN_FAIL', `session ${session.id} (${platform}): ${e.message}`);
    recordRun(session.id, platform, url, 'scan-failed', 0, e.message);
    return;
  }

  if (result.blocked) {
    recordRun(session.id, platform, url, 'blocked', result.criticalCount, result.summary);
    await updatePlatformState(platform, 'deploy-gate-blocked', 0, [result.summary], `Deploy gate flagged ${result.criticalCount} critical issue(s) after session ${session.id}`);
    await slackSend(
      `🚨 *DEPLOY GATE — ${platform}*\n` +
      `A deploy just went out (session ${session.id}) and GateTest found ${result.criticalCount} critical issue(s) on ${url}.\n` +
      `${result.summary}\n` +
      `_Advisory only — this does not block live traffic. Wire the GitHub Actions deploy gate on this repo for hard enforcement._`,
      'critical',
      `deploy-gate-${platform}`,
    );
  } else {
    recordRun(session.id, platform, url, 'passed', 0, null);
    await updatePlatformState(platform, 'deploy-gate-passed', 100, [], `Deploy gate clean after session ${session.id}`);
    logEvent('PASS', `session ${session.id} (${platform}) — clean`);
  }
}

function recordRun(sessionId, platform, url, status, criticalCount, summary) {
  db.prepare(`
    INSERT INTO deploy_gate_runs (session_id, platform, url, status, critical_count, summary, ran_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(sessionId, platform, url, status, criticalCount, summary, new Date().toISOString());
}

async function pollOnce() {
  const afterId = lastProcessedSessionId();
  const sessions = newlyEndedSessions(afterId);
  if (sessions.length === 0) return;
  logEvent('POLL', `${sessions.length} newly-ended session(s) to evaluate`);
  for (const session of sessions) {
    await processSession(session);
  }
}

let polling = false;
async function pollLoop() {
  if (polling) return; // don't overlap runs if one poll is still mid-scan
  polling = true;
  try {
    await pollOnce();
  } catch (e) {
    logEvent('POLL_FAIL', e.message);
  } finally {
    polling = false;
  }
}

// ── HTTP API ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/deploy-gate/health', (_req, res) => {
  res.json({ status: 'ok', lastProcessedSessionId: lastProcessedSessionId(), polling });
});

app.get('/deploy-gate/history', (req, res) => {
  const platform = req.query.platform;
  const limit = Math.min(100, Number(req.query.limit) || 20);
  const rows = platform
    ? db.prepare('SELECT * FROM deploy_gate_runs WHERE platform = ? ORDER BY id DESC LIMIT ?').all(platform, limit)
    : db.prepare('SELECT * FROM deploy_gate_runs ORDER BY id DESC LIMIT ?').all(limit);
  res.json(rows);
});

// Manual trigger — re-evaluate now instead of waiting for the next poll tick.
app.post('/deploy-gate/run', async (_req, res) => {
  pollLoop();
  res.json({ triggered: true });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-deploy-gate] HTTP API on http://127.0.0.1:${PORT}`);
  logEvent('START', `deploy gate online, polling every ${POLL_INTERVAL_MS / 1000}s`);
  pollLoop();
  setInterval(pollLoop, POLL_INTERVAL_MS);
});

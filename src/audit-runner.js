import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import express from 'express';
import Database from 'better-sqlite3';
import { notify } from './lib/notify.js';

mkdirSync('/opt/jarvis/reports', { recursive: true });

const app = express();
app.use(express.json());
const db = new Database('/opt/jarvis/memory/jarvis.db');
// Additive migration (memory-server.js pattern) — this service writes to the
// SAME platform_state table memory-server.js owns, directly via sqlite, so
// it carries its own migration for the column it needs rather than assuming
// startup order.
try { db.exec('ALTER TABLE platform_state ADD COLUMN consecutive_critical INTEGER DEFAULT 0'); } catch { /* already present */ }

const GATETEST_ADMIN_PASSWORD = process.env.GATETEST_ADMIN_PASSWORD;
const ORCHESTRATOR = 'http://127.0.0.1:9205';
// Self-repair for routine audits (2026-07-22, Craig: "so many audits... still
// doing repairs manually" — audits found real errors and scored them for
// weeks but nothing ever acted on the findings). Same guardrail shape as
// deploy-gate.js's auto-fix: cap consecutive auto-dispatches per platform so
// a genuinely unfixable/flaky audit escalates to a human instead of looping.
const AUTO_FIX_MAX_ATTEMPTS = 2;

const PLATFORM_CONFIG = {
  zoobicon: {
    path: process.env.ZOOBICON_PATH || '/var/www/zoobicon',
    urls: ['https://zoobicon.com', 'https://zoobicon.com/builder'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  // Added 2026-07-22 (Craig: audit the other 8 platforms). Path/tech-stack
  // from config/platforms.json; build/test commands inferred from tech
  // stack (npm for TS/React, bun for the Bun-based stack), matching the
  // pattern already used above — not independently verified against each
  // repo's actual package.json scripts, so if these commands don't exist
  // the audit will just show a build failure the first run, not silently
  // succeed on the wrong thing.
  bookaride: {
    path: process.env.BOOKARIDE_PATH || '/root/bookaride',
    urls: ['https://www.bookaride.co.nz'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  gluecron: {
    path: process.env.GLUECRON_PATH || '/root/gluecron',
    urls: ['https://gluecron.com'],
    buildCmd: 'bun run build',
    testCmd: 'bun test',
    checkCmd: null
  },
  alecrae: {
    path: process.env.ALECRAE_PATH || '/var/www/alecrae',
    urls: ['https://alecrae.com'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  gatetest: {
    path: process.env.GATETEST_PATH || '/opt/gatetest',
    urls: ['https://gatetest.ai'],
    buildCmd: 'node --test tests/*.test.js',
    testCmd: 'node --test tests/*.test.js',
    checkCmd: 'node bin/gatetest.js --list',
    // Extra env vars injected into every command for this platform
    env: GATETEST_ADMIN_PASSWORD ? { GATETEST_ADMIN_PASSWORD } : {},
  },
  // Web portion only (Craig's call, 2026-07-22) — voxlen's tech stack also
  // includes Rust/Tauri (desktop) + Swift (mobile); a full cross-platform
  // build is too slow/complex for a daily automated audit, so this only
  // builds/tests the web/React part. Desktop/mobile builds are NOT covered.
  voxlen: {
    path: process.env.VOXLEN_PATH || '/root/voxlen',
    urls: ['https://voxlen.com'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  // noAutoFix: true (Craig's call, 2026-07-22) — audit for visibility, but
  // never auto-dispatch a fix job for these two:
  //   - universal-ai-operator: no git remote (platforms.json confirms "no
  //     git remote as of 2026-07-06") — a dispatched agent's mandatory
  //     "commit and push" step (buildPrompt() in orchestrator.js) would
  //     have nowhere to push to, wasting the job.
  //   - screenshot-to-code: a third-party fork (abi/screenshot-to-code),
  //     not Craig's own code — auto-committing "fixes" here risks silently
  //     diverging from upstream in a way nobody would notice until an
  //     update conflicts with it.
  'universal-ai-operator': {
    path: process.env.UAO_PATH || '/root/universal-ai-operator',
    urls: [], // no public domain (platforms.json) — screenshots skipped, build/test still run
    buildCmd: 'docker compose build',
    testCmd: null,
    checkCmd: null,
    noAutoFix: true
  },
  'screenshot-to-code': {
    path: process.env.SCREENSHOT_TO_CODE_PATH || '/opt/screenshot-to-code',
    urls: ['http://127.0.0.1:5173', 'http://127.0.0.1:7001'], // loopback-only per platforms.json, no public domain
    buildCmd: 'docker compose build',
    testCmd: null,
    checkCmd: null,
    noAutoFix: true
  },
};

// marcoreid/davenroe (Craig's call, 2026-07-22): Vercel-hosted, no local
// checkout on this box at all (platforms.json path is "") — the normal
// build/test-in-a-local-directory model can't work for them, and dispatch
// can't push a fix for a platform with no local path either. Lighter
// variant: screenshot + live-URL health check only, no build/test, no
// auto-fix-dispatch (there is no local repo to dispatch a fix against).
//
// vapron (moved here 2026-07-23): found chasing Craig's report of Vapron
// flip-flopping between "critical" and "healthy". Root cause: vapron's
// `server` in config/platforms.json is 100.89.227.39 (box 158), NOT this
// box (66.42.121.161) — its code has never existed locally here under any
// path. audit-runner was running `bun run build` against a directory that
// could never exist on THIS box, guaranteed-failing every daily audit and
// tanking the score to critical, while fleet-check's simple HTTP check
// correctly reported healthy 10 minutes later — same structural problem as
// marcoreid/davenroe, just a second Jarvis-controlled box instead of Vercel.
// A real fix would SSH into 158 and build there (Tailscale now supports
// that box-to-box, see today's Tailscale work) — not done here, this just
// stops the false-critical reports.
const URL_ONLY_CONFIG = {
  marcoreid: { urls: ['https://www.marcoreid.com'] },
  davenroe: { urls: ['https://www.davenroe.com'] },
  vapron: { urls: ['https://vapron.ai'] },
};

function runCmd(cmd, cwd, timeoutMs = 120000, extraEnv = {}) {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: 'pipe',
      env: { ...process.env, ...extraEnv },
    });
    return { ok: true, output: output.slice(0, 8000) };
  } catch (e) {
    return {
      ok: false,
      output: ((e.stdout || '') + '\n' + (e.stderr || '')).slice(0, 8000)
    };
  }
}

function extractErrors(output) {
  const errors = [];
  const lines = output.split('\n');
  for (const line of lines) {
    if (
      line.match(/error(\s|:)/i) ||
      line.includes('Error:') ||
      line.includes('error TS') ||
      line.includes('Failed to compile') ||
      line.includes('Cannot find') ||
      line.includes('Module not found') ||
      line.match(/✗|×\s/) ||
      line.includes('FAIL ')
    ) {
      const clean = line.trim();
      if (clean.length > 5 && clean.length < 300) {
        errors.push(clean);
      }
    }
  }
  return [...new Set(errors)].slice(0, 50);
}

function getConsecutiveCritical(platform) {
  const row = db.prepare('SELECT consecutive_critical FROM platform_state WHERE platform = ?').get(platform);
  return row?.consecutive_critical || 0;
}

function getExistingNotes(platform) {
  const row = db.prepare('SELECT notes FROM platform_state WHERE platform = ?').get(platform);
  return row?.notes ?? null;
}

// Is there already a job in flight for this platform? Don't pile a second
// auto-dispatch on top of one still running from a prior audit.
async function hasJobInFlight(platform) {
  try {
    const rows = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json());
    return (Array.isArray(rows) ? rows : []).some(j => j.platform === platform && (j.status === 'running' || j.status === 'queued'));
  } catch {
    return false; // orchestrator unreachable — don't block the audit on this
  }
}

async function dispatchAutoFix(platform, report) {
  const errorList = report.errors.slice(0, 15).join('\n');
  const task = `The daily audit for ${platform} scored ${report.health_score}/100 (${report.status}). ` +
    `Build ${report.build?.ok ? 'passed' : 'FAILED'}${report.tests ? `, tests ${report.tests.ok ? 'passed' : 'FAILED'}` : ''}. ` +
    `Errors found:\n${errorList}\n\nInvestigate and fix these, verify with the project's own build/test commands, then commit and push as usual.`;
  try {
    const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, task, enqueued_by: 'audit-runner-auto-fix' }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || `dispatch ${r.status}`);
    return body.jobId;
  } catch (e) {
    console.error(`[audit] auto-fix dispatch failed for ${platform}: ${e.message}`);
    return null;
  }
}

async function takeScreenshots(platform, urls) {
  const results = [];
  for (const url of urls) {
    try {
      const r = await fetch('http://127.0.0.1:9201/screenshot/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(35000)
      });
      const data = await r.json();
      results.push({ url, ...data });
    } catch (e) {
      results.push({ url, ok: false, error: e.message });
    }
  }
  return results;
}

// Shared write + notify tail for both audit shapes below — same
// platform_state row shape and self-repair notify pattern either way.
function writeAuditState(platform, report) {
  const priorConsecutive = getConsecutiveCritical(platform);
  const newConsecutive = report.status === 'critical' ? priorConsecutive + 1 : 0;
  // Preserve `notes` (2026-07-24 — same INSERT OR REPLACE column-loss bug
  // found in memory-server.js's /memory/platform/update, mirrored here:
  // this write never included `notes`, so every audit run silently wiped
  // whatever fleet-check.sh had last written there — confirmed live
  // earlier today, "notes":null right after a manual audit trigger).
  const existingNotes = getExistingNotes(platform);
  db.prepare(`
    INSERT OR REPLACE INTO platform_state
    (platform, status, last_known_errors, last_audit, last_screenshot, health_score, consecutive_critical, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform, report.status, JSON.stringify(report.errors), new Date().toISOString(),
    report.screenshots.find(s => s.ok)?.filepath || null, report.health_score, newConsecutive, existingNotes, new Date().toISOString()
  );
  return newConsecutive;
}

async function notifyAuditResult(platform, report, newConsecutive, { noAutoFix = false } = {}) {
  if (report.status !== 'critical') return;
  if (noAutoFix) {
    await notify({
      source: 'audit-runner', level: 'warn',
      title: `⚠️ ${platform} audit critical (${report.health_score}/100) — no auto-fix (${noAutoFix === 'no-remote' ? 'no git remote' : noAutoFix === 'url-only' ? 'no local checkout' : 'third-party code'})`,
      body: `Errors: ${report.errors.slice(0, 5).join('; ')}`,
      speech: `Sir, ${platform}'s audit came back critical — this one needs your eyes, I can't auto-fix it.`,
    }).catch(() => {});
    return;
  }
  if (await hasJobInFlight(platform)) {
    console.log(`[audit] ${platform}: critical but a job is already running — not piling on`);
  } else if (newConsecutive <= AUTO_FIX_MAX_ATTEMPTS) {
    const jobId = await dispatchAutoFix(platform, report);
    await notify({
      source: 'audit-runner', level: 'warn',
      title: `🔧 ${platform} audit critical (${report.health_score}/100) — auto-fix ${jobId ? 'dispatched' : 'FAILED to dispatch'}`,
      body: jobId
        ? `Job ${jobId}, attempt ${newConsecutive}/${AUTO_FIX_MAX_ATTEMPTS}. Errors: ${report.errors.slice(0, 5).join('; ')}`
        : `Dispatch failed — this needs a human look. Errors: ${report.errors.slice(0, 5).join('; ')}`,
      speech: jobId ? `Sir, ${platform}'s audit came back critical — I've dispatched a fix.` : `Sir, ${platform}'s audit is critical and I couldn't auto-dispatch a fix — this needs you.`,
    }).catch(() => {});
  } else {
    await notify({
      source: 'audit-runner', level: 'alert',
      title: `🚨 ${platform} — ${AUTO_FIX_MAX_ATTEMPTS} auto-fix attempts still critical, ESCALATED not re-dispatching`,
      body: `Errors: ${report.errors.slice(0, 8).join('; ')}`,
      speech: `Sir, ${platform} has failed ${AUTO_FIX_MAX_ATTEMPTS} auto-fix attempts in a row and still looks critical — I've stopped re-dispatching, this needs your eyes.`,
    }).catch(() => {});
  }
}

// Lighter shape for Vercel-hosted platforms with no local checkout on this
// box (marcoreid, davenroe) — screenshot + live-URL health check only. No
// build/test (nothing local to build), no auto-fix-dispatch (nothing local
// to push a fix from — orchestrator dispatch needs entry.path/isLocal,
// neither of which exists for these).
async function runUrlOnlyAudit(platform, config) {
  const auditId = Date.now();
  const report = { platform, audit_id: auditId, timestamp: new Date().toISOString(), build: null, tests: null, checks: null, screenshots: [], errors: [], health_score: 100 };

  console.log(`[audit] ${platform}: url-only audit (no local checkout) — capturing screenshots...`);
  report.screenshots = await takeScreenshots(platform, config.urls);
  const screenshotsFailed = report.screenshots.filter(s => !s.ok);
  report.errors = screenshotsFailed.map(s => `SCREENSHOT: ${s.url} — ${s.error || 'capture failed'}`);
  report.health_score = Math.max(0, 100 - screenshotsFailed.length * 40);
  report.status = report.health_score > 80 ? 'healthy' : report.health_score > 50 ? 'warning' : 'critical';

  const newConsecutive = writeAuditState(platform, report);
  await notifyAuditResult(platform, report, newConsecutive, { noAutoFix: 'url-only' });

  const reportPath = join('/opt/jarvis/reports', `${platform}-${auditId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[audit] ${platform}: complete (url-only). Score: ${report.health_score}/100`);

  fetch('http://127.0.0.1:9203/slack/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, status: report.status, issues: report.errors, fixed: [], health_score: report.health_score }),
  }).catch(() => {});

  return report;
}

async function runAudit(platform) {
  if (URL_ONLY_CONFIG[platform]) return runUrlOnlyAudit(platform, URL_ONLY_CONFIG[platform]);

  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new Error(`Unknown platform: ${platform}`);

  console.log(`[audit] Starting ${platform} audit at ${new Date().toISOString()}`);

  const auditId = Date.now();
  const report = {
    platform,
    audit_id: auditId,
    timestamp: new Date().toISOString(),
    build: null,
    tests: null,
    checks: null,
    screenshots: [],
    errors: [],
    health_score: 100
  };

  const env = config.env || {};

  // Step 1: Build
  console.log(`[audit] ${platform}: running build...`);
  report.build = runCmd(config.buildCmd, config.path, 180000, env);
  const buildErrors = extractErrors(report.build.output);
  report.errors.push(...buildErrors.map(e => `BUILD: ${e}`));

  // Step 2: Tests
  if (config.testCmd) {
    console.log(`[audit] ${platform}: running tests...`);
    report.tests = runCmd(config.testCmd, config.path, 120000, env);
    const testErrors = extractErrors(report.tests.output);
    report.errors.push(...testErrors.map(e => `TEST: ${e}`));
  }

  // Step 3: Extra checks
  if (config.checkCmd) {
    console.log(`[audit] ${platform}: running checks...`);
    report.checks = runCmd(config.checkCmd, config.path, 60000, env);
    const checkErrors = extractErrors(report.checks.output);
    report.errors.push(...checkErrors.map(e => `CHECK: ${e}`));
  }

  // Step 4: Screenshots
  console.log(`[audit] ${platform}: capturing screenshots...`);
  report.screenshots = await takeScreenshots(platform, config.urls);

  // Step 5: Score
  const errorCount = report.errors.length;
  const screenshotsFailed = report.screenshots.filter(s => !s.ok).length;
  report.health_score = Math.max(0,
    100
    - (errorCount * 8)
    - (screenshotsFailed * 5)
    - (report.build.ok ? 0 : 20)
    - (report.tests && !report.tests.ok ? 10 : 0)
  );
  report.status = report.health_score > 80 ? 'healthy' : report.health_score > 50 ? 'warning' : 'critical';

  // Step 6: Write to memory + self-repair notify (shared with runUrlOnlyAudit
  // above — consecutive_critical is read BEFORE the write since INSERT OR
  // REPLACE deletes+reinserts the row, so any column left out would reset).
  const newConsecutive = writeAuditState(platform, report);
  await notifyAuditResult(platform, report, newConsecutive, { noAutoFix: config.noAutoFix });

  // Step 7: Save report to disk
  const reportPath = join('/opt/jarvis/reports', `${platform}-${auditId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[audit] ${platform}: complete. Score: ${report.health_score}/100 | Errors: ${report.errors.length}`);

  // Step 8: Notify Slack
  fetch('http://127.0.0.1:9203/slack/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform,
      status: report.status,
      issues: report.errors,
      fixed: [],
      health_score: report.health_score
    })
  }).catch(() => {});

  return report;
}

// POST /audit/run
app.post('/audit/run', async (req, res) => {
  const { platform } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform required' });
  if (!PLATFORM_CONFIG[platform] && !URL_ONLY_CONFIG[platform]) {
    return res.status(400).json({ error: `Unknown platform. Valid: ${[...Object.keys(PLATFORM_CONFIG), ...Object.keys(URL_ONLY_CONFIG)].join(', ')}` });
  }

  res.json({ ok: true, message: `Audit started for ${platform}`, timestamp: new Date().toISOString() });

  runAudit(platform).catch(e => {
    console.error(`[audit] ${platform} failed:`, e.message);
    db.prepare(`
      UPDATE platform_state SET status = 'error', updated_at = ? WHERE platform = ?
    `).run(new Date().toISOString(), platform);
  });
});

// GET /audit/latest/:platform
app.get('/audit/latest/:platform', (req, res) => {
  const state = db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(req.params.platform);
  if (!state) return res.status(404).json({ error: 'No audit data for this platform yet' });
  state.last_known_errors = JSON.parse(state.last_known_errors || '[]');
  res.json(state);
});

// GET /audit/all
app.get('/audit/all', (req, res) => {
  const states = db.prepare('SELECT * FROM platform_state ORDER BY health_score ASC').all();
  states.forEach(s => { s.last_known_errors = JSON.parse(s.last_known_errors || '[]'); });
  res.json({ platforms: states, checked_at: new Date().toISOString() });
});

app.get('/audit/health', (req, res) => {
  res.json({ status: 'ok', platforms: [...Object.keys(PLATFORM_CONFIG), ...Object.keys(URL_ONLY_CONFIG)], uptime: process.uptime() });
});

const PORT = 9204;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-audit] Running on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-audit] Platforms: ${Object.keys(PLATFORM_CONFIG).join(', ')}`);
});

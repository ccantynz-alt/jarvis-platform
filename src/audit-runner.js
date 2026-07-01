import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import express from 'express';
import Database from 'better-sqlite3';

mkdirSync('/opt/jarvis/reports', { recursive: true });

const app = express();
app.use(express.json());
const db = new Database('/opt/jarvis/memory/jarvis.db');

const PLATFORM_CONFIG = {
  zoobicon: {
    path: process.env.ZOOBICON_PATH || '/var/www/zoobicon',
    urls: ['https://zoobicon.com', 'https://zoobicon.com/builder'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  vapron: {
    path: process.env.VAPRON_PATH || '/var/www/vapron',
    urls: ['https://vapron.ai'],
    buildCmd: 'bun run build',
    testCmd: 'bun test',
    checkCmd: 'bun run check-links'
  },
  alecrae: {
    path: process.env.ALECRAE_PATH || '/var/www/alecrae',
    urls: ['https://alecrae.com'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  gatetest: {
    path: process.env.GATETEST_PATH || '/var/www/gatetest',
    urls: ['https://gatetest.ai'],
    buildCmd: 'cd website && npx next build',
    testCmd: 'node --test tests/*.test.js',
    checkCmd: 'node bin/gatetest.js --list'
  }
};

function runCmd(cmd, cwd, timeoutMs = 120000) {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: 'pipe'
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

async function runAudit(platform) {
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

  // Step 1: Build
  console.log(`[audit] ${platform}: running build...`);
  report.build = runCmd(config.buildCmd, config.path, 180000);
  const buildErrors = extractErrors(report.build.output);
  report.errors.push(...buildErrors.map(e => `BUILD: ${e}`));

  // Step 2: Tests
  if (config.testCmd) {
    console.log(`[audit] ${platform}: running tests...`);
    report.tests = runCmd(config.testCmd, config.path, 120000);
    const testErrors = extractErrors(report.tests.output);
    report.errors.push(...testErrors.map(e => `TEST: ${e}`));
  }

  // Step 3: Extra checks
  if (config.checkCmd) {
    console.log(`[audit] ${platform}: running checks...`);
    report.checks = runCmd(config.checkCmd, config.path, 60000);
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

  // Step 6: Write to memory
  db.prepare(`
    INSERT OR REPLACE INTO platform_state
    (platform, status, last_known_errors, last_audit, last_screenshot, health_score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform,
    report.status,
    JSON.stringify(report.errors),
    new Date().toISOString(),
    report.screenshots.find(s => s.ok)?.filepath || null,
    report.health_score,
    new Date().toISOString()
  );

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
  if (!PLATFORM_CONFIG[platform]) {
    return res.status(400).json({ error: `Unknown platform. Valid: ${Object.keys(PLATFORM_CONFIG).join(', ')}` });
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
  res.json({ status: 'ok', platforms: Object.keys(PLATFORM_CONFIG), uptime: process.uptime() });
});

const PORT = 9204;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-audit] Running on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-audit] Platforms: ${Object.keys(PLATFORM_CONFIG).join(', ')}`);
});

import express from 'express';
import { spawn } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import cron from 'node-cron';

const SLACK_BRIDGE  = 'http://127.0.0.1:9203';
const AUDIT         = 'http://127.0.0.1:9204';
const SCREENSHOT    = 'http://127.0.0.1:9201';
const MEMORY_SVC    = 'http://127.0.0.1:9200';

const app = express();
app.use(express.json());

const PORT = 9205;
const OWN_IP = '66.42.121.161';
const MEMORY_URL = 'http://127.0.0.1:9200';
const REGISTRY_PATH = '/opt/jarvis/config/platforms.json';

// In-memory job store — survives process lifetime only, which is enough for
// the async dispatch use case. Jobs are also recorded in Jarvis memory.
const jobs = new Map();

// Event log for dashboard consumption (circular buffer, last 200 events)
const eventLog = [];
const MAX_EVENTS = 200;

function logEvent(category, message) {
  const entry = { ts: new Date().toISOString(), category, message: String(message).slice(0, 160) };
  eventLog.push(entry);
  if (eventLog.length > MAX_EVENTS) eventLog.shift();
}

function loadRegistry() {
  const raw = readFileSync(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw).platforms;
}

function loadDesignRefs(platformPath) {
  const designDir = join(platformPath, 'design-refs');
  if (!existsSync(designDir)) return [];
  try {
    return readdirSync(designDir)
      .filter(f => /\.(png|jpg|jpeg|webp|gif|mp4|mov|svg|pdf)$/i.test(f))
      .map(f => join(designDir, f));
  } catch {
    return [];
  }
}

function buildPrompt(platform, task, platformPath) {
  const parts = [
    `Read CLAUDE.md.`,
    `Run bash /opt/jarvis/scripts/session-start.sh ${platform}.`,
  ];

  // Include design references if they exist in the platform repo
  const designRefs = platformPath ? loadDesignRefs(platformPath) : [];
  if (designRefs.length > 0) {
    parts.push(
      `DESIGN REFERENCES: The following design files are available in ${platformPath}/design-refs/ to guide your work:`,
      designRefs.map(f => `  - ${f}`).join('\n'),
      `Review these files for visual context before making UI changes.`,
    );
  }

  parts.push(
    `Task: ${task}`,
    `Before finishing: run the project's type-check and build commands to verify nothing is broken.`,
    `Commit all changes with a clear message explaining what was done and why.`,
    `Push to the default branch using the configured git remote.`,
    `End with bash /opt/jarvis/scripts/session-end.sh ${platform}.`,
  );
  return parts.join(' ');
}

async function logToMemory(payload) {
  try {
    await fetch(`${MEMORY_URL}/memory/platform/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[orchestrator] memory log failed:', e.message);
  }
}

function platformEnv(platform) {
  const extra = {};
  if (platform === 'gatetest' && process.env.GATETEST_ADMIN_PASSWORD) {
    extra.GATETEST_ADMIN_PASSWORD = process.env.GATETEST_ADMIN_PASSWORD;
  }
  return extra;
}

function runLocal(platform, path, prompt, job) {
  const proc = spawn(
    'claude',
    ['--dangerously-skip-permissions', '--print', prompt],
    {
      cwd: path,
      env: { ...process.env, HOME: '/root', ...platformEnv(platform) },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    const success = code === 0;
    job.status = success ? 'completed' : 'failed';
    job.exitCode = code;
    job.output = stdout.slice(-4000);  // keep last 4k chars
    job.error = stderr.slice(-2000);
    job.finishedAt = new Date().toISOString();

    console.log(`[orchestrator] job ${job.id} (${platform}) finished — exit ${code}`);
    logToMemory({
      platform,
      status: success ? 'healthy' : 'error',
      notes: `Orchestrator job ${job.id}: ${success ? 'completed' : 'failed (exit ' + code + ')'}`,
    });
  });

  proc.on('error', (err) => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    console.error(`[orchestrator] job ${job.id} spawn error:`, err.message);
  });
}

function runRemote(platform, server, path, prompt, job) {
  // Escape single quotes in the prompt for shell safety
  const safePrompt = prompt.replace(/'/g, "'\\''");
  const extraEnvStr = Object.entries(platformEnv(platform))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const sshCmd = `cd ${path} && ${extraEnvStr ? extraEnvStr + ' ' : ''}claude --dangerously-skip-permissions --print '${safePrompt}'`;

  const proc = spawn(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=10',
      '-i', '/opt/jarvis/.ssh/orchestrator',
      `root@${server}`,
      sshCmd,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  proc.on('close', (code) => {
    const success = code === 0;
    job.status = success ? 'completed' : 'failed';
    job.exitCode = code;
    job.output = stdout.slice(-4000);
    job.error = stderr.slice(-2000);
    job.finishedAt = new Date().toISOString();
    console.log(`[orchestrator] job ${job.id} (${platform}@${server}) finished — exit ${code}`);
    logEvent(success ? 'JOB' : 'ERR',
      `Agent ${success ? 'completed' : 'failed'} — ${job.id.slice(0,8)} on ${platform} (exit ${code})`);
    logToMemory({
      platform,
      status: success ? 'healthy' : 'error',
      notes: `Orchestrator job ${job.id} (remote ${server}): ${success ? 'completed' : 'failed (exit ' + code + ')'}`,
    });
  });

  proc.on('error', (err) => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    logEvent('ERR', `Agent spawn error — ${job.id.slice(0,8)} on ${platform}: ${err.message}`);
    console.error(`[orchestrator] job ${job.id} ssh error:`, err.message);
  });
}

// POST /dispatch  { platform, task }
// platform="auto" → scan task text for a known platform name, fall back to "vapron"
app.post('/dispatch', async (req, res) => {
  let { platform, task } = req.body || {};

  if (!platform || !task) {
    return res.status(400).json({ error: 'platform and task are required' });
  }

  let registry;
  try {
    registry = loadRegistry();
  } catch (e) {
    return res.status(500).json({ error: 'failed to load platform registry: ' + e.message });
  }

  // Auto-detect platform from task text when caller passes platform="auto"
  if (platform === 'auto') {
    const taskLower = task.toLowerCase();
    const matched = Object.keys(registry).find(p =>
      new RegExp(`\\b${p}\\b`).test(taskLower) || taskLower.includes(p),
    );
    if (!matched) {
      return res.status(400).json({
        error: 'Could not detect platform from task text. Which platform?',
        known: Object.keys(registry),
      });
    }
    platform = matched;
    console.log(`[orchestrator] auto-detected platform="${platform}" from task text`);
  }

  const entry = registry[platform];
  if (!entry) {
    return res.status(404).json({
      error: `Unknown platform: ${platform}`,
      known: Object.keys(registry),
    });
  }

  const jobId = randomUUID();
  const job = {
    id: jobId,
    platform,
    task,
    status: 'running',
    isLocal: entry.server === OWN_IP,
    server: entry.server,
    path: entry.path,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    output: null,
    error: null,
  };
  jobs.set(jobId, job);

  const prompt = buildPrompt(platform, task, job.isLocal ? entry.path : null);
  const designRefs = job.isLocal ? loadDesignRefs(entry.path) : [];
  if (designRefs.length > 0) {
    console.log(`[orchestrator] design-refs for ${platform}: ${designRefs.length} file(s)`);
    logEvent('DESIGN', `Found ${designRefs.length} design ref(s) for ${platform}`);
  }
  logEvent('DISPATCH', `Job ${jobId.slice(0,8)} queued → ${platform}: ${task.slice(0,80)}`);
  console.log(`[orchestrator] dispatching job ${jobId} → ${platform} (${entry.server})`);

  await logToMemory({
    platform,
    status: 'working',
    notes: `Orchestrator job ${jobId} started: ${task.slice(0, 100)}`,
  });

  // Dispatch async — response returns immediately with the job ID
  if (job.isLocal) {
    runLocal(platform, entry.path, prompt, job);
  } else {
    runRemote(platform, entry.server, entry.path, prompt, job);
  }

  res.json({ jobId, status: 'running', platform, isLocal: job.isLocal });
});

// GET /status/:jobId
app.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// GET /jobs  — list all jobs (most recent first)
app.get('/jobs', (req, res) => {
  const list = Array.from(jobs.values())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 50);
  res.json(list);
});

// GET /platforms  — dump the registry
app.get('/platforms', (req, res) => {
  try {
    res.json(loadRegistry());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /events  — recent event log for dashboard consumption
app.get('/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  res.json(eventLog.slice(-limit));
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT, jobs: jobs.size, events: eventLog.length });
});

// ── Cron helpers ─────────────────────────────────────────────────────────────

async function slackSend(text) {
  try {
    await fetch(`${SLACK_BRIDGE}/slack/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('[cron] slack send failed:', e.message);
  }
}

async function cronDailyAudit() {
  logEvent('CRON', 'Daily audit sprint starting — scanning all platforms');
  const registry = loadRegistry();
  const names = Object.keys(registry).filter(p => p !== 'jarvis');

  for (const platform of names) {
    try {
      logEvent('CRON', `Audit: ${platform}`);
      const r = await fetch(`${AUDIT}/audit/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      const data = await r.json();
      const score  = data.health_score ?? '?';
      const issues = (data.issues || []).length;
      const emoji  = score > 80 ? '✅' : score > 50 ? '⚠️' : '🔴';
      await slackSend(`${emoji} *${platform}* audit — score ${score}/100, ${issues} issue(s)`);
    } catch (e) {
      await slackSend(`❌ *${platform}* audit failed: ${e.message}`);
    }
  }
  logEvent('CRON', 'Daily audit sprint complete');
}

async function cronDailyScreenshots() {
  logEvent('CRON', 'Daily screenshot baseline run starting');
  const PLATFORM_URLS = {
    zoobicon: 'https://zoobicon.com',
    vapron:   'https://vapron.ai',
    alecrae:  'https://alecrae.com',
    gatetest: 'https://gatetest.ai',
    voxlen:   'https://voxlen.com',
    bookaride:'https://bookaride.com',
  };

  for (const [platform, url] of Object.entries(PLATFORM_URLS)) {
    try {
      logEvent('CRON', `Screenshot: ${platform}`);
      await fetch(`${SCREENSHOT}/screenshot/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, baseline: true }),
      });
    } catch (e) {
      console.error(`[cron] screenshot ${platform} failed:`, e.message);
    }
  }
  await slackSend(`📸 Daily screenshot baselines captured for ${Object.keys(PLATFORM_URLS).length} platforms`);
  logEvent('CRON', 'Daily screenshot baseline run complete');
}

async function cronWeeklySummary() {
  logEvent('CRON', 'Weekly health summary starting');
  try {
    const r = await fetch(`${MEMORY_SVC}/memory/summary`);
    const text = await r.text();
    const mem = JSON.parse(text.replace(/<!DOCTYPE[\s\S]*$/i, '').trim());
    const platforms = mem.platforms || [];

    const day = new Date().toLocaleDateString('en-NZ', {
      timeZone: 'Pacific/Auckland', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });

    let msg = `📊 *JARVIS WEEKLY HEALTH SUMMARY — ${day}*\n\n`;

    const healthy  = platforms.filter(p => p.health_score > 80);
    const warning  = platforms.filter(p => p.health_score > 0 && p.health_score <= 80);
    const unknown  = platforms.filter(p => p.health_score === 0);

    if (healthy.length)  msg += `*Healthy (${healthy.length}):* ${healthy.map(p => `✅ ${p.name}`).join('  ')}\n`;
    if (warning.length) {
      msg += `\n*Needs attention:*\n`;
      for (const p of warning) {
        msg += `⚠️ *${p.name}* — score ${p.health_score}/100`;
        if (p.last_issue) msg += ` — _${String(p.last_issue).slice(0, 80)}_`;
        msg += '\n';
      }
    }
    if (unknown.length)  msg += `\n*Not yet audited:* ${unknown.map(p => `❓ ${p.name}`).join('  ')}\n`;
    if (mem.open_issues > 0) msg += `\n⚠️ *${mem.open_issues} open issues across all platforms*\n`;

    const runningJobs = Array.from(jobs.values()).filter(j => j.status === 'running');
    if (runningJobs.length) msg += `\n⏳ *${runningJobs.length} agent job(s) currently running*`;

    await slackSend(msg);
  } catch (e) {
    await slackSend(`❌ Weekly summary failed: ${e.message}`);
  }
  logEvent('CRON', 'Weekly health summary sent');
}

// ── Cron schedule ─────────────────────────────────────────────────────────────
// 6am NZ = UTC 18:00 (NZST, UTC+12) or 17:00 (NZDT, UTC+13 in summer)
// Running at 18:00 UTC covers standard time; close enough year-round.

cron.schedule('0 18 * * *', () => {
  console.log('[cron] 6am daily audit sprint triggered');
  cronDailyAudit().catch(e => console.error('[cron] audit error:', e.message));
});

cron.schedule('0 18 * * *', () => {
  console.log('[cron] 6am daily screenshot baseline triggered');
  cronDailyScreenshots().catch(e => console.error('[cron] screenshot error:', e.message));
});

cron.schedule('0 19 * * 1', () => {
  console.log('[cron] Monday 7am weekly summary triggered');
  cronWeeklySummary().catch(e => console.error('[cron] weekly summary error:', e.message));
});

// Manual trigger endpoints for testing
app.post('/cron/audit',     (_req, res) => { cronDailyAudit();       res.json({ triggered: 'audit' }); });
app.post('/cron/screenshots',(_req, res) => { cronDailyScreenshots(); res.json({ triggered: 'screenshots' }); });
app.post('/cron/weekly',    (_req, res) => { cronWeeklySummary();    res.json({ triggered: 'weekly' }); });

logEvent('SYS', 'Orchestrator initialized — ready to dispatch agents');

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${PORT}`);
});

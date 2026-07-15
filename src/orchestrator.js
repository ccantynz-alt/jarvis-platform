import express from 'express';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import cron from 'node-cron';
import { pickExecutor } from './executors.js';
import { notify } from './lib/notify.js';
import { spawnClaude, spawnProcess, ensureClaudeVerified } from './lib/spawn-agent.js';
import { getAgent, buildAgentPrompt } from './lib/agents.js';

const SLACK_BRIDGE  = 'http://127.0.0.1:9203';
const AUDIT         = 'http://127.0.0.1:9204';
const SCREENSHOT    = 'http://127.0.0.1:9201';
const MEMORY_SVC    = 'http://127.0.0.1:9200';

const app = express();
app.use(express.json());

// Defaults to 9205 (the live port). Honouring PORT lets a test instance bind a
// free port without touching the live service; secrets.env sets no PORT, so the
// systemd service still binds 9205 unchanged.
const PORT = parseInt(process.env.PORT, 10) || 9205;
const OWN_IP = process.env.OWN_IP || '66.42.121.161';
const MEMORY_URL = 'http://127.0.0.1:9200';
const REGISTRY_PATH = '/opt/jarvis/config/platforms.json';

// ── Cloud (CCR) dispatch config ───────────────────────────────────────────────
// EVERYTHING in the cloud path is INERT unless JARVIS_CLOUD_ENABLED === '1'
// AND both JARVIS_CLOUD_TOKEN and JARVIS_CLOUD_ENV are set. With the flag off
// (the default), pickExecutor never returns 'cloud' and none of this runs.
//
// ⚠️  HUMAN CONFIRMATION REQUIRED before enabling cloud mode:
//   - CLOUD_API_URL below is a BEST-GUESS at the Anthropic code/triggers
//     ("routines") create+run endpoint. Confirm the real URL + auth scheme
//     (Bearer token vs x-api-key, anthropic-version header) against live docs.
//   - The callback must be reachable FROM the cloud agent. The orchestrator
//     binds loopback-only (127.0.0.1:9205), so a cloud agent CANNOT reach it
//     directly — a human must expose a public callback URL (tunnel / dashboard
//     host / reverse proxy) and set JARVIS_CALLBACK_URL to it.
const CLOUD_API_URL = process.env.JARVIS_CLOUD_API_URL
  || 'https://api.anthropic.com/v1/routines';   // <-- NEEDS HUMAN CONFIRMATION
const CLOUD_MODEL = 'claude-sonnet-5';

// ── Durable job queue (memory-server :9200 is the system of record) ──────────
// Jobs live in the SQLite `jobs` table, not in this process, so they survive
// restarts (previously an in-memory Map — every restart silently dropped the
// whole job list). The orchestrator is the single scheduler: it enqueues on
// /dispatch and a tick loop starts queued jobs up to MAX_CONCURRENT_JOBS.

const MAX_CONCURRENT_JOBS = parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 3;
const SCHEDULER_TICK_MS = 4000;
const CANARY_RETRY_MS = 30 * 60_000;

async function dbGet(path) {
  const r = await fetch(`${MEMORY_URL}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

async function dbPost(path, body) {
  const r = await fetch(`${MEMORY_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

function jobTransition(id, to, detail, fields = {}) {
  return dbPost(`/memory/jobs/${id}/transition`, { to, detail, fields });
}

// Map a DB row to the camelCase shape /jobs and /status/:id always returned,
// so the dashboard and conversation.js need zero changes. startedAt falls back
// to createdAt because queued jobs haven't started and old consumers sort on it.
function toApiJob(row) {
  return {
    id: row.id,
    platform: row.platform,
    agent: row.agent,
    task: row.task,
    status: row.status,
    isLocal: row.server === OWN_IP,
    server: row.server,
    path: row.path,
    executor: row.executor,
    enqueuedBy: row.enqueued_by,
    attempts: row.attempts,
    startedAt: row.started_at || row.created_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    output: row.output,
    error: row.error,
  };
}

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

// Record a completed spawn result against the job row. Same notify/memory
// behavior the old in-process handlers had.
async function finishJob(row, result) {
  const success = result.code === 0 && !result.timedOut;
  const error = result.timedOut
    ? `timed out after ${row.timeout_min} min\n${result.stderr}`
    : result.stderr;

  await jobTransition(row.id, success ? 'completed' : 'failed',
    result.timedOut ? 'timeout' : `exit ${result.code}`, {
      finished_at: new Date().toISOString(),
      exit_code: result.code,
      output: result.stdout,
      error: String(error || '').slice(-2000),
    });

  console.log(`[orchestrator] job ${row.id} (${row.platform}) finished — exit ${result.code}${result.timedOut ? ' (TIMEOUT)' : ''}`);
  logEvent(success ? 'JOB' : 'ERR',
    `Agent ${success ? 'completed' : 'failed'} — ${row.id.slice(0, 8)} on ${row.platform} (exit ${result.code}${result.timedOut ? ', timeout' : ''})`);
  // Role-agent jobs must not flip platform health state — a social-media
  // draft succeeding says nothing about the platform being healthy.
  if (!row.agent) {
    logToMemory({
      platform: row.platform,
      status: success ? 'healthy' : 'error',
      notes: `Orchestrator job ${row.id}: ${success ? 'completed' : 'failed (exit ' + result.code + ')'}`,
    });
  }
  if (!success) {
    notify({
      source: 'orchestrator',
      level: 'error',
      title: `❌ Job failed on ${row.platform} (exit ${result.code}${result.timedOut ? ', timeout' : ''})`,
      body: `Job ${row.id.slice(0, 8)}: ${(error || result.stdout || 'no output').slice(0, 500)}`,
    }).catch((e) => console.error('[orchestrator] failure notify failed:', e.message));
  }
}

async function runLocalJob(row) {
  const result = await spawnClaude({
    prompt: row.prompt,
    cwd: row.path,
    model: row.model || undefined,
    extraEnv: platformEnv(row.platform),
    timeoutMin: row.timeout_min,
  });
  await finishJob(row, result);
}

async function runRemoteJob(row) {
  // Escape single quotes in the prompt for shell safety
  const safePrompt = row.prompt.replace(/'/g, "'\\''");
  const extraEnvStr = Object.entries(platformEnv(row.platform))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  const sshCmd = `cd ${row.path} && IS_SANDBOX=1 DISABLE_AUTOUPDATER=1 ${extraEnvStr ? extraEnvStr + ' ' : ''}claude --dangerously-skip-permissions --print '${safePrompt}'`;

  const result = await spawnProcess('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-i', '/opt/jarvis/.ssh/orchestrator',
    `root@${row.server}`,
    sshCmd,
  ], { env: process.env, timeoutMin: row.timeout_min });
  await finishJob(row, result);
}

// Resolve a job row to a clean failure without crashing the process.
async function failJobRow(row, message) {
  logEvent('ERR', `Job ${row.id.slice(0, 8)} failed: ${String(message).slice(0, 100)}`);
  console.error(`[orchestrator] job ${row.id} failed:`, message);
  await jobTransition(row.id, 'failed', 'error', {
    finished_at: new Date().toISOString(),
    exit_code: 1,
    error: String(message).slice(-2000),
  }).catch((e) => console.error('[orchestrator] fail transition failed:', e.message));
  logToMemory({
    platform: row.platform,
    status: 'error',
    notes: `Orchestrator job ${row.id}: failed — ${String(message).slice(0, 120)}`,
  });
}

// runCloud — dispatch a cloud CCR agent via the Anthropic code/triggers API.
// Clones entry.repo, appends a FINAL-STEP instruction telling the agent to POST
// its result back to /dispatch/callback. Resolves the SAME job fields runLocal
// sets. On any misconfiguration or API error it fails the job cleanly (never
// crashes). Reached only when JARVIS_CLOUD_ENABLED==='1' routes here.
async function runCloud(row) {
  const platform = row.platform;
  const token = process.env.JARVIS_CLOUD_TOKEN;
  const environmentId = process.env.JARVIS_CLOUD_ENV;

  // Fail cleanly (do NOT crash) when cloud creds are missing.
  if (!token || !environmentId) {
    const missing = !token ? 'JARVIS_CLOUD_TOKEN' : 'JARVIS_CLOUD_ENV';
    return failJobRow(row, `cloud dispatch unavailable: ${missing} is not set`);
  }
  let entry;
  try {
    entry = loadRegistry()[platform];
  } catch (e) {
    return failJobRow(row, `cloud dispatch: registry load failed — ${e.message}`);
  }
  if (!entry?.repo) {
    return failJobRow(row, `cloud dispatch requires a git repo for platform "${platform}" (entry.repo is empty)`);
  }

  // The cloud agent runs off-box, so it cannot reach the loopback orchestrator.
  // A human must set JARVIS_CALLBACK_URL to a publicly reachable endpoint that
  // proxies to POST /dispatch/callback. Falls back to a best-effort URL.
  const callbackUrl = process.env.JARVIS_CALLBACK_URL
    || `http://${OWN_IP}:${PORT}/dispatch/callback`;

  const finalStep = [
    ``,
    ``,
    `FINAL STEP (required): after all work is complete, report back to Jarvis by`,
    `sending an HTTP POST to ${callbackUrl}`,
    `with header "X-Jarvis-Token: ${token}" and a JSON body:`,
    `{"jobId":"${row.id}","ok":true,"summary":"<one-paragraph summary of what you did>"}`,
    `Set "ok" to false if the task could not be completed.`,
  ].join('\n');

  const content = row.prompt + finalStep;

  // Request shape per the reference (routines/trigger create+run). Endpoint and
  // auth scheme are BEST-GUESS — see CLOUD_API_URL note. Needs human confirmation.
  const body = {
    name: `jarvis-${platform}-${row.id.slice(0, 8)}`,
    run_once_at: new Date().toISOString(),
    job_config: {
      ccr: {
        environment_id: environmentId,
        session_context: {
          model: CLOUD_MODEL,
          sources: [{ git_repository: { url: entry.repo } }],
          allowed_tools: ['Read', 'Edit', 'Write', 'Bash'],
        },
        events: [
          { data: { type: 'user', message: { role: 'user', content } } },
        ],
      },
    },
  };

  try {
    const r = await fetch(CLOUD_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();

    if (!r.ok) {
      return failJobRow(row, `cloud API ${r.status}: ${text.slice(0, 500)}`);
    }

    // Dispatched OK. The job stays 'running' until the agent POSTs the callback,
    // at which point /dispatch/callback resolves status/output/finished_at.
    await jobTransition(row.id, 'running', 'cloud agent dispatched, awaiting callback', {
      output: `Cloud agent dispatched (CCR ${CLOUD_MODEL}). Awaiting callback for job ${row.id}. API response: ${text.slice(0, 500)}`,
    });
    logEvent('CLOUD', `Cloud agent dispatched — ${row.id.slice(0, 8)} on ${platform}`);
    logToMemory({
      platform,
      status: 'working',
      notes: `Orchestrator job ${row.id} dispatched to cloud (${platform}); awaiting callback`,
    });
  } catch (e) {
    return failJobRow(row, `cloud dispatch error: ${e.message}`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

let gateHeld = false;
let lastCanaryAt = 0;
let tickInFlight = false;

async function executeJob(row) {
  try {
    if (row.executor === 'cloud') return await runCloud(row);
    if (row.executor === 'local') return await runLocalJob(row);
    return await runRemoteJob(row);
  } catch (e) {
    await failJobRow(row, e.message);
  }
}

async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const queued = await dbGet('/memory/jobs?status=queued&limit=100');
    if (!queued.length) return;

    const running = await dbGet('/memory/jobs?status=running&limit=100');
    const slots = MAX_CONCURRENT_JOBS - running.length;
    if (slots <= 0) return;

    // Canary gate: a changed claude CLI must pass a probe before ANY job
    // starts. While held, jobs stay queued (nothing is lost) and the gate
    // retries every CANARY_RETRY_MS.
    if (gateHeld && Date.now() - lastCanaryAt < CANARY_RETRY_MS) return;
    const gate = await ensureClaudeVerified();
    lastCanaryAt = Date.now();
    if (!gate.ok) {
      if (!gateHeld) {
        gateHeld = true;
        logEvent('ERR', `Canary FAILED — claude dispatch HELD (${gate.version || 'no version'})`);
        notify({
          source: 'orchestrator',
          level: 'alert',
          title: `🛑 Claude CLI ${gate.version || '(unknown)'} failed canary — dispatch HELD`,
          body: `${gate.detail}\nQueued jobs are safe and will run once the canary passes. Retrying every 30 min.`,
          speech: 'Warning. The Claude command line failed its canary check. Agent dispatch is held until it passes.',
        }).catch(() => {});
      }
      return;
    }
    if (gateHeld) {
      gateHeld = false;
      logEvent('SYS', `Canary passed — dispatch resumed (${gate.version})`);
      notify({
        source: 'orchestrator',
        title: `✅ Claude CLI canary passed — dispatch resumed (${gate.version})`,
      }).catch(() => {});
    }

    const toStart = queued
      .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at))
      .slice(0, slots);

    for (const row of toStart) {
      await jobTransition(row.id, 'running', 'scheduler start', {
        started_at: new Date().toISOString(),
        attempts: row.attempts + 1,
      });
      logEvent('DISPATCH', `Job ${row.id.slice(0, 8)} started → ${row.platform} (${row.executor})`);
      console.log(`[orchestrator] starting job ${row.id} → ${row.platform} (${row.executor})`);
      executeJob({ ...row, attempts: row.attempts + 1 });  // async — not awaited
    }
  } catch (e) {
    console.error('[scheduler] tick error:', e.message);
  } finally {
    tickInFlight = false;
  }
}

// Boot recovery: anything left 'running' by a previous process is transitioned
// to 'interrupted', then re-queued if it has attempts left, else failed.
async function recoverInterruptedJobs() {
  try {
    const running = await dbGet('/memory/jobs?status=running&limit=500');
    if (!running.length) return;
    let requeued = 0;
    let failed = 0;
    for (const row of running) {
      await jobTransition(row.id, 'interrupted', 'orchestrator restarted mid-run');
      if (row.attempts < row.max_attempts) {
        await jobTransition(row.id, 'queued', `re-queued (attempt ${row.attempts}/${row.max_attempts})`);
        requeued++;
      } else {
        await jobTransition(row.id, 'failed', 'interrupted, attempts exhausted', {
          finished_at: new Date().toISOString(),
          error: 'interrupted by orchestrator restart, no attempts left',
        });
        failed++;
      }
    }
    logEvent('SYS', `Recovery: ${running.length} interrupted job(s) — ${requeued} re-queued, ${failed} failed`);
    notify({
      source: 'orchestrator',
      level: failed ? 'warn' : 'info',
      title: `♻️ Orchestrator restarted — recovered ${running.length} job(s)`,
      body: `${requeued} re-queued and will resume shortly; ${failed} failed (attempts exhausted).`,
    }).catch(() => {});
  } catch (e) {
    console.error('[orchestrator] boot recovery failed:', e.message);
  }
}

// POST /dispatch  { platform, task }
// platform="auto" → scan task text for a known platform name, fall back to "vapron"
app.post('/dispatch', async (req, res) => {
  let { platform, task, agent, executor: requestedExecutor } = req.body || {};

  // ── Role-agent dispatch: prompt comes from the agent registry, not the
  // platform boilerplate (no session scripts, no commit/push, cwd sandboxed).
  if (agent) {
    let role;
    try {
      role = getAgent(agent);
    } catch (e) {
      return res.status(500).json({ error: 'failed to load agent registry: ' + e.message });
    }
    if (!role) return res.status(404).json({ error: `Unknown agent: ${agent}` });
    if (role.kind !== 'role') return res.status(400).json({ error: `Agent "${agent}" is ${role.kind}, not a dispatchable role` });
    if (role.status !== 'active') return res.status(409).json({ error: `Agent "${agent}" is ${role.status}` });

    const jobId = randomUUID();
    let prompt;
    try {
      prompt = buildAgentPrompt(role, task, jobId);
    } catch (e) {
      return res.status(500).json({ error: 'failed to build agent prompt: ' + e.message });
    }

    try {
      await dbPost('/memory/jobs', {
        id: jobId,
        platform: role.platform || null,
        agent: role.name,
        task: task || `Scheduled run: ${role.display_name}`,
        prompt,
        executor: 'local',
        runtime: role.runtime || 'claude',
        model: role.model || null,
        server: OWN_IP,
        path: role.permissions.cwd,
        enqueued_by: (req.body && req.body.enqueued_by) || 'api',
        parent_job_id: (req.body && req.body.parent_job_id) || null,
        priority: role.priority ?? 5,
        timeout_min: role.budget?.timeout_min ?? 20,
        max_attempts: 2,
      });
    } catch (e) {
      return res.status(500).json({ error: 'failed to enqueue agent job: ' + e.message });
    }

    logEvent('DISPATCH', `Agent job ${jobId.slice(0, 8)} queued → ${role.name}`);
    console.log(`[orchestrator] enqueued agent job ${jobId} → ${role.name}`);
    return res.json({ jobId, status: 'queued', agent: role.name, executor: 'local' });
  }

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
  const isLocal = entry.server === OWN_IP;
  const prompt = buildPrompt(platform, task, isLocal ? entry.path : null);

  const designRefs = isLocal ? loadDesignRefs(entry.path) : [];
  if (designRefs.length > 0) {
    console.log(`[orchestrator] design-refs for ${platform}: ${designRefs.length} file(s)`);
    logEvent('DESIGN', `Found ${designRefs.length} design ref(s) for ${platform}`);
  }

  // Choose the executor. With JARVIS_CLOUD_ENABLED unset, pickExecutor returns
  // exactly the legacy result: 'local' for OWN_IP, 'remote' otherwise.
  const executor = pickExecutor(platform, entry, task, requestedExecutor);

  // Enqueue durably; the scheduler tick starts it within a few seconds.
  // max_attempts 2 = one automatic retry if a restart interrupts the job.
  try {
    await dbPost('/memory/jobs', {
      id: jobId,
      platform,
      task,
      prompt,
      executor,
      server: entry.server,
      path: entry.path,
      enqueued_by: (req.body && req.body.enqueued_by) || 'api',
      parent_job_id: (req.body && req.body.parent_job_id) || null,
      priority: (req.body && req.body.priority) ?? 5,
      timeout_min: (req.body && req.body.timeout_min) ?? 30,
      max_attempts: 2,
    });
  } catch (e) {
    return res.status(500).json({ error: 'failed to enqueue job: ' + e.message });
  }

  logEvent('DISPATCH', `Job ${jobId.slice(0,8)} queued → ${platform}: ${task.slice(0,80)}`);
  console.log(`[orchestrator] enqueued job ${jobId} → ${platform} (${entry.server}, ${executor})`);

  await logToMemory({
    platform,
    status: 'working',
    notes: `Orchestrator job ${jobId} queued: ${task.slice(0, 100)}`,
  });

  res.json({ jobId, status: 'queued', platform, isLocal, executor });
});

// GET /status/:jobId
app.get('/status/:jobId', async (req, res) => {
  try {
    const row = await dbGet(`/memory/jobs/${req.params.jobId}`);
    res.json(toApiJob(row));
  } catch {
    res.status(404).json({ error: 'Job not found' });
  }
});

// POST /dispatch/callback  { jobId, ok, summary }
// Cloud CCR agents POST here when they finish. Authenticated by the shared
// X-Jarvis-Token header (must equal JARVIS_CLOUD_TOKEN). Harmless when unused:
// if JARVIS_CLOUD_TOKEN is not set, every request is rejected with 401.
app.post('/dispatch/callback', async (req, res) => {
  const expected = process.env.JARVIS_CLOUD_TOKEN;
  const provided = req.header('X-Jarvis-Token');
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { jobId, ok, summary } = req.body || {};
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  let row;
  try {
    row = await dbGet(`/memory/jobs/${jobId}`);
  } catch {
    return res.status(404).json({ error: 'Job not found' });
  }

  const success = ok === true || ok === 'true';
  await jobTransition(jobId, success ? 'completed' : 'failed', 'cloud callback', {
    finished_at: new Date().toISOString(),
    exit_code: success ? 0 : 1,
    output: String(summary || '').slice(-4000),
    ...(success ? {} : { error: String(summary || 'cloud agent reported failure').slice(-2000) }),
  }).catch((e) => console.error('[orchestrator] callback transition failed:', e.message));

  logEvent(success ? 'JOB' : 'ERR',
    `Cloud callback — ${jobId.slice(0, 8)} on ${row.platform} ${success ? 'completed' : 'failed'}`);
  console.log(`[orchestrator] cloud callback for job ${jobId} — ${success ? 'completed' : 'failed'}`);
  logToMemory({
    platform: row.platform,
    status: success ? 'healthy' : 'error',
    notes: `Orchestrator cloud job ${jobId}: ${success ? 'completed' : 'failed'} (via callback)`,
  });

  res.json({ ok: true });
});

// GET /jobs  — list recent jobs (most recent first)
app.get('/jobs', async (_req, res) => {
  try {
    const rows = await dbGet('/memory/jobs?limit=50');
    res.json(rows.map(toApiJob));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
app.get('/health', async (_req, res) => {
  let queue = null;
  try {
    const counts = await dbGet('/memory/jobs/counts?window=today');
    queue = Object.fromEntries(counts.by_status.map((r) => [r.status, r.count]));
  } catch {}
  res.json({
    status: 'ok',
    port: PORT,
    queue,
    canaryHeld: gateHeld,
    maxConcurrent: MAX_CONCURRENT_JOBS,
    events: eventLog.length,
  });
});

// ── Cron helpers ─────────────────────────────────────────────────────────────

// Kept name for the cron callers; now fans out via lib/notify.js
// (durable inbox → gateway push → Slack only while NOTIFY_SLACK_LEGACY=1).
async function slackSend(text) {
  try {
    await notify({ source: 'orchestrator-cron', title: text.split('\n')[0].slice(0, 120), body: text });
  } catch (e) {
    console.error('[cron] notify failed:', e.message);
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
    bookaride:'https://www.bookaride.co.nz',
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

    const runningJobs = await dbGet('/memory/jobs?status=running&limit=100').catch(() => []);
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

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${PORT}`);
  await recoverInterruptedJobs();
  setInterval(schedulerTick, SCHEDULER_TICK_MS);
  console.log(`[orchestrator] scheduler running (tick ${SCHEDULER_TICK_MS}ms, max ${MAX_CONCURRENT_JOBS} concurrent)`);
});

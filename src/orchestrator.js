import express from 'express';
import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';

const app = express();
app.use(express.json());

const PORT = 9205;
const OWN_IP = '66.42.121.161';
const MEMORY_URL = 'http://127.0.0.1:9200';
const REGISTRY_PATH = '/opt/jarvis/config/platforms.json';

// In-memory job store — survives process lifetime only, which is enough for
// the async dispatch use case. Jobs are also recorded in Jarvis memory.
const jobs = new Map();

function loadRegistry() {
  const raw = readFileSync(REGISTRY_PATH, 'utf8');
  return JSON.parse(raw).platforms;
}

function buildPrompt(platform, task) {
  return [
    `Read CLAUDE.md.`,
    `Run bash /opt/jarvis/scripts/session-start.sh ${platform}.`,
    `Task: ${task}`,
    `Before finishing: run the project's type-check and build commands to verify nothing is broken.`,
    `Commit all changes with a clear message explaining what was done and why.`,
    `Push to the default branch using the configured git remote.`,
    `End with bash /opt/jarvis/scripts/session-end.sh ${platform}.`,
  ].join(' ');
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

function runLocal(platform, path, prompt, job) {
  const proc = spawn(
    'claude',
    ['--print', prompt],
    {
      cwd: path,
      env: { ...process.env, HOME: '/root' },
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
  const sshCmd = `cd ${path} && claude --print '${safePrompt}'`;

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
    platform = matched ?? 'vapron';
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

  const prompt = buildPrompt(platform, task);
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

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT, jobs: jobs.size });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${PORT}`);
});

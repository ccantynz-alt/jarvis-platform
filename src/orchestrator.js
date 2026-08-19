import express from 'express';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import cron from 'node-cron';
import { pickExecutor } from './executors.js';
import { notify } from './lib/notify.js';
import { spawnClaude, spawnClaudeRemote, ensureClaudeVerified } from './lib/spawn-agent.js';
import { modelFor } from './lib/model-routing.js';
import { usageHold, authHold } from './lib/claude-auth.js';
import { verifyConfirm } from './lib/pc-confirm.js';
import { internalGuard } from './lib/internal-http.js';
import { getAgent, buildAgentPrompt } from './lib/agents.js';
import { guardrail, clampLimit } from './lib/guardrail.js';
import { planAction, encodeActionJob, workerKnowsVerb } from './lib/pc-actions.js';
import { jobWritesPlatformHealth } from './lib/health-status.js';
import { installInternalAuth } from './lib/internal-http.js';
installInternalAuth();   // gate loopback :9200/:9205 writes with the internal token (move 11)

const SLACK_BRIDGE  = 'http://127.0.0.1:9203';
const AUDIT         = 'http://127.0.0.1:9204';
const SCREENSHOT    = 'http://127.0.0.1:9201';
const MEMORY_SVC    = 'http://127.0.0.1:9200';

const app = express();
app.use(express.json());

/**
 * Express 4 does NOT catch a rejected promise returned by a route handler, and
 * nothing here registers an unhandledRejection handler — so on Node 20 a single
 * rejected await inside an async route took the WHOLE DISPATCH ENGINE down.
 *
 * The live path (found 2026-07-31): POST /worker/result ends in
 * `await finishJob(...)` → jobTransition → dbPost, which rejects whenever
 * memory-server is unreachable or answers non-2xx. Craig's PC worker posts
 * after every job and retries 4×, so it only had to land while jarvis-memory
 * was restarting or briefly wedged — a condition this file already documents as
 * real in reapOverdueRunningJobs. Every in-flight local and SSH job died with
 * the process.
 *
 * Wrap async handlers in this instead of returning a bare promise to Express.
 */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(`[orchestrator] ${req.method} ${req.path} failed: ${e && e.stack || e}`);
  logEvent('ERR', `${req.method} ${req.path} threw: ${String(e && e.message || e).slice(0, 120)}`);
  if (!res.headersSent) res.status(500).json({ error: String(e && e.message || e) });
});

// Backstop for the same class of bug anywhere else in this process. Deliberately
// does NOT exit: this is the dispatch engine, and dying loses every in-flight
// job to recover its own bug. Loud in the log and the event stream instead —
// quiet degradation is the failure mode this codebase refuses (principle 6).
process.on('unhandledRejection', (reason) => {
  console.error(`[orchestrator] UNHANDLED REJECTION (process kept alive): ${reason && reason.stack || reason}`);
  try { logEvent('ERR', `Unhandled rejection: ${String(reason && reason.message || reason).slice(0, 160)}`); } catch { /* logEvent must never be the thing that kills us */ }
});

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
const CLOUD_MODEL = 'claude-fable-5';
// Default model for dispatched build/design work when the job doesn't name one
// (Craig, 2026-07-16: Fable 5 creates the frontend/backend — role agents keep
// their explicit per-agent models from config/agents.json, unchanged).
const DEFAULT_WORKER_MODEL = process.env.JARVIS_WORKER_MODEL || modelFor('repair');   // Opus everyday-heavy, was Fable (move 17)

// ── Durable job queue (memory-server :9200 is the system of record) ──────────
// Jobs live in the SQLite `jobs` table, not in this process, so they survive
// restarts (previously an in-memory Map — every restart silently dropped the
// whole job list). The orchestrator is the single scheduler: it enqueues on
// /dispatch and a tick loop starts queued jobs up to MAX_CONCURRENT_JOBS.

// Fleet-wide concurrency is a guardrail — parse it so a malformed value is
// reported and defaulted rather than quietly becoming NaN (see lib/guardrail.js).
const MAX_CONCURRENT_JOBS = guardrail('MAX_CONCURRENT_JOBS', 3, { source: 'orchestrator' });
const SCHEDULER_TICK_MS = 4000;
const CANARY_RETRY_MS = 30 * 60_000;
// Grace past a job's OWN timeout before it is treated as a zombie. The worker is
// already SIGKILLed by then; this margin only covers a slow final status write.
const REAP_SLACK_MIN = guardrail('ORCH_REAP_SLACK_MIN', 10, { source: 'orchestrator' });
// PC-worker lease: how long a claimed job is reserved before an unrenewed
// lease is reaped back to queued (worker slept, lost network, or crashed).
// The worker's heartbeat (POST /worker/heartbeat) renews it while a job runs.
const PC_LEASE_MS = 120_000;
// Wakes long-polling /worker/claim requests the instant a PC job is enqueued.
const pcWake = new EventEmitter();
pcWake.setMaxListeners(50);
const PC_CONFIRM_SECRET = process.env.JARVIS_PC_CONFIRM_SECRET || '';
// Spent confirmation nonces → their exp, for single-use enforcement (move 37).
// Swept opportunistically so it can't grow unbounded.
const pcConfirmSpent = new Map();
setInterval(() => { const now = Date.now(); for (const [n, exp] of pcConfirmSpent) if (exp < now) pcConfirmSpent.delete(n); }, 60_000).unref?.();

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

function jobTransition(id, to, detail, fields = {}, from = undefined) {
  return dbPost(`/memory/jobs/${id}/transition`, { to, detail, fields, from });
}

// POST the transition and return true/false instead of throwing on a 409
// (guard miss — someone else already moved the row). Used by the atomic
// PC-worker claim race.
async function tryTransition(id, to, detail, fields, from) {
  const r = await fetch(`${MEMORY_URL}/memory/jobs/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, detail, fields, from }),
  });
  if (r.status === 409) return false;
  if (!r.ok) throw new Error(`POST transition → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
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

function buildPrompt(platform, task, platformPath, executor = null) {
  // PC-worker jobs run on Craig's Windows machine, not the Linux fleet box —
  // none of the session-start.sh / CLAUDE.md / git-push boilerplate applies
  // (no /opt/jarvis there, no platform repo to push).
  if (executor === 'pc') return task;

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
  // Which job outcomes may write platform health lives in lib/health-status.js
  // with the other two writers' rules — role-agent jobs and typed PC actions
  // are both excluded, and the 2026-08-10 alert flood is documented there.
  if (jobWritesPlatformHealth(row)) {
    logToMemory({
      platform: row.platform,
      status: success ? 'healthy' : 'error',
      notes: `Orchestrator job ${row.id}: ${success ? 'completed' : 'failed (exit ' + result.code + ')'}`,
    });
  }
  if (!success) {
    notify({
      source: 'orchestrator',
      // 'warn', not 'error' (which is not in notify()'s contract) and not
      // 'alert': jobs fail routinely, and reserving max priority for real
      // emergencies is what keeps the device channel worth listening to.
      level: 'warn',
      title: `❌ Job failed on ${row.platform} (exit ${result.code}${result.timedOut ? ', timeout' : ''})`,
      body: `Job ${row.id.slice(0, 8)}: ${(error || result.stdout || 'no output').slice(0, 500)}`,
    }).catch((e) => console.error('[orchestrator] failure notify failed:', e.message));
  }
}

async function runLocalJob(row) {
  const result = await spawnClaude({
    prompt: row.prompt,
    cwd: row.path,
    model: row.model || DEFAULT_WORKER_MODEL,
    extraEnv: platformEnv(row.platform),
    timeoutMin: row.timeout_min,
    // A usage-limit account flip starts a SECOND full-length run under this same
    // row, so restart the clock (2026-07-30). Without this the reaper below sees
    // a job past its timeout and declares the worker dead while it is still
    // editing and pushing — the reaper's justification is only true if
    // started_at reflects the run that is ACTUALLY in progress.
    onRetry: async ({ from, to }) => {
      try {
        await jobTransition(row.id, 'running', `usage-limit flip ${from} → ${to}: second attempt, clock restarted`, {
          started_at: new Date().toISOString(),
        });
        console.log(`[orchestrator] job ${row.id} retrying on ${to} — reap clock restarted`);
      } catch (e) {
        // The reaper may now fail this job early. Say so loudly rather than
        // letting a false "reaped a stuck job" alert be the only trace.
        console.error(`[orchestrator] could not restart the reap clock for ${row.id} (${e.message}) — a long retry may be reaped early`);
      }
    },
  });
  // Both subscription logins are exhausted. spawnClaude has already tried the
  // other account and set limitHeld — the work was never attempted, so calling
  // it FAILED is a lie that also loses the task. Put it back in the queue; the
  // usage-limit gate in schedulerTick keeps it parked until the earliest reset
  // instead of retrying it into the same wall. (Found by the code-health spine,
  // 2026-07-30: claude-auth promised this behaviour out loud and nothing did it.)
  if (result.limitHeld) {
    const hold = usageHold();
    console.warn(`[orchestrator] job ${row.id} held — all Claude accounts exhausted${hold.at ? ` until ${hold.at}` : ''}`);
    logEvent('ERR', `Job ${row.id.slice(0, 8)} HELD — every Claude account is usage-limited`);
    await jobTransition(row.id, 'queued', 'held: all Claude accounts usage-limited', {
      started_at: null,
    }).catch((e) => console.error('[orchestrator] re-queue after usage limit failed:', e.message));
    return;
  }
  // Same for a dead login (2026-08-19). spawn-agent has set authHeld since
  // 2026-08-16; this was the first consumer. The 136 "failed" jobs on the box
  // that week were mostly this: never attempted, task lost, Craig pushed a
  // "❌ Job failed" blaming the agent.
  if (result.authHeld) {
    const hold = authHold();
    console.warn(`[orchestrator] job ${row.id} held — no Claude login can authenticate${hold.at ? `; re-probe ${hold.at}` : ''}`);
    logEvent('ERR', `Job ${row.id.slice(0, 8)} HELD — no Claude login can authenticate`);
    await jobTransition(row.id, 'queued', 'held: no Claude login can authenticate', {
      started_at: null,
    }).catch((e) => console.error('[orchestrator] re-queue after auth failure failed:', e.message));
    return;
  }
  await finishJob(row, result);
}

async function runRemoteJob(row) {
  // One remote-spawn mechanism, shared with code-health's remote sweeps —
  // see spawnClaudeRemote in lib/spawn-agent.js (2026-08-08).
  const result = await spawnClaudeRemote({
    prompt: row.prompt,
    server: row.server,
    cwd: row.path,
    timeoutMin: row.timeout_min,
    extraEnv: platformEnv(row.platform),
  });
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

  // A PER-JOB callback credential, not the master token (2026-07-30, found by
  // the code-health spine on the auth-session lens).
  //
  // This used to embed JARVIS_CLOUD_TOKEN verbatim in the prompt — the same
  // bearer that authenticates the API call AND the callback. A prompt is not a
  // secret: it is stored, logged and retained by a third-party provider, and it
  // sits in the agent's own transcript. Anyone who read one held the credential
  // that lets you POST /dispatch/callback for ANY job id and declare it
  // completed with arbitrary output — which flips platform health and injects
  // text into Craig's notifications.
  //
  // Now each job gets its own random token, stored in memory KV under
  // cloud-callback-token:<jobId>. Worst case a leaked prompt lets someone lie
  // about ONE job that was already theirs to run, instead of every job forever.
  const callbackToken = randomUUID();
  try {
    await dbPost('/memory/kv', { key: `cloud-callback-token:${row.id}`, value: callbackToken });
  } catch (e) {
    return failJobRow(row, `cloud dispatch: could not store the per-job callback token — ${e.message}`);
  }

  const finalStep = [
    ``,
    ``,
    `FINAL STEP (required): after all work is complete, report back to Jarvis by`,
    `sending an HTTP POST to ${callbackUrl}`,
    `with header "X-Jarvis-Token: ${callbackToken}" and a JSON body:`,
    `{"jobId":"${row.id}","ok":true,"summary":"<one-paragraph summary of what you did>"}`,
    `Set "ok" to false if the task could not be completed.`,
    `This token is for this job only.`,
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
// When the usage-limit hold started, so "held" and "resumed" are each logged
// once rather than every 30-second tick.
let usageHeldSince = null;
// Same, for the auth hold (2026-08-19): every login seen failing to
// authenticate → dispatch parks until the earliest cooldown expiry.
let authHeldSince = null;
let lastCanaryAt = 0;
let tickInFlight = false;

async function executeJob(row) {
  try {
    if (row.executor === 'cloud') return await runCloud(row);
    if (row.executor === 'local') return await runLocalJob(row);
    // 'pc' jobs are pulled via /worker/claim, never started here — the
    // scheduler filter above keeps them out of toStart. Defensive-only.
    if (row.executor === 'pc') return;
    return await runRemoteJob(row);
  } catch (e) {
    await failJobRow(row, e.message);
  }
}

async function schedulerTick() {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    // REAPERS RUN FIRST (2026-07-30). They used to sit at the bottom of this
    // function, below `if (!queued.length) return`, the slot check, and both
    // gates — so a dead job was only ever noticed when there happened to be
    // OTHER work queued, a free slot to run it in, and every gate open. An idle
    // fleet is exactly when nothing else clears a zombie, and a zombie is
    // expensive: self-heal and audit-runner both refuse to dispatch while a job
    // for that platform looks in-flight, so one lost status write can stop a
    // platform being repaired indefinitely, silently.
    await reapExpiredPcLeases();
    await reapOverdueRunningJobs();

    const queued = await dbGet('/memory/jobs?status=queued&limit=100');
    if (!queued.length) return;

    const running = await dbGet('/memory/jobs?status=running&limit=100');
    const slots = MAX_CONCURRENT_JOBS - running.length;
    if (slots <= 0) return;

    // Usage-limit gate: while EVERY subscription login is inside its cooldown,
    // starting a claude job just burns a spawn to hit the same wall — and, until
    // 2026-07-30, marked the job failed for it. Jobs stay queued; this is the
    // enforcement of what claude-auth already tells Craig out loud ("I'll hold
    // Claude work until roughly <reset> and carry on with what I can").
    const hold = usageHold();
    if (hold.held) {
      if (!usageHeldSince) {
        usageHeldSince = Date.now();
        logEvent('ERR', `Every Claude account is usage-limited — dispatch HELD until ${hold.at}`);
        console.warn(`[orchestrator] dispatch held: all Claude accounts exhausted until ${hold.at}`);
      }
      return;
    }
    if (usageHeldSince) {
      console.log(`[orchestrator] Claude accounts usable again after ${Math.round((Date.now() - usageHeldSince) / 60000)}m — resuming dispatch`);
      logEvent('JOB', 'Claude usage limits reset — dispatch resumed');
      usageHeldSince = null;
    }

    // Auth gate (2026-08-19): while EVERY login has been seen failing to
    // authenticate, a spawn is a guaranteed 2-second exit 1 — and until today
    // that exit marked the job FAILED and lost the task. Park instead. The
    // cooldown is short (15 min) so a `claude login` is picked up promptly;
    // claude-auth owns the alerting, this gate only stops the burn.
    const ahold = authHold();
    if (ahold.held) {
      if (!authHeldSince) {
        authHeldSince = Date.now();
        logEvent('ERR', `No Claude login can authenticate — dispatch HELD, next probe ${ahold.at}`);
        console.warn(`[orchestrator] dispatch held: no Claude login authenticates; re-probe at ${ahold.at}`);
      }
      return;
    }
    if (authHeldSince) {
      console.log(`[orchestrator] a Claude login is usable again after ${Math.round((Date.now() - authHeldSince) / 60000)}m — resuming dispatch`);
      logEvent('JOB', 'Claude login usable again — dispatch resumed');
      authHeldSince = null;
    }

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

    // executor='pc' jobs are PULLED by the Windows worker via POST /worker/claim
    // (it may be asleep, offline, or mid-job) — the scheduler never starts them
    // itself. reapExpiredPcLeases() (run at the TOP of this tick) is their only
    // path back to 'queued'.
    const toStart = queued
      .filter(r => r.executor !== 'pc')
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

/**
 * Reap a local/remote job that is still marked `running` long after its own
 * worker must have died.
 *
 * The gap this closes (from the 2026-07-26 audit backlog): if jarvis-memory
 * hiccups at the exact moment finishJob() writes the completion, the status
 * update is lost and the row stays `running` FOREVER. recoverInterruptedJobs()
 * doesn't help — it only runs at boot, and the orchestrator never restarted.
 * Nothing else notices, and the consequences are quiet and serious:
 *   - self-heal's anyJobInFlight() and audit-runner's hasJobInFlight() both see
 *     a live job for that platform and refuse to dispatch, so the platform can
 *     never be auto-repaired again;
 *   - the concurrency slot is consumed permanently, shrinking MAX_CONCURRENT_JOBS
 *     for the rest of the process's life.
 *
 * The rule is safe because spawnProcess GUARANTEES the worker is dead: it
 * SIGTERMs at timeout_min and SIGKILLs 10s later. So once a job is past its own
 * timeout plus a slack margin, either the status write was lost or the process
 * vanished without settling. Either way there is nothing left to wait for.
 *
 * That guarantee has ONE exception, and it was live for seven hours before the
 * code-health spine caught it (2026-07-30): spawnClaude retries once on a
 * usage-limit account flip, a second full-length window under the same row. With
 * started_at unmoved, this reaper would fail a job that was legitimately still
 * running — killing the alert's credibility along with the job's status. That is
 * why runLocalJob now passes onRetry and restarts the clock; this rule depends on
 * started_at describing the run ACTUALLY in progress, not the first one.
 *
 * tryTransition(..., from: 'running') means a genuine late completion still wins
 * the race — the reaper can never overwrite a real result.
 */
async function reapOverdueRunningJobs() {
  let running;
  try { running = await dbGet('/memory/jobs?status=running&limit=200'); }
  catch { return; }
  const now = Date.now();
  for (const row of running) {
    if (row.executor === 'pc') continue;        // reapExpiredPcLeases owns those
    if (!row.started_at) continue;              // never actually started; boot recovery's problem
    const limitMin = Number(row.timeout_min) > 0 ? Number(row.timeout_min) : 30;
    const ranMin = Math.round((now - new Date(row.started_at).getTime()) / 60_000);
    const overdueMin = ranMin - limitMin;
    if (!Number.isFinite(overdueMin) || overdueMin < REAP_SLACK_MIN) continue;

    const ok = await tryTransition(row.id, 'failed', 'reaped: overdue, no completion ever recorded', {
      finished_at: new Date().toISOString(),
      error: `Reaped after ${ranMin} min. The worker is killed at ${limitMin} min, so ${overdueMin} min past ` +
        `that its process is certainly gone and no completion was ever written — most likely a lost status ` +
        `update (memory-server hiccup) or a process that died without settling.`,
    }, 'running');
    if (!ok) continue;                          // a real completion landed first

    logEvent('WARN', `Reaped zombie job ${row.id.slice(0, 8)} on ${row.platform} — ${overdueMin}m past its ${limitMin}m timeout`);
    console.warn(`[orchestrator] reaped zombie job ${row.id} (${row.platform}) — ${overdueMin}m overdue`);
    notify({
      source: 'orchestrator',
      level: 'warn',
      title: `Reaped a stuck job on ${row.platform}`,
      body: `Job ${row.id.slice(0, 8)} sat "running" ${overdueMin} min past its ${limitMin} min timeout with no ` +
        `result recorded, so its worker is gone. While it looked live, self-heal and the audit runner would both ` +
        `have refused to touch ${row.platform} — that block is now lifted. Task: ${(row.task || '').slice(0, 160)}`,
      speech: `Sir, I cleared a stuck job on ${row.platform}. It had been holding that platform's repairs back.`,
    }).catch(() => {});
  }
}

// A claimed PC job whose lease expired means the worker went to sleep, lost
// the tailnet, or crashed mid-job — put it back in the queue (or fail it if
// out of attempts) exactly like the boot-recovery path does for a restart.
async function reapExpiredPcLeases() {
  let running;
  try { running = await dbGet('/memory/jobs?status=running&limit=200'); }
  catch { return; }
  const now = new Date().toISOString();
  for (const row of running) {
    if (row.executor !== 'pc' || !row.lease_until || row.lease_until > now) continue;
    const ok = await tryTransition(row.id, 'interrupted', 'pc worker lease expired', {}, 'running');
    if (!ok) continue; // a heartbeat/result won the race first
    logEvent('WARN', `PC job ${row.id.slice(0, 8)} lease expired (worker ${row.worker_id || '?'}) — re-queuing`);
    if (row.attempts < row.max_attempts) {
      await jobTransition(row.id, 'queued', `re-queued after lease expiry (attempt ${row.attempts}/${row.max_attempts})`);
    } else {
      await jobTransition(row.id, 'failed', 'pc worker lease expired, attempts exhausted', {
        finished_at: new Date().toISOString(),
        error: 'PC worker lost the job lease and attempts are exhausted',
      });
      notify({
        source: 'orchestrator', level: 'warn',
        title: `PC job failed — worker unreachable`,
        body: `Job ${row.id.slice(0, 8)} (${row.task?.slice(0, 100)}) lost its lease and had no attempts left.`,
      }).catch(() => {});
    }
  }
}

// ── PC worker endpoints (pull-based dispatch, loopback-only) ────────────────
// Reached via the gateway's tailnet-authenticated proxy (POST /worker/* on
// :9208, JARVIS_WORKER_TOKEN) — this service itself binds 127.0.0.1 only, so
// no separate auth check is needed here (same trust boundary as /dispatch).

// POST /worker/claim { worker_id }
// Atomically claims the oldest queued executor='pc' job, or 204 when none.
app.post('/worker/claim', asyncRoute(async (req, res) => {
  const workerId = (req.body && req.body.worker_id) || 'unknown';
  // Optional runtime filter (2026-07-31). The worker runs ONE agent job at a
  // time — correct, it is Craig's own machine — but a typed action takes
  // milliseconds and must not queue behind a 20-minute diagnostic, or "restart
  // the worker service" is unanswerable again for exactly as long as Jarvis is
  // busy being useful elsewhere. The worker's fast lane asks for 'action' only.
  const wantRuntime = req.body && req.body.runtime;
  const enabled = await pcWorkerEnabled();
  if (!enabled) return res.status(204).end();
  // Long-poll (2026-08-19, audit move 41): `wait` seconds (≤ 25) holds this
  // request open until a job appears — woken the instant /pc/action enqueues
  // one — instead of the worker asking every 3 s and paying up to 3 s of
  // latency on every typed action (~40k idle requests a day across the three
  // loops). Same protocol otherwise; an old worker sends no `wait` and gets the
  // old behaviour. Capped well under the worker's 20 s fetch timeout… no: the
  // worker raises its timeout to wait+10 s when it asks to wait.
  const waitMs = Math.min(Math.max(Number(req.body?.wait) || 0, 0), 25) * 1000;
  const deadline = Date.now() + waitMs;
  for (;;) {
    let candidates;
    try {
      candidates = await dbGet('/memory/jobs?status=queued&executor=pc&limit=20');
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (wantRuntime) candidates = candidates.filter(r => (r.runtime || 'claude') === wantRuntime);
    candidates.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
    const leaseUntil = new Date(Date.now() + PC_LEASE_MS).toISOString();
    for (const row of candidates) {
      const ok = await tryTransition(row.id, 'running',
        `claimed by ${workerId}`,
        { started_at: new Date().toISOString(), attempts: row.attempts + 1, worker_id: workerId, lease_until: leaseUntil },
        'queued');
      if (!ok) continue; // another claim/reap beat us to this one — try the next
      logEvent('DISPATCH', `PC job ${row.id.slice(0, 8)} claimed by ${workerId}`);
      return res.json({
        id: row.id, task: row.task, prompt: row.prompt, path: row.path,
        // runtime tells the worker HOW to run this: 'claude' (spawn an agent) or
        // 'action' (a typed verb from lib/pc-actions.js, run directly). Without
        // it every action job would be handed to the agent path as a prompt.
        runtime: row.runtime, timeout_min: row.timeout_min, model: row.model,
        lease_seconds: PC_LEASE_MS / 1000,
      });
    }
    const left = deadline - Date.now();
    if (left <= 0 || req.socket.destroyed) return res.status(204).end();
    // Sleep until woken by an enqueue, or 2 s, whichever first.
    await new Promise(r => { const t = setTimeout(() => { pcWake.off('job', on); r(); }, Math.min(left, 2000)); const on = () => { clearTimeout(t); r(); }; pcWake.once('job', on); });
  }
}));

// POST /worker/heartbeat { worker_id, job_id? }
// Keeps the worker's presence known and, when it holds a job, extends the
// lease so the reaper doesn't reclaim work still genuinely in progress.
app.post('/worker/heartbeat', async (req, res) => {
  const { worker_id, job_id, elevated, host } = req.body || {};
  const seenAt = new Date().toISOString();
  await dbPost('/memory/kv', { key: `pc-worker-last-seen:${worker_id || 'unknown'}`, value: seenAt }).catch(() => {});
  // Canonical "the PC checked in" key. The per-worker key above cannot be read
  // back by the server (the id is hostname-derived and the KV API has no
  // prefix scan), and /pc/status has to answer "is his PC there?".
  await dbPost('/memory/kv', { key: 'pc-worker-last-seen', value: seenAt }).catch(() => {});
  // What the PC can actually DO, recorded where the brain can read it — so
  // Jarvis can say "I can't restart services, the worker isn't elevated"
  // BEFORE promising a restart, instead of discovering it in a failed job.
  if (elevated !== undefined) {
    // `verbs` (2026-08-10): which typed actions the worker's own copy of
    // pc-actions.js knows. Absent from an older worker's heartbeat — that is
    // itself information (workerKnowsVerb gives it the benefit of the doubt).
    const verbs = Array.isArray(req.body?.verbs)
      ? req.body.verbs.slice(0, 64).map(v => String(v).slice(0, 60))
      : undefined;
    await dbPost('/memory/kv', {
      key: 'pc-worker-capability',
      value: JSON.stringify({ worker_id: worker_id || 'unknown', host: host || null, elevated: !!elevated, verbs, at: new Date().toISOString() }),
    }).catch(() => {});
  }
  // job_ids (plural) because the worker can hold an agent job and a fast-lane
  // action at the same time. Renewing only one would let the reaper reclaim
  // work that is genuinely still running. job_id stays accepted for an older
  // worker that has not been updated yet.
  const held = [...(Array.isArray(req.body?.job_ids) ? req.body.job_ids : []), job_id].filter(Boolean);
  for (const id of held) {
    await jobTransition(id, 'running', 'lease renewed', { lease_until: new Date(Date.now() + PC_LEASE_MS).toISOString() }, 'running').catch(() => {});
  }
  res.json({ enabled: await pcWorkerEnabled() });
});

// ── POST /pc/action — typed control of Craig's PC ───────────────────────────
// { verb, args?, wait_seconds?, timeout_min?, enqueued_by? }
//
// Enqueues an executor='pc', runtime='action' job that the worker executes as
// PowerShell directly (see src/lib/pc-actions.js). Priority 1: a person is
// waiting on this, so it goes ahead of scheduled paperwork in the claim order.
//
// wait_seconds lets a conversational turn get its ANSWER inline rather than a
// job id — "is Docker running on my PC" should be answered, not tracked. It
// polls the job row; on timeout it returns what it has with status 'pending',
// which is a real outcome (the PC may be asleep), not an error.
//
// This endpoint does NOT decide whether Craig approved anything. The
// confirmation gate lives in lib/conversation.js and is the brain's job — see
// brain-tools.js `pc_control`. Anything reaching here is already authorised.
app.post('/pc/action', async (req, res) => {
  const { verb, args, wait_seconds, timeout_min, confirm } = req.body || {};
  let plan;
  try {
    plan = planAction(verb, args || {});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  // Server-side confirmation gate (audit move 37). A MUTATING verb must carry a
  // valid, unexpired, unreplayed token bound to this exact {verb, args}, minted
  // by a process that holds JARVIS_PC_CONFIRM_SECRET — the deck/gateway, where a
  // human confirmed it. Spawned agents don't have the secret (claude-auth.js
  // profileEnv strips it), so a prompt-injected fleet agent can no longer POST a
  // shell/restart/kill here. Read-only verbs carry no token and skip this. If
  // the secret is unset the gate fails CLOSED for mutations (verifyConfirm →
  // no-secret) rather than silently allowing them.
  if (plan.mutates) {
    const v = verifyConfirm(PC_CONFIRM_SECRET, confirm, verb, args || {});
    if (!v.ok) {
      logEvent('ERR', `PC action ${verb} REFUSED — ${v.reason} (no valid confirmation)`);
      return res.status(403).json({
        error: `mutating PC action refused: ${v.reason}`,
        remedy: v.reason === 'no-secret'
          ? 'set JARVIS_PC_CONFIRM_SECRET in secrets.env on the deck/gateway/orchestrator'
          : 'a mutating PC action must be confirmed through the conversation gate, not called directly',
      });
    }
    if (pcConfirmSpent.has(v.nonce)) {
      logEvent('ERR', `PC action ${verb} REFUSED — confirmation token replayed`);
      return res.status(409).json({ error: 'mutating PC action refused: confirmation already used' });
    }
    pcConfirmSpent.set(v.nonce, v.exp);
  }

  const capability = await pcWorkerCapability();
  // A verb the connected worker's own table doesn't have is a PERMANENT
  // refusal — it re-validates every job against that table by design, so
  // enqueuing would only manufacture a failed job (41 of them, 2026-08-08→10,
  // before the harvester learned to back off). Refuse up front, remedy
  // included. The error deliberately carries the worker's phrase "unknown PC
  // action" so callers' stale-worker detection fires on this path too.
  if (!workerKnowsVerb(capability, plan.verb)) {
    return res.status(409).json({
      error: `unknown PC action "${plan.verb}" on the connected worker — it is running older code without this verb`,
      remedy: 'restart the JarvisPcWorker scheduled task on the PC so it reloads src/lib/pc-actions.js',
      capability,
    });
  }
  if (plan.needsAdmin && capability && capability.elevated === false) {
    return res.status(409).json({
      error: 'the PC worker is not running elevated, so it cannot control services',
      remedy: 'run scripts/install-pc-worker.ps1 from an admin PowerShell on the PC',
      capability,
    });
  }

  const jobId = randomUUID();
  const encoded = encodeActionJob(plan);
  try {
    await dbPost('/memory/jobs', {
      id: jobId,
      platform: 'craig-pc',
      executor: 'pc',
      runtime: encoded.runtime,
      task: encoded.task,
      prompt: encoded.prompt,
      enqueued_by: (req.body && req.body.enqueued_by) || 'api',
      priority: 1,
      timeout_min: timeout_min ?? 5,
      max_attempts: 1,
    });
  } catch (e) {
    return res.status(500).json({ error: 'failed to enqueue PC action: ' + e.message });
  }
  logEvent('DISPATCH', `PC action ${jobId.slice(0, 8)} queued — ${plan.description}`);
  pcWake.emit('job');   // wake a long-polling worker claim immediately (move 41)

  let waitMs = Math.min(Math.max(Number(wait_seconds) || 0, 0), 120) * 1000;
  if (!waitMs) return res.json({ jobId, status: 'queued', action: plan.verb, description: plan.description });

  // Short-circuit (2026-08-19, move 40): if the worker has not checked in for
  // two minutes the PC is asleep or offline, and waiting the full window only
  // burns half a brain turn (TURN_TIMEOUT is 90 s) on a certainty. Answer
  // "pending" now; the late-result watcher below still speaks it if it lands.
  const seenBefore = await pcWorkerLastSeen();
  const workerOnline = !!(seenBefore && Date.now() - Date.parse(seenBefore) < 120_000);
  if (!workerOnline) waitMs = Math.min(waitMs, 3000);

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    let row;
    try { row = await dbGet(`/memory/jobs/${jobId}`); } catch { continue; }
    if (row.status === 'completed' || row.status === 'failed') {
      return res.json({
        jobId, status: row.status, action: plan.verb, description: plan.description,
        exit_code: row.exit_code, output: row.output || '', error: row.error || null,
      });
    }
  }
  // Not a failure: the PC may simply be asleep. Say which it is — and make sure
  // the answer is never lost: until now a result landing after this window went
  // nowhere (the caller had already been told "pending"). Watch it and speak it.
  const seen = await pcWorkerLastSeen();
  watchPcAction(jobId, plan, (timeout_min ?? 5) * 60_000 + 60_000);
  return res.json({
    jobId, status: 'pending', action: plan.verb, description: plan.description,
    worker_last_seen: seen,
    note: seen && Date.now() - Date.parse(seen) < 120_000
      ? 'the worker is online and should pick this up shortly — I will speak the answer when it lands'
      : 'the PC has not checked in recently — it is probably asleep or offline; the job stays queued and I will speak the answer when it lands',
  });
});

// Late-result delivery for PC actions (2026-08-19, move 40). Dispatch jobs
// have watchJob() in the gateway; typed PC actions had nothing — once the
// /pc/action wait window passed, the answer was silently lost to the
// conversation. One watcher per job; ends on completion or after the job's own
// timeout (+1 min for the lease to expire and the reaper to speak).
const pcWatchers = new Set();
function watchPcAction(jobId, plan, maxMs) {
  if (pcWatchers.has(jobId)) return;
  pcWatchers.add(jobId);
  const deadline = Date.now() + Math.min(maxMs, 30 * 60_000);
  (async () => {
    try {
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        let row;
        try { row = await dbGet(`/memory/jobs/${jobId}`); } catch { continue; }
        if (row.status !== 'completed' && row.status !== 'failed') continue;
        const out = String(row.output || row.error || '').trim();
        const ok = row.status === 'completed' && (row.exit_code == null || row.exit_code === 0);
        const flat = out.replace(/\s+/g, ' ').slice(0, 200);
        await notify({
          source: 'pc', level: ok ? 'info' : 'warn',
          title: `${ok ? '✅' : '❌'} PC answer (late): ${plan.description.split(/\r?\n/)[0].slice(0, 90)}`,
          body: out.slice(0, 3000) || '(no output)',
          speech: ok
            ? `Sir, the PC has answered about ${plan.speech || plan.description}: ${flat.length > 140 ? 'the result is on your screen.' : flat}`
            : `Sir, the PC action — ${plan.speech || plan.description} — failed: ${flat || 'no detail'}`,
        }).catch(() => {});
        return;
      }
    } finally {
      pcWatchers.delete(jobId);
    }
  })();
}

// GET /pc/status — is the PC there, and what can it do?
app.get('/pc/status', async (req, res) => {
  const [seen, capability] = await Promise.all([pcWorkerLastSeen(), pcWorkerCapability()]);
  const ageMs = seen ? Date.now() - Date.parse(seen) : null;
  res.json({
    online: ageMs != null && ageMs < 120_000,
    last_seen: seen,
    seconds_since_seen: ageMs == null ? null : Math.round(ageMs / 1000),
    elevated: capability ? capability.elevated : null,
    host: capability ? capability.host : null,
    enabled: await pcWorkerEnabled(),
  });
});

// The per-worker key is `pc-worker-last-seen:<worker_id>`, and the worker id is
// hostname-derived — which the server does not know in advance. There is no
// prefix/scan on the KV API (only GET /memory/kv/:key), so the heartbeat also
// stamps this one canonical key. Checked, not assumed: an earlier draft of this
// read a `?prefix=` endpoint that does not exist.
async function pcWorkerLastSeen() {
  try {
    const row = await dbGet('/memory/kv/pc-worker-last-seen');
    return row && row.value ? row.value : null;
  } catch { return null; }
}

async function pcWorkerCapability() {
  try {
    const row = await dbGet('/memory/kv/pc-worker-capability');
    return row && row.value ? JSON.parse(row.value) : null;
  } catch { return null; }
}

// POST /worker/result { job_id, worker_id, code, stdout, stderr, timedOut }
app.post('/worker/result', asyncRoute(async (req, res) => {
  const { job_id, worker_id, code, stdout = '', stderr = '', timedOut = false } = req.body || {};
  if (!job_id) return res.status(400).json({ error: 'job_id required' });
  let row;
  try { row = await dbGet(`/memory/jobs/${job_id}`); }
  catch { return res.status(404).json({ error: 'Job not found' }); }
  // Ownership guard (2026-07-26 security fix): this had no check at all that
  // the caller actually claimed this job — any holder of JARVIS_WORKER_TOKEN
  // could post a fabricated result for ANY job (including in-flight SSH/local
  // jobs against real fleet platforms), flipping platform_state's health
  // status and injecting attacker-controlled text into Slack/voice
  // notifications via finishJob()'s notify() fan-out. Only the 'pc' executor
  // path uses this endpoint at all, and only the worker that actually holds
  // the current lease (worker_id set by /worker/claim) may report its result.
  if (row.executor !== 'pc') return res.status(403).json({ error: 'not a pc-executor job' });
  if (row.worker_id && worker_id && row.worker_id !== worker_id) {
    return res.status(403).json({ error: 'worker_id does not hold this job\'s lease' });
  }

  // A LATE result is accepted, not thrown away (2026-07-30, found by the
  // code-health spine's money-paths lens).
  //
  // The lease is 2 minutes and the worker renews it on a 30s heartbeat whose
  // failures are only logged — nothing tells the worker it lost the lease, and
  // the local `claude --print` keeps running for up to timeout_min. So any
  // network gap over ~2 minutes (laptop sleep, wifi roam, tailscale restart —
  // all routine) had the reaper re-queue the job while the PC was still working
  // on it. When that run finished and reported, the row was 'queued', this
  // handler returned 409, and a COMPLETED job's output was discarded with one log
  // line on the PC — and the worker's next poll re-claimed the same job and ran
  // it again, billing Craig's subscription twice for one piece of work.
  //
  // Accepting the late result also removes the second run: the job is completed
  // before the next poll can re-claim it.
  //
  // Security: the ownership guard above still applies and is now REQUIRED for
  // this path — only the worker recorded as the lease holder may report, and the
  // reaper deliberately leaves worker_id in place when it re-queues.
  if (row.status === 'queued') {
    if (!worker_id || row.worker_id !== worker_id) {
      return res.status(409).json({ error: 'job was re-queued and you are not its recorded worker' });
    }
    // Guarded: if the scheduler or another claim moved it first, that run owns it.
    const claimed = await tryTransition(row.id, 'running', 'late result from the original worker — reclaiming to finish', {}, 'queued');
    if (!claimed) return res.status(409).json({ error: 'job was re-claimed while your result was in flight' });
    logEvent('JOB', `Late PC result accepted for ${row.id.slice(0, 8)} (${worker_id}) — saved a duplicate paid run`);
    console.log(`[orchestrator] accepted a late result for ${row.id} from ${worker_id} — the job had been re-queued after a lease expiry`);
  } else if (row.status !== 'running') {
    return res.status(409).json({ error: `job is not running (status=${row.status})` });
  }

  await finishJob(row, { code, stdout, stderr, timedOut });
  res.json({ ok: true });
}));

async function pcWorkerEnabled() {
  try {
    const r = await dbGet('/memory/kv/pc-worker-enabled');
    return r.value !== '0';
  } catch { return true; } // no KV entry yet = enabled by default
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
app.post('/dispatch', internalGuard, async (req, res) => {
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
        // 8, not 5 (2026-07-26): the scheduler sorts by priority ASC with only
        // MAX_CONCURRENT_JOBS slots, and scheduled role agents used to enter at
        // the SAME priority as an emergency repair. Five accountant agents with
        // 30-minute timeouts could therefore hold a self-heal repair for a
        // genuinely DOWN production site in the queue behind them. Routine
        // scheduled paperwork must always yield to fleet work.
        priority: role.priority ?? 8,
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

  // Choose the executor. With JARVIS_CLOUD_ENABLED unset, pickExecutor returns
  // exactly the legacy result: 'local' for OWN_IP, 'remote' otherwise.
  const executor = pickExecutor(platform, entry, task, requestedExecutor);
  const prompt = buildPrompt(platform, task, isLocal ? entry.path : null, executor);

  const designRefs = isLocal ? loadDesignRefs(entry.path) : [];
  if (designRefs.length > 0) {
    console.log(`[orchestrator] design-refs for ${platform}: ${designRefs.length} file(s)`);
    logEvent('DESIGN', `Found ${designRefs.length} design ref(s) for ${platform}`);
  }

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
// X-Jarvis-Token header, which must equal the PER-JOB token minted for that job
// id at dispatch (memory KV `cloud-callback-token:<jobId>`). Harmless when
// unused: with no such key, every request is rejected with 401.
app.post('/dispatch/callback', async (req, res) => {
  const provided = req.header('X-Jarvis-Token');
  const { jobId, ok, summary } = req.body || {};
  if (!provided) return res.status(401).json({ error: 'unauthorized' });
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  // Per-job token (2026-07-30). The master JARVIS_CLOUD_TOKEN is no longer
  // accepted here: it used to be embedded in the prompt sent to a third-party
  // provider, so accepting it meant a leaked prompt could falsify ANY job. A
  // callback now proves it holds the credential issued for THAT job.
  let expected = null;
  try {
    expected = (await dbGet(`/memory/kv/cloud-callback-token:${jobId}`))?.value || null;
  } catch { /* absent or unreachable — treated as unauthorised below */ }
  if (!expected || provided !== expected) {
    console.warn(`[orchestrator] cloud callback REFUSED for ${String(jobId).slice(0, 8)} — bad or missing per-job token`);
    return res.status(401).json({ error: 'unauthorized' });
  }

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

// ── Loop detection (2026-07-20, Craig's "scan for loops" ask) ────────────────
// Catches Jarvis's OWN dispatched work getting stuck re-doing the same thing
// without ever landing — the failure mode found the same session in an
// unrelated Anthropic cloud routine (a PR check-in that self-re-armed
// hourly for 147+ hours without progress). This is the on-box analogue for
// orchestrator jobs: if a platform has repeated dispatches recently and NONE
// of them ever reached 'completed', that's a stuck loop, not just a busy
// platform. (Platform-side flapping/instability is fleet-check.sh's job —
// see its STATE_DIR flap counter — surfaced together via get_loop_alerts in
// brain-tools.js.)
const LOOP_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h lookback
const LOOP_MIN_COUNT = 3;                   // this many dispatches to the same platform...
async function detectLoops() {
  const rows = await dbGet('/memory/jobs?limit=300');
  const cutoff = Date.now() - LOOP_WINDOW_MS;
  const byPlatform = new Map();
  for (const r of rows) {
    if (!r.platform || r.platform === 'auto') continue;
    if (new Date(r.created_at).getTime() < cutoff) continue;
    if (!byPlatform.has(r.platform)) byPlatform.set(r.platform, []);
    byPlatform.get(r.platform).push(r);
  }
  const loops = [];
  for (const [platform, jobs] of byPlatform) {
    if (jobs.length < LOOP_MIN_COUNT) continue;
    const everCompleted = jobs.some(j => j.status === 'completed');
    if (everCompleted) continue; // it eventually landed — not stuck, just busy
    loops.push({
      platform,
      count: jobs.length,
      window_hours: LOOP_WINDOW_MS / 3600000,
      statuses: [...new Set(jobs.map(j => j.status))],
      tasks: jobs.slice(0, 5).map(j => j.task),
    });
  }
  return loops;
}

// GET /jobs/loops — platforms with repeated recent dispatches, none completed
app.get('/jobs/loops', async (_req, res) => {
  try {
    res.json({ loops: await detectLoops() });
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
  const limit = clampLimit(req.query.limit, 50, 200);
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

async function slackSend(text, level = 'warning', key = null) {
  try {
    await fetch(`${SLACK_BRIDGE}/slack/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, level, key }),
    });
  } catch (e) {
    console.error('[cron] notify failed:', e.message);
  }
}

async function cronDailyAudit() {
  logEvent('CRON', 'Daily audit sprint starting — scanning all platforms');
  const registry = loadRegistry();
  // 'jarvis' (meta-platform) and 'pc'-executor worker nodes (Craig's own
  // machine — no repo, no build/deploy, nothing a web audit can score) are
  // not audit targets.
  const names = Object.keys(registry).filter(p => p !== 'jarvis' && registry[p]?.executor !== 'pc');

  // /audit/run is fire-and-forget (audit-runner responds before the audit
  // finishes), so there are no scores to report from here. Per-platform
  // results arrive via audit-runner's own /slack/report calls, which the
  // bridge levels by status (healthy → digest, warning/critical → posted).
  // This cron therefore sends at most ONE message — and only on failure.
  // The old version posted one line per platform every morning, always
  // showing "score ?/100" because of the async response. Pure spam.
  let triggered = 0;
  const skipped = [];
  const failures = [];
  for (const platform of names) {
    try {
      logEvent('CRON', `Audit: ${platform}`);
      const r = await fetch(`${AUDIT}/audit/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      const data = await r.json();
      if (data.error) skipped.push(platform);  // no audit config — not a failure
      else triggered++;
    } catch (e) {
      failures.push(`${platform}: ${e.message}`);
    }
  }
  if (failures.length) {
    await slackSend(
      `❌ Daily audit sprint — could not start audits for:\n${failures.map(f => `• ${f}`).join('\n')}`,
      'warning',
      'cron-daily-audit',
    );
  }
  logEvent('CRON', `Daily audit sprint: ${triggered} triggered, ${skipped.length} unconfigured, ${failures.length} failed`);
}

async function cronDailyScreenshots() {
  logEvent('CRON', 'Daily screenshot baseline run starting');
  const PLATFORM_URLS = {
    zoobicon: 'https://zoobicon.com',
    vapron:   'https://vapron.ai',
    alecrae:  'https://alecrae.com',
    gatetest: 'https://gatetest.ai',
    voxlen:   'https://www.voxlen.ai',
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
  await slackSend(
    `📸 Daily screenshot baselines captured for ${Object.keys(PLATFORM_URLS).length} platforms`,
    'info',
    'cron-daily-screenshots',
  );
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

// Loop watch — periodic check, notify only when a platform NEWLY enters the
// stuck-loop set (not every tick — that would just be the DavenRoe problem
// again, wearing a Jarvis badge). Clears from notifiedLoops once it drops out
// of the detected set so a genuinely recurring issue can re-alert later.
const notifiedLoops = new Set();
setInterval(async () => {
  try {
    const loops = await detectLoops();
    const current = new Set(loops.map(l => l.platform));
    for (const l of loops) {
      if (notifiedLoops.has(l.platform)) continue;
      notifiedLoops.add(l.platform);
      notify({
        source: 'orchestrator-loopwatch', level: 'warn',
        title: `🔁 Possible stuck loop: ${l.platform}`,
        body: `${l.count} dispatches to ${l.platform} in the last ${l.window_hours}h, none completed. Statuses seen: ${l.statuses.join(', ')}.`,
        speech: `Sir, ${l.platform} looks stuck — ${l.count} attempts in the last ${l.window_hours} hours with nothing landing.`,
      }).catch(() => {});
    }
    for (const p of [...notifiedLoops]) if (!current.has(p)) notifiedLoops.delete(p);
  } catch (e) { console.error('[loopwatch] check failed:', e.message); }
}, 30 * 60 * 1000);

logEvent('SYS', 'Orchestrator initialized — ready to dispatch agents');

app.listen(PORT, '127.0.0.1', async () => {
  console.log(`[orchestrator] listening on http://127.0.0.1:${PORT}`);
  await recoverInterruptedJobs();
  setInterval(schedulerTick, SCHEDULER_TICK_MS);
  setInterval(fireDueReminders, 30_000);   // the memory pen's alarm (move 14)
  console.log(`[orchestrator] scheduler running (tick ${SCHEDULER_TICK_MS}ms, max ${MAX_CONCURRENT_JOBS} concurrent)`);
});

// Deliver reminders that have come due (2026-08-19, move 14). The orchestrator
// is always up and already owns notify(), which speaks + inboxes + pushes — so
// a reminder reaches Craig even with no deck open. Marks each fired so it goes
// out exactly once.
async function fireDueReminders() {
  let due;
  try { due = await dbGet('/memory/reminders?status=pending&due=1&limit=20'); }
  catch { return; }
  for (const r of (due?.reminders || [])) {
    try {
      await notify({
        source: 'reminder', level: 'warn',
        title: `⏰ Reminder: ${String(r.text).slice(0, 100)}`,
        body: r.text,
        speech: `Sir, a reminder: ${r.text}`,
      });
      await dbPost(`/memory/reminders/${r.id}/fired`, {});
    } catch (e) { console.error('[orchestrator] reminder fire failed:', e.message); }
  }
}

/**
 * pc-worker.js — Jarvis worker node for Craig's own Windows PC.
 *
 * Runs ONLY on the PC (not the fleet box). Registers with the orchestrator's
 * pull-based worker API over the tailnet (via the gateway's authenticated
 * proxy) and executes claimed jobs by spawning the PC's own `claude` CLI —
 * billing the PC's own claude.ai subscription login, never the server's.
 *
 * PULL, not PUSH: the PC sleeps, reboots, and roams networks. It asks the
 * server for work when it's awake and online; the server never needs to
 * reach the PC (no inbound listener here, no port opened, no PC credentials
 * held server-side — see config/pc-worker.env.example for the one bearer
 * token this needs).
 *
 * Kill switches (any one stops execution immediately):
 *   1. Server-side: memory KV `pc-worker-enabled` = '0' (voice: "Jarvis,
 *      disable the PC worker") — claim/heartbeat both report enabled:false.
 *   2. Local file: %ProgramData%\jarvis\KILL — checked every poll.
 *   3. Revoke JARVIS_WORKER_TOKEN on the server — every request 403s.
 */

import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import os from 'os';

function loadEnvFile(p) {
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const envFile = loadEnvFile(path.join(process.cwd(), 'config', 'pc-worker.env'));
const cfg = { ...envFile, ...process.env };

const GATEWAY_URL   = cfg.JARVIS_GATEWAY_URL || 'https://jarvis.tailbd6217.ts.net:8443';
const WORKER_TOKEN  = cfg.JARVIS_WORKER_TOKEN || '';
const WORKER_ID     = cfg.WORKER_ID || `pc-${os.hostname()}`;
const WORKSPACE_ROOT = path.resolve(cfg.WORKSPACE_ROOT || 'C:\\dev');
const POLL_MS       = Number(cfg.POLL_MS) || 10_000;
const HEARTBEAT_MS  = Number(cfg.HEARTBEAT_MS) || 30_000;
const DEFAULT_TIMEOUT_MIN = Number(cfg.TIMEOUT_MIN) || 30;
const KILL_FILE     = cfg.KILL_FILE || path.join(process.env.ProgramData || 'C:\\ProgramData', 'jarvis', 'KILL');

if (!WORKER_TOKEN) {
  console.error('[pc-worker] JARVIS_WORKER_TOKEN not set (config/pc-worker.env or env var) — refusing to start.');
  process.exit(1);
}

function log(msg) { console.log(`[pc-worker] ${new Date().toISOString()} ${msg}`); }

async function api(action, body) {
  const r = await fetch(`${GATEWAY_URL}/worker/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jarvis-Worker-Token': WORKER_TOKEN },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`${action} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function killed() {
  try { return existsSync(KILL_FILE); } catch { return false; }
}

let currentJobId = null;
let heartbeatTimer = null;

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    api('heartbeat', { worker_id: WORKER_ID, job_id: currentJobId })
      .catch(e => log(`heartbeat failed: ${e.message}`));
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// Run `claude --print` on the PC's own login (whatever account is signed in
// under this Windows user's %USERPROFILE%\.claude — never IS_SANDBOX/HOME
// overrides, this is not root and not the server's env).
function runClaude(prompt, cwd, timeoutMin) {
  return new Promise((resolve) => {
    // claude ships as claude.cmd on Windows — needs a shell to resolve it.
    const proc = spawn('claude', ['--dangerously-skip-permissions', '--print', prompt], {
      cwd, shell: true,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']); } catch {}
    }, timeoutMin * 60_000);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const settle = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({ code, stdout: stdout.slice(-4000), stderr: (err ? err + '\n' + stderr : stderr).slice(-2000), timedOut });
    };
    proc.on('close', code => settle(code));
    proc.on('error', err => settle(null, err.message));
  });
}

async function runJob(job) {
  currentJobId = job.id;
  log(`claimed job ${job.id.slice(0, 8)}: ${String(job.task).slice(0, 100)}`);

  // Never let a claimed job cd outside the sanctioned workspace, even if the
  // dispatcher supplied an odd path.
  const cwd = job.path ? path.resolve(job.path) : WORKSPACE_ROOT;
  if (!cwd.toLowerCase().startsWith(WORKSPACE_ROOT.toLowerCase())) {
    await api('result', { job_id: job.id, code: 1, stdout: '', stderr: `refused: path ${cwd} is outside workspace root ${WORKSPACE_ROOT}`, timedOut: false });
    currentJobId = null;
    return;
  }

  const result = await runClaude(job.prompt || job.task, cwd, job.timeout_min || DEFAULT_TIMEOUT_MIN);
  log(`job ${job.id.slice(0, 8)} finished — exit ${result.code}${result.timedOut ? ' (TIMEOUT)' : ''}`);
  await api('result', { job_id: job.id, ...result }).catch(e => log(`result post failed: ${e.message}`));
  currentJobId = null;
}

async function pollOnce() {
  if (killed()) return; // local kill switch — stay quiet, don't even heartbeat
  let job;
  try { job = await api('claim', { worker_id: WORKER_ID }); }
  catch (e) { log(`claim failed: ${e.message}`); return; }
  if (job) await runJob(job);
}

// Exponential backoff on repeated failures (tailnet down, gateway restarting)
// so a dead network doesn't spin the loop.
let backoffMs = POLL_MS;
async function loop() {
  if (killed()) {
    log('local KILL file present — idling');
    setTimeout(loop, POLL_MS);
    return;
  }
  try {
    await pollOnce();
    backoffMs = POLL_MS;
  } catch (e) {
    backoffMs = Math.min(backoffMs * 2, 5 * 60_000);
    log(`poll error, backing off to ${Math.round(backoffMs / 1000)}s: ${e.message}`);
  }
  setTimeout(loop, backoffMs);
}

log(`starting — worker_id=${WORKER_ID} gateway=${GATEWAY_URL} workspace=${WORKSPACE_ROOT}`);
startHeartbeat();
loop();

process.on('SIGINT', () => { stopHeartbeat(); process.exit(0); });
process.on('SIGTERM', () => { stopHeartbeat(); process.exit(0); });

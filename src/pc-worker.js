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
import { existsSync, readFileSync, statSync, readdirSync } from 'fs';
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
//
// claude ships as claude.cmd on Windows, which only cmd.exe can execute
// directly — that needs shell:true. But shell:true + an ARGS ARRAY is a
// documented Node foot-gun (and an explicit deprecation warning): the args
// get joined with spaces and re-tokenized by cmd.exe, silently mangling any
// prompt containing punctuation cmd treats specially. A prompt with a colon
// and periods was observed splitting apart and reaching claude as an empty
// stdin, so it replied with its generic no-input greeting instead of running
// the task. Fix: build ONE command string ourselves with JSON.stringify()
// (produces a well-formed double-quoted, backslash-escaped token both cmd.exe
// and the underlying argv parser accept) and pass that single string with
// shell:true — Node's documented-safe form.
function runClaude(prompt, cwd, timeoutMin) {
  return new Promise((resolve) => {
    const cmdStr = 'claude --dangerously-skip-permissions --print ' + JSON.stringify(prompt);
    const proc = spawn(cmdStr, {
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

// Bounded recursive mtime snapshot — used to tell Craig WHAT a PC job
// touched. Deliberately a listing, not a content upload (that needs a real
// artifact store, tracked separately) — but a listing already answers "did
// it actually make the file it said it would" without him having to go
// check the machine himself. Skips node_modules/.git/hidden dirs; caps
// depth and count so a big repo doesn't turn a job report into a novel.
const SNAPSHOT_SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build']);
function snapshotFiles(root, maxEntries = 5000, maxDepth = 8) {
  const out = new Map(); // path -> mtimeMs
  const stack = [[root, 0]];
  while (stack.length && out.size < maxEntries) {
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || SNAPSHOT_SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) stack.push([full, depth + 1]); continue; }
      try { out.set(full, statSync(full).mtimeMs); } catch { /* transient */ }
      if (out.size >= maxEntries) break;
    }
  }
  return out;
}
function diffChangedFiles(before, after, cap = 25) {
  const changed = [];
  for (const [p, mtime] of after) {
    if (!before.has(p) || before.get(p) !== mtime) changed.push(p);
    if (changed.length >= cap) break;
  }
  return changed;
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

  const before = snapshotFiles(cwd);
  const result = await runClaude(job.prompt || job.task, cwd, job.timeout_min || DEFAULT_TIMEOUT_MIN);
  const changed = diffChangedFiles(before, snapshotFiles(cwd));
  log(`job ${job.id.slice(0, 8)} finished — exit ${result.code}${result.timedOut ? ' (TIMEOUT)' : ''}${changed.length ? `, ${changed.length} file(s) touched` : ''}`);

  // File LISTING only, not content upload (that needs a real artifact store
  // — tracked separately). Still answers "did it actually make what it
  // said" without Craig having to go check the PC himself. Appended to
  // stdout so it survives through the existing job.output column with no
  // schema change.
  const stdout = changed.length
    ? `${result.stdout}\n\n[pc-worker] files touched under ${cwd}:\n${changed.map(f => '  ' + path.relative(cwd, f)).join('\n')}`
    : result.stdout;

  await api('result', { job_id: job.id, ...result, stdout }).catch(e => log(`result post failed: ${e.message}`));
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

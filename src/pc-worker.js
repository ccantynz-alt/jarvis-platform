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
import { pathToFileURL } from 'url';
import { decodeActionJob, buildPowerShellArgs, cleanStderr, VERBS } from './lib/pc-actions.js';

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
/**
 * Numeric config, the guardrail.js way (2026-07-30) — this file reads its own
 * env FILE rather than process.env, so it can't use lib/guardrail.js directly,
 * but it has the same two hazards:
 *   - `Number(x) || default` throws away a legitimate ZERO. Found the hard way:
 *     WATCHDOG_AFTER_MIN=0 ("alert immediately", which is exactly what a test
 *     wants) silently became 5 minutes, and the watchdog looked broken.
 *   - an inline comment (`POLL_MS=10000 # ms`) makes Number() NaN.
 * So: take the leading token, accept 0, and fall back only when unusable.
 */
function num(name, fallback, { allowZero = true } = {}) {
  const raw = cfg[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim().split(/\s|#/)[0]);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    log(`BAD CONFIG ${name}=${JSON.stringify(raw)} — using ${fallback}`);
    return fallback;
  }
  return n;
}

const POLL_MS       = num('POLL_MS', 10_000, { allowZero: false });
// The fast lane polls harder than the agent lane: an action is a person
// waiting for an answer, and the request is trivial for the server.
const ACTION_POLL_MS = num('ACTION_POLL_MS', 3_000, { allowZero: false });
const HEARTBEAT_MS  = num('HEARTBEAT_MS', 30_000, { allowZero: false });
const DEFAULT_TIMEOUT_MIN = num('TIMEOUT_MIN', 30, { allowZero: false });
const KILL_FILE     = cfg.KILL_FILE || path.join(process.env.ProgramData || 'C:\\ProgramData', 'jarvis', 'KILL');

// Checked at STARTUP, not at import (2026-07-30). This was a module-scope
// process.exit(1), so importing this file killed the importing process — the same
// defect as the loop starting at module scope, fixed earlier the same day and
// missed here. It also hid itself well: this PC has a token in
// config/pc-worker.env, so test/pc-watchdog.test.js passed locally and failed on
// the box, which is the machine deployments are verified on.
// Refusing to start is right for the program; killing a caller is not.
const CONFIGURED = !!WORKER_TOKEN;

function log(msg) { console.log(`[pc-worker] ${new Date().toISOString()} ${msg}`); }

async function api(action, body, timeoutMs = 20_000) {
  const r = await fetch(`${GATEWAY_URL}/worker/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Jarvis-Worker-Token': WORKER_TOKEN },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`${action} → HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function killed() {
  try { return existsSync(KILL_FILE); } catch { return false; }
}

/**
 * Reporting a finished job is the ONE call that must not be given up on after
 * a single try (2026-07-31). Everything else here is idempotent — a failed
 * claim just means we poll again — but the work in a result has ALREADY
 * HAPPENED. Lose it and the job sits `running` until its lease expires, gets
 * re-queued, and RUNS A SECOND TIME: for `service.restart` that is a second
 * restart, and for `shell` it is whatever Craig asked for, twice. Meanwhile
 * Jarvis tells him it failed.
 *
 * Observed for real on the machine this runs on: at 100% CPU the worker's
 * fetch to the gateway failed while plain curl to the same URL succeeded
 * 5-for-5. A loaded PC is the NORMAL case for the box that keeps crashing —
 * which is exactly when Craig most needs the answer to arrive.
 */
async function postResult(body, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await api('result', body);
      if (i > 1) log(`result posted on attempt ${i}`);
      return true;
    } catch (e) {
      if (i === attempts) {
        log(`result post FAILED after ${attempts} attempts: ${e.message} — the server will re-queue this job when the lease expires`);
        return false;
      }
      await new Promise(r => setTimeout(r, 1000 * 2 ** (i - 1))); // 1s, 2s, 4s
    }
  }
  return false;
}

let currentJobId = null;   // the agent job (one at a time — this is his own PC)
let currentActionId = null; // the fast lane: a typed action, runs alongside
let heartbeatTimer = null;

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    // `elevated` rides along so the server — and therefore Jarvis — knows what
    // this machine can actually do BEFORE he promises Craig a service restart.
    // Both held jobs are renewed: renewing only one would let the reaper
    // reclaim work that is still genuinely running.
    api('heartbeat', {
      worker_id: WORKER_ID,
      job_id: currentJobId,
      job_ids: [currentJobId, currentActionId].filter(Boolean),
      elevated: isElevated,
      host: os.hostname(),
      // The verbs THIS worker's copy of the table actually knows. The server
      // uses this to refuse a dispatch up front (with the remedy in the error)
      // instead of manufacturing a job this worker will permanently refuse —
      // the 2026-08-08→10 harvest.list loop, 41 failed jobs from one missing
      // worker restart.
      verbs: Object.keys(VERBS),
    }).catch(e => log(`heartbeat failed: ${e.message}`));
  }, HEARTBEAT_MS);
  heartbeatTimer.unref?.();
}
function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

// Run `claude --print` on the PC's own login (whatever account is signed in
// under this Windows user's %USERPROFILE%\.claude — never IS_SANDBOX/HOME
// overrides, this is not root and not the server's env).
//
// claude ships as claude.cmd on Windows, which only cmd.exe can execute
// directly — that needs shell:true.
//
// SECURITY FIX (2026-07-26): this used to embed the prompt directly into the
// shell command string via JSON.stringify() — that only produces valid
// JS-string escaping, NOT cmd.exe escaping. A prompt containing `" & cmd & "`
// closes the quoted region as far as cmd.exe's tokenizer is concerned and
// runs `cmd` as an independent, unquoted command — arbitrary code execution
// on this PC, under Craig's own account. Any text that becomes a pc-executor
// job's prompt/task reaches here, including task text a dispatched agent
// might compose from web content it just fetched. Fixed by passing the
// prompt over stdin instead: the command string below is now a fixed literal
// with nothing untrusted interpolated into it, and `-p/--print` is
// documented as "useful for pipes" — this also sidesteps the earlier
// cmd.exe re-tokenization bug (punctuation in the prompt no longer touches
// the shell's argument parser at all, since it never becomes an argument).
function runClaude(prompt, cwd, timeoutMin) {
  return new Promise((resolve) => {
    const cmdStr = 'claude --dangerously-skip-permissions --print';
    const proc = spawn(cmdStr, {
      cwd, shell: true,
      env: { ...process.env, DISABLE_AUTOUPDATER: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']); } catch {}
    }, timeoutMin * 60_000);
    proc.stdin.on('error', () => {}); // EPIPE if the process exits before the write lands
    proc.stdin.write(String(prompt), () => proc.stdin.end());
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

// ── Typed actions (2026-07-31) ───────────────────────────────────────────────
//
// A second kind of job, alongside the `claude` agent above: a verb from
// lib/pc-actions.js executed directly by PowerShell. No agent, no subscription
// turn, sub-second. This is what makes "restart the worker service" a sentence
// Jarvis can act on rather than one he has to apologise for.
//
// ELEVATION. Restarting a Windows service needs an administrator token. The
// scheduled task is registered with -RunLevel Highest (scripts/
// install-pc-worker.ps1), but that can silently not be the case — an older
// registration, a task recreated by hand, a different machine. So the worker
// MEASURES it at startup and reports it in every heartbeat, and an admin-only
// verb attempted without it fails with that sentence rather than a raw
// "Access is denied" that nobody can act on.
let isElevated = null;   // null = not yet known

function powershell(script, timeoutMin) {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', buildPowerShellArgs(script), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']); } catch { /* already gone */ }
    }, Math.max(1, timeoutMin) * 60_000);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const settle = (code, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      const cleaned = cleanStderr(err ? err + '\n' + stderr : stderr);
      // stdoutFull is kept ONLY for the screenshot hand-off (never posted as a
      // result); the result itself stays bounded at 8 KB.
      const full = stdout.includes('SCREENSHOT_PNG_B64:') ? stdout.slice(-4_000_000) : undefined;
      resolve({ code, stdout: stdout.slice(-8000), stderr: cleaned.slice(-2000), timedOut, ...(full ? { stdoutFull: full } : {}) });
    };
    proc.on('close', code => settle(code));
    proc.on('error', err => settle(null, err.message));
  });
}

async function detectElevation() {
  const r = await powershell(
    `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()` +
    `).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`, 1);
  isElevated = /true/i.test(r.stdout);
  log(`elevation: ${isElevated ? 'ADMINISTRATOR — service control available' : 'standard user — service control will FAIL (re-run scripts/install-pc-worker.ps1 as admin)'}`);
  return isElevated;
}

async function runAction(job) {
  let plan;
  try {
    plan = decodeActionJob(job);
  } catch (e) {
    return { code: 1, stdout: '', stderr: `refused: ${e.message}`, timedOut: false };
  }
  if (plan.needsAdmin && isElevated === false) {
    // Say the actionable thing. "Access is denied" sends Craig hunting; this
    // names the one command that fixes it.
    return {
      code: 1, stdout: '', timedOut: false,
      stderr: 'refused: this needs an elevated worker and JarvisPcWorker is running as a standard user. ' +
        'Fix: run scripts/install-pc-worker.ps1 from an ADMIN PowerShell on the PC, then restart the task.',
    };
  }
  log(`action ${plan.verb} — ${plan.description}`);
  const r = await powershell(plan.script, job.timeout_min || 5);
  return r;
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

// A screenshot (pc-actions `screen.capture`) cannot ride the 8 KB job output:
// it goes to the gateway's /worker/shot, which stores it and puts it on the
// deck; the job output becomes one line saying so (2026-08-19, move 38).
async function handOffScreenshot(result) {
  const m = /SCREENSHOT_PNG_B64:([A-Za-z0-9+/=]+)/.exec(result.stdoutFull || result.stdout || '');
  if (!m) { const { stdoutFull, ...rest } = result; return rest; }
  const { stdoutFull, ...rest } = result; result = rest;   // never post the full buffer as a result
  try {
    const r = await api('shot', { worker_id: WORKER_ID, png_b64: m[1] });
    const where = r?.shown ? 'shown on the deck now' : 'stored; no deck was open to show it';
    return { ...result, stdout: `Screenshot taken (${Math.round(m[1].length * 0.75 / 1024)} KB) — ${where}. File: ${r?.name || '?'}` };
  } catch (e) {
    return { ...result, code: 1, stdout: '', stderr: `screenshot taken but could not be handed to the gateway: ${e.message}` };
  }
}

async function runActionJob(job) {
  currentActionId = job.id;
  try {
    const result = await handOffScreenshot(await runAction(job));
    log(`action job ${job.id.slice(0, 8)} finished — exit ${result.code}${result.timedOut ? ' (TIMEOUT)' : ''}`);
    await postResult({ job_id: job.id, worker_id: WORKER_ID, ...result });
  } finally {
    currentActionId = null;
  }
}

// The fast lane. Runs on its own timer so a typed action ("restart the worker
// service") is never stuck behind a long agent job — without it, Jarvis is
// unable to act on the PC for exactly as long as he is busy being useful on it,
// which is the complaint this whole change set exists to answer.
// Long-poll (2026-08-19, move 41): the claim is HELD on the server for up to
// ACTION_WAIT_S seconds and woken the instant an action is enqueued, so a typed
// action starts in ~100 ms instead of up to 3 s — and the idle request rate
// drops from 20/min to ~2/min. An older orchestrator ignores `wait` and
// answers at once, which degrades to exactly the old 3-second loop.
const ACTION_WAIT_S = 25;
async function actionPoll() {
  if (killed() || currentActionId) return false;
  const job = await api('claim', { worker_id: WORKER_ID, runtime: 'action', wait: ACTION_WAIT_S }, (ACTION_WAIT_S + 10) * 1000);
  if (job) { await runActionJob(job); return true; }
  return false;
}

async function actionLoop() {
  const t0 = Date.now();
  let failed = false;
  try { await actionPoll(); }
  catch { failed = true; /* the agent loop already reports and backs off; a failed long-poll waits the normal interval */ }
  // After a HELD request go straight back. If the server answered at once
  // (older orchestrator ignoring `wait`, or an error), this is the old 3 s loop —
  // never a hot spin.
  const held = Date.now() - t0 >= 1000;
  setTimeout(actionLoop, failed || currentActionId || !held ? ACTION_POLL_MS : 50);
}

async function runJob(job) {
  currentJobId = job.id;
  log(`claimed job ${job.id.slice(0, 8)}: ${String(job.task).slice(0, 100)}`);

  // A typed action: PowerShell, directly, no agent and no workspace. The
  // WORKSPACE_ROOT jail below is about where an agent may EDIT FILES; it has
  // no meaning for "restart a service" and must not be applied to it.
  if (job.runtime === 'action') {
    currentJobId = null;
    return runActionJob(job);
  }

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

  await postResult({ job_id: job.id, worker_id: WORKER_ID, ...result, stdout });
  currentJobId = null;
}

// ── Off-box watchdog (2026-07-30) ────────────────────────────────────────────
//
// This process already talks to the gateway every 10 seconds, from OUTSIDE the
// fleet, on hardware Craig owns. That makes it the lowest-latency box-death
// detector available — and it is needed, because the GitHub Actions watchdog
// asks for every 5 minutes and measurably gets about once an hour
// (docs/ALERTS.md). Its weakness is the opposite one: it only works while this
// PC is awake. The two are complementary, not redundant.
//
// The hard part is not detection, it is not crying wolf. A failed claim usually
// means Craig's wifi dropped or tailscale restarted — NOT that the box died. So
// three signals are needed before anything is said, which is the same shape as
// self-heal's DNS check: distinguish "their fault", "our fault" and "cannot
// tell" instead of collapsing them.
// allowZero: 0 means "say it on the first failed poll" — a real ops choice, and
// what a test needs. `|| 5` used to eat it.
const WATCHDOG_AFTER_MIN = num('WATCHDOG_AFTER_MIN', 5);
const PUBLIC_HEALTH_URL  = cfg.PUBLIC_HEALTH_URL || 'http://66.42.121.161:9212/health';
const INTERNET_PROBE_URL = cfg.INTERNET_PROBE_URL || 'https://1.1.1.1/';
const NTFY_TOPIC         = cfg.NTFY_TOPIC || '';
const NTFY_SERVER        = (cfg.NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '');

/**
 * What is actually broken? Pure, so the decision is testable without a network.
 *   'box-down'   — the internet is fine and the box's PUBLIC port is dead too.
 *                  High confidence, and the only case worth waking him for.
 *   'tailnet'    — the public port answers but the gateway does not: tailscale,
 *                  the gateway service, or its token. The box is alive.
 *   'local'      — we cannot reach the internet either. Craig's wifi. Say nothing.
 *   'ok'         — nothing wrong.
 */
export function classifyOutage({ gatewayOk, publicOk, internetOk }) {
  if (gatewayOk) return 'ok';
  if (!internetOk) return 'local';
  return publicOk ? 'tailnet' : 'box-down';
}

const reachable = async (url, ms = 8000) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual' });
    return r.status > 0;             // any HTTP answer proves something is listening
  } catch { return false; }
};

let outageSince = null;
let alerted = null;                  // which kind we last alerted about

// Desktop message boxes are the right default on a PC someone is sitting at,
// and wrong for a headless/always-on box or a test run — a popup saying THE
// FLEET BOX IS NOT ANSWERING is not something to produce while proving the code
// works. WATCHDOG_DESKTOP=0 turns them off; the log and the push still carry it.
const WATCHDOG_DESKTOP = cfg.WATCHDOG_DESKTOP !== '0';

async function alertLocally(title, body) {
  log(`WATCHDOG: ${title} — ${body}`);
  // Best-effort desktop notification. msg.exe is present on Windows Pro and
  // needs no module; it is allowed to fail silently on Home.
  if (WATCHDOG_DESKTOP) {
    try {
      spawn('msg', ['*', '/TIME:600', `Jarvis: ${title}. ${body}`], { stdio: 'ignore', shell: false })
        .on('error', () => {});
    } catch { /* msg.exe absent (Home edition) — the push and the log still carry it */ }
  }
  // The push is what reaches him when he is away from this screen. It goes
  // DIRECT from the PC, so it works precisely when the box cannot send it.
  if (!NTFY_TOPIC) { log('WATCHDOG: no NTFY_TOPIC in config/pc-worker.env — desktop + log only'); return; }
  try {
    await fetch(`${NTFY_SERVER}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      headers: { Title: title, Priority: '5', Tags: 'rotating_light' },
      body: `${body}\n\n— jarvis pc-worker on ${os.hostname()}`,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) { log(`WATCHDOG: push failed: ${e.message}`); }
}

async function watchdog(gatewayOk) {
  if (gatewayOk) {
    if (alerted) {
      const downMin = Math.round((Date.now() - outageSince) / 60_000);
      await alertLocally('fleet box is answering again', `Recovered after about ${downMin} minute(s).`);
    }
    outageSince = null; alerted = null;
    return;
  }
  if (!outageSince) outageSince = Date.now();
  const downMin = (Date.now() - outageSince) / 60_000;
  if (downMin < WATCHDOG_AFTER_MIN) return;      // ride out a wifi blip or a restart

  const [publicOk, internetOk] = await Promise.all([
    reachable(PUBLIC_HEALTH_URL), reachable(INTERNET_PROBE_URL),
  ]);
  const kind = classifyOutage({ gatewayOk, publicOk, internetOk });
  if (kind === 'local') { log('WATCHDOG: no internet from this PC either — staying quiet, this end is the problem'); return; }
  if (kind === alerted) return;                  // already said it

  alerted = kind;
  if (kind === 'box-down') {
    await alertLocally('THE FLEET BOX IS NOT ANSWERING',
      `No response from the gateway for ${Math.round(downMin)} min, and its public liveness port is dead too, ` +
      `while this PC's internet is fine. Jarvis cannot report this itself — that is why this check exists.`);
  } else {
    await alertLocally('Jarvis gateway unreachable (box is alive)',
      `The gateway has not answered for ${Math.round(downMin)} min, but the box's public port does — so this is ` +
      `tailscale, the gateway service, or its token, not a dead box.`);
  }
}

async function pollOnce() {
  if (killed()) return; // local kill switch — stay quiet, don't even heartbeat
  let job;
  try {
    job = await api('claim', { worker_id: WORKER_ID });
  } catch (e) {
    await watchdog(false).catch(() => {});   // watchdog must never break the worker
    // Rethrow so loop()'s backoff actually applies (2026-07-30, found by the
    // code-health spine). A failed claim was caught here and returned normally,
    // so the one failure the backoff was written for — "tailnet down, gateway
    // restarting", per its own comment — was the one failure it never saw, and
    // the worker kept polling at full rate through an outage. loop() logs the
    // message along with the new interval, so nothing is lost by not logging here.
    throw e;
  }
  await watchdog(true).catch(() => {});
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

// Only run the worker when this file IS the program (2026-07-30). Until now the
// loop started at module scope, so merely IMPORTING this file — a test, a tool,
// anything — spun up a second fully-functional worker on Craig's PC, sharing the
// real WORKER_ID and the real token, competing for jobs and able to run `claude`
// on his machine. Found by writing the first unit test for this file: the test
// run didn't finish because the test process had become a worker.
//
// pathToFileURL, not `file://${argv[1]}`: the pattern used elsewhere in this repo
// is Linux-only and never matches on Windows (drive letter, backslashes), which
// is the one platform this particular file runs on.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (!CONFIGURED) {
    console.error('[pc-worker] JARVIS_WORKER_TOKEN not set (config/pc-worker.env or env var) — refusing to start.');
    process.exit(1);
  }
  log(`starting — worker_id=${WORKER_ID} gateway=${GATEWAY_URL} workspace=${WORKSPACE_ROOT}`);
  // Measure elevation before the first heartbeat so the server never has to
  // guess, and so the log says plainly what this worker can and cannot do.
  detectElevation().catch(e => log(`elevation check failed: ${e.message}`));
  startHeartbeat();
  loop();
  actionLoop();

  process.on('SIGINT', () => { stopHeartbeat(); process.exit(0); });
  process.on('SIGTERM', () => { stopHeartbeat(); process.exit(0); });
}

// spawn-agent.js — the ONE place Jarvis spawns AI-CLI worker processes.
//
// Centralizes the spawn environment every worker needs:
//   IS_SANDBOX=1            claude 2.1.207+ refuses --dangerously-skip-permissions
//                           as root without it (incident 2026-07-12 — silently
//                           killed every dispatched job).
//   DISABLE_AUTOUPDATER=1   a worker CLI must never self-update mid-fleet; the
//                           binary changes only deliberately, and the canary
//                           gate below verifies it before dispatch resumes.
//   HOME=/root              claude auth/config lives under root's home.
//
// Also owns the canary gate: when the installed claude version differs from
// the last verified one, a trivial CANARY-OK probe must pass before the
// orchestrator lets any claude-runtime job start. Verified version persists
// in agent_context (memory-server :9200) so it survives restarts.

import { spawn, execFile } from 'child_process';
import { profileEnv, classifyFailure, reportExhausted, reportAuthFailure, noteSpawnSuccess, getActiveProfile } from './claude-auth.js';

const MEMORY = 'http://127.0.0.1:9200';
const CANARY_KEY = 'claude_verified_version';
const VERSION_CACHE_MS = 10 * 60 * 1000;

let versionCache = { value: null, at: 0 };

export function workerEnv(extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: '/root',
    IS_SANDBOX: '1',
    DISABLE_AUTOUPDATER: '1',
    ...extraEnv,
  };
  // Subscription economics: CLI workers ALWAYS run on a flat-rate claude.ai
  // subscription login. profileEnv() points CLAUDE_CONFIG_DIR at the ACTIVE
  // login (claude-auth.js two-account failover) and strips the metered
  // ANTHROPIC_API_KEY — if that key leaks into a worker env it overrides the
  // subscription auth and bills every job per-token.
  return profileEnv(env);
}

// Spawn any worker command with a hard timeout. Resolves (never rejects) with
// { code, stdout, stderr, timedOut }. SIGTERM at timeout, SIGKILL 10s later.
//
// `detached: true` puts the child in its OWN process group so a timeout can kill
// the whole TREE, not just the process we launched (2026-07-30, from a
// code-health finding about deploy-gate: GateTest launches Chromium, and killing
// the node wrapper left the browser running. On a box that also hosts AlecRae,
// Gluecron, GateTest and Coolify, leaked browsers are a Rule 4 problem, not an
// untidiness problem). Each spawn gets its own group, so a group kill can only
// ever reach that spawn's own descendants.
//
// `timeoutMs` overrides `timeoutMin` for callers whose limit is sub-minute.
export function spawnProcess(cmd, args, { cwd, env, timeoutMin = 30, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: env || workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    // Signal the whole group; fall back to the single process if the group is
    // gone (already reaped) or the platform refuses a negative pid.
    const killTree = (sig) => {
      try { process.kill(-proc.pid, sig); }
      catch { try { proc.kill(sig); } catch { /* already dead */ } }
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 10_000).unref();
    }, timeoutMs || timeoutMin * 60_000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const settle = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        code,
        stdout: stdout.slice(-4000),
        stderr: (spawnError ? spawnError + '\n' + stderr : stderr).slice(-2000),
        timedOut,
      });
    };

    proc.on('close', (code) => settle(code));
    proc.on('error', (err) => settle(null, err.message));
  });
}

// Spawn a local claude worker on a task prompt. If the run dies on a USAGE
// LIMIT, flip to Craig's other subscription login (claude-auth) and retry the
// job ONCE on that account — the fleet keeps moving through 5-hour resets.
/**
 * `onRetry` is awaited immediately before the account-flip retry, so the caller
 * can record that a SECOND full-length run is starting (2026-07-30).
 *
 * Without it the retry is invisible: the job row keeps its original started_at
 * while the work legitimately runs for up to 2× timeoutMin, and the
 * orchestrator's zombie reaper — whose whole justification is "past its timeout,
 * the process is certainly gone" — would declare a live agent dead while it was
 * still editing and pushing a production repo, and tell Craig so.
 */
export async function spawnClaude({ prompt, cwd, model, extraEnv = {}, timeoutMin = 30, onRetry = null }) {
  const args = ['--dangerously-skip-permissions', '--print'];
  if (model) args.push('--model', model);
  args.push(prompt);

  const run = () => spawnProcess('claude', args, { cwd, env: workerEnv(extraEnv), timeoutMin });
  let result = await run();

  // A LOOP, not a single check, because the retry's own answer matters as much
  // as the first one (finding #336). The old shape classified run #1, flipped
  // to account B, ran again — and returned B's result unexamined. When both
  // logins were near their 5-hour window (routine; the brain and the workers
  // share them) B answered "usage limit reached" too, `limitHeld` stayed unset,
  // orchestrator.js:278 skipped its hold branch, and finishJob marked the job
  // FAILED. The task was gone, nothing re-queued it, and Craig got a "❌ Job
  // failed" push blaming the agent. reportExhausted(B) was never called either,
  // so B was never recorded as exhausted and the next job repeated the whole
  // dance.
  //
  // usage_limit and auth are handled IDENTICALLY here on purpose: both mean
  // "this login cannot do the work right now", both are survivable by flipping
  // to the other account, and both must be announced when they are not.
  //
  // `auth` was missing entirely until 2026-08-16, and the omission cost three
  // days: an expired OAuth session made every spawn exit 1 in ~2 seconds, this
  // branch ignored it, and the eight autonomous timers each reported their own
  // generic "agent failed" while the fleet did no work at all. The brain had
  // its own auth reporting, so Craig was told the BRAIN was down — never that
  // code-health, fix-runner, self-heal, review-runner, the harvester and the
  // role agents had all stopped with it.
  let retried = false;
  while (result.code !== 0 && !result.timedOut) {
    const cls = classifyFailure(result);
    if (cls.kind !== 'usage_limit' && cls.kind !== 'auth') break;

    const current = getActiveProfile()?.name;
    const next = cls.kind === 'auth'
      ? await reportAuthFailure(current, result.stderr || result.stdout || '').catch(() => null)
      : await reportExhausted(current, cls.resetAt).catch(() => null);

    // Only ever flip once per spawn. Without the `retried` latch a box with
    // three profiles could walk them all inside one job's timeout.
    if (next && next !== current && !retried) {
      retried = true;
      // Tell the caller BEFORE the second run starts — see onRetry above.
      // Promise.resolve so a SYNCHRONOUS callback works too — `onRetry(...).catch?.()`
      // would have thrown a TypeError on a callback that returns undefined,
      // taking down the very retry it exists to announce.
      if (onRetry) await Promise.resolve(onRetry({ from: current, to: next })).catch(() => {});
      result = await run();  // fresh env picks up the flip
      continue;              // …and its result goes back through the classifier
    }

    // No usable account either way — the caller should re-queue, not burn the
    // job. `authHeld` is named distinctly from `limitHeld` because the two need
    // opposite handling by a human: a limit ends by itself, a dead login ends
    // only when Craig runs `claude login`.
    if (cls.kind === 'auth') result.authHeld = true;
    else result.limitHeld = true;
    break;
  }
  // Record the heartbeat that proves spawning still authenticates, and clear a
  // standing auth alert on recovery. Best-effort: a memory-server blip must
  // never turn a successful agent run into a failed one.
  if (result.code === 0) {
    await noteSpawnSuccess(getActiveProfile()?.name).catch(() => {});
  }
  return result;
}

// Spawn a claude worker ON ANOTHER FLEET BOX over tailnet SSH (2026-08-08,
// Craig's amended ruling: box-to-box SSH over the TAILNET only). Factored from
// orchestrator.js's runRemoteJob so code-health's remote sweeps and the
// orchestrator share ONE remote-spawn mechanism. Differences from spawnClaude:
// no two-account failover (the remote box has its own login; a usage-limit
// there is visible in stderr and must be logged distinctly by the caller), and
// the env is the remote root's, not workerEnv().
export function spawnClaudeRemote({ prompt, server, cwd, timeoutMin = 30, extraEnv = {} }) {
  const safePrompt = prompt.replace(/'/g, "'\\''");
  const envStr = Object.entries({ IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1', ...extraEnv })
    .map(([k, v]) => `${k}=${v}`).join(' ');
  const sshCmd = `cd ${cwd} && ${envStr} claude --dangerously-skip-permissions --print '${safePrompt}'`;
  return spawnProcess('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-i', '/opt/jarvis/.ssh/orchestrator',
    `root@${server}`,
    sshCmd,
  ], { env: process.env, timeoutMin });
}

export function claudeVersion() {
  if (versionCache.value && Date.now() - versionCache.at < VERSION_CACHE_MS) {
    return Promise.resolve(versionCache.value);
  }
  return new Promise((resolve) => {
    execFile('claude', ['--version'], { env: workerEnv(), timeout: 30_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const v = stdout.trim();
      versionCache = { value: v, at: Date.now() };
      resolve(v);
    });
  });
}

async function getVerifiedVersion() {
  try {
    const r = await fetch(`${MEMORY}/memory/kv/${CANARY_KEY}`);
    if (!r.ok) return null;
    return (await r.json()).value;
  } catch {
    return null;
  }
}

async function setVerifiedVersion(version) {
  await fetch(`${MEMORY}/memory/kv`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: CANARY_KEY, value: version }),
  }).catch(() => {});
}

// Canary gate. Returns { ok, version, ranCanary, detail }.
// ok=true  → this claude version is verified; dispatch may proceed.
// ok=false → version changed AND the canary probe failed; caller must hold
//            claude-runtime dispatch and alert loudly.
export async function ensureClaudeVerified() {
  const version = await claudeVersion();
  if (!version) {
    return { ok: false, version: null, ranCanary: false, detail: 'claude --version failed or binary missing' };
  }

  const verified = await getVerifiedVersion();
  if (verified === version) {
    return { ok: true, version, ranCanary: false, detail: 'version already verified' };
  }

  const probe = await spawnClaude({
    prompt: 'Reply with exactly: CANARY-OK',
    cwd: '/opt/jarvis',
    timeoutMin: 2,
  });

  const passed = probe.code === 0 && probe.stdout.includes('CANARY-OK');
  if (passed) {
    await setVerifiedVersion(version);
    return { ok: true, version, ranCanary: true, detail: `canary passed, ${version} verified` };
  }

  return {
    ok: false,
    version,
    ranCanary: true,
    detail: `canary FAILED for ${version} — exit ${probe.code}, timedOut=${probe.timedOut}, stderr: ${probe.stderr.slice(0, 300)}`,
  };
}

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
  // Hybrid economics: CLI workers ALWAYS run on the flat-rate claude.ai
  // subscription login. If the metered ANTHROPIC_API_KEY (used only by the
  // gateway's Messages-API brain) leaks into a worker env, it overrides the
  // subscription auth and bills every job per-token.
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// Spawn any worker command with a hard timeout. Resolves (never rejects) with
// { code, stdout, stderr, timedOut }. SIGTERM at timeout, SIGKILL 10s later.
export function spawnProcess(cmd, args, { cwd, env, timeoutMin = 30 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: env || workerEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const killTimer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 10_000).unref();
    }, timeoutMin * 60_000);

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

// Spawn a local claude worker on a task prompt.
export function spawnClaude({ prompt, cwd, model, extraEnv = {}, timeoutMin = 30 }) {
  const args = ['--dangerously-skip-permissions', '--print'];
  if (model) args.push('--model', model);
  args.push(prompt);
  return spawnProcess('claude', args, { cwd, env: workerEnv(extraEnv), timeoutMin });
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

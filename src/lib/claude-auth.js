/**
 * claude-auth.js — claude.ai subscription login profiles + usage-limit failover.
 *
 * Craig has two paid claude.ai subscriptions. Everything Claude-shaped on this
 * box (the brain session AND every CLI worker) bills a subscription login, and
 * when the active one hits its 5-hour/weekly usage limit Jarvis flips to the
 * other account, says so out loud, and keeps working. No metered API keys.
 *
 * Profiles:
 *   'default'    → /root/.claude            (no CLAUDE_CONFIG_DIR — the login
 *                                            that has powered workers all along)
 *   '<name>'     → /root/.claude-profiles/<name>  (CLAUDE_CONFIG_DIR=<dir>;
 *                                            created by: CLAUDE_CONFIG_DIR=<dir> claude login)
 *
 * Durable state (memory :9200 KV, shared by every service process):
 *   claude-active-profile            — name of the profile new spawns should use
 *   claude-profile-exhausted:<name>  — ISO time until which <name> is limp
 *
 * Every service refreshes from KV every 60s, so a flip made by the deck
 * propagates to the orchestrator within a minute; the process that DETECTS a
 * limit flips its own cache immediately.
 */

import fs from 'fs';
import path from 'path';
import { notify } from './notify.js';

const MEMORY = 'http://127.0.0.1:9200';
const PROFILES_DIR = process.env.CLAUDE_PROFILES_DIR || '/root/.claude-profiles';
const DEFAULT_CONFIG = '/root/.claude';
const ACTIVE_KEY = 'claude-active-profile';
const EXHAUSTED_PREFIX = 'claude-profile-exhausted:';
const AUTHFAIL_PREFIX = 'claude-profile-authfail:';   // name → UTC day we last alerted
const LAST_SPAWN_OK_KEY = 'claude-last-spawn-ok';     // ISO of the last spawn that authed
const REFRESH_MS = 60_000;
// When a limit error carries no reset time, assume the worst-case remainder of
// a 5-hour window is unknowable and re-probe after an hour.
const DEFAULT_COOLDOWN_MS = 60 * 60_000;
// A broken login is presumed broken for this long, so the failover doesn't flap
// back onto it every spawn. Short, because the fix (`claude login`) is a human
// action that can land at any moment and should be picked up promptly.
const AUTH_COOLDOWN_MS = 15 * 60_000;

let active = null;                  // profile name, in-process cache
let exhausted = {};                 // name → epoch-ms until which it's dead
let authBroken = {};                // name → epoch-ms until which its login is presumed dead
let refreshTimer = null;

// ── Profile discovery ────────────────────────────────────────────────────────

export function listProfiles() {
  const out = [];
  try { if (fs.existsSync(path.join(DEFAULT_CONFIG, '.credentials.json'))) out.push('default'); } catch {}
  try {
    for (const d of fs.readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(PROFILES_DIR, d.name, '.credentials.json'))) out.push(d.name);
    }
  } catch { /* no profiles dir — default-only box */ }
  return out;
}

export function hasClaudeAuth() { return listProfiles().length > 0; }

export function getActiveProfile() {
  ensureRefreshLoop();
  const profiles = listProfiles();
  if (!profiles.length) return null;
  const name = profiles.includes(active) ? active : profiles[0];
  return { name, configDir: name === 'default' ? null : path.join(PROFILES_DIR, name) };
}

// A profile we could flip to: not the active one, not inside a usage cooldown,
// and not one whose LOGIN we just watched fail. The auth clause was added
// 2026-08-16: without it, an auth failover would happily flip to a second
// account whose OAuth was equally dead and call that a recovery.
function otherUsableProfile() {
  const cur = getActiveProfile()?.name;
  const now = Date.now();
  return listProfiles().find(p =>
    p !== cur
    && (!exhausted[p] || exhausted[p] < now)
    && (!authBroken[p] || authBroken[p] < now)) || null;
}

/**
 * Is EVERY subscription login inside its cooldown, and until when?
 *
 * reportExhausted() already promises Craig out loud that "Claude-runtime work is
 * held until the earliest reset" — but nothing enforced it. The orchestrator
 * called spawnClaude, ignored the `limitHeld` flag it sets, and marked the job
 * FAILED; the next queued job then did the same thing straight away. Found by
 * the code-health spine, 2026-07-30.
 *
 * `profiles` and `now` are injectable so the gate can be tested without a real
 * ~/.claude on disk and without waiting out a cooldown.
 *
 * @returns {{held: boolean, until: number|null, at: string|null}}
 *   `until` is the EARLIEST reset — the moment work can resume, not the latest.
 */
export function usageHold({ profiles: injected, now = Date.now(), state = exhausted } = {}) {
  if (!injected) ensureRefreshLoop();
  const profiles = injected || listProfiles();
  if (!profiles.length) return { held: false, until: null, at: null };
  // Named `table`, not `exhausted`: shadowing the module-level map inside a
  // function whose own parameter default reads it is exactly the kind of subtle
  // scoping puzzle this codebase does not need.
  const table = state;
  const resets = [];
  for (const p of profiles) {
    const until = table[p];
    if (!until || until < now) return { held: false, until: null, at: null };  // one is usable
    resets.push(until);
  }
  const until = Math.min(...resets);
  return { held: true, until, at: new Date(until).toISOString() };
}

/**
 * Env for anything that talks to Claude on the subscription: sets
 * CLAUDE_CONFIG_DIR for non-default profiles and STRIPS the metered API key
 * (an inherited ANTHROPIC_API_KEY would override the subscription login and
 * bill per-token — the exact failure mode of 2026-07-17).
 */
export function profileEnv(extraEnv = {}) {
  const p = getActiveProfile();
  const env = { ...extraEnv };
  if (p?.configDir) env.CLAUDE_CONFIG_DIR = p.configDir;
  else delete env.CLAUDE_CONFIG_DIR;
  delete env.ANTHROPIC_API_KEY;
  return env;
}

// ── Failure classification ───────────────────────────────────────────────────
// CLI/SDK error surfaces vary by version; treat these as a pattern set and log
// raw text on match so the set can be tuned against reality.

const LIMIT_RE = /usage limit reached|usage[_ ]limit|5-hour limit|weekly limit|hit your (usage )?limit|out of extra usage|limit will reset|upgrade to (pro|max)/i;
const RESET_EPOCH_RE = /limit[^0-9]{0,40}\|?(\d{10,13})/i;   // legacy "…limit reached|<epoch>"
const AUTH_RE = /not logged in|please run \/login|\/login/i;
const AUTH_RE2 = /invalid (api key|token|credentials)|oauth.*(expired|revoked)|authentication[_ ]error/i;
// The CLI rejects a model it doesn't know with:
//   "There's an issue with the selected model (claude-opus-5). It may not
//    exist or you may not have access to it."
// Verified against claude 2.1.220. This is what a box whose `claude` binary
// predates a model tier looks like — and since EVERY Jarvis spawn sets
// DISABLE_AUTOUPDATER=1 (spawn-agent.js, brain-claude.js), the binary only
// moves when a human moves it, so a model-ID change in code can outrun it.
// Without its own kind this landed in 'other', which made brain-claude.js
// escalate to the next tier up — a model the same stale binary also rejects —
// and the eventual alert read as a usage/outage problem. Name it instead.
const MODEL_RE = /issue with the selected model|may not exist or you may not have access|unknown model|invalid model|model[_ ]not[_ ]found|not_found_error.*model/i;
const MODEL_NAME_RE = /selected model \(([^)]+)\)|model[:\s]+["']?(claude-[a-z0-9.-]+)/i;
// Our OWN watchdogs firing (brain-claude.js runTurn), not an API error. This
// needs its own kind because the sensible reaction is the opposite of the
// 'other' one: 'other' escalates to a heavier tier on the theory the model
// struggled with the task, but a heavier tier is by definition SLOWER, so
// escalating a latency failure makes it worse and spends the subscription
// window doing it. Observed live 2026-07-28 20:33 on the box.
const TIMEOUT_RE = /no first token in time|turn timed out|first-token watchdog|turn watchdog/i;

export function classifyFailure({ code = null, stdout = '', stderr = '', message = '' } = {}) {
  const text = [message, stderr, stdout].filter(Boolean).join('\n').slice(0, 4000);
  if (LIMIT_RE.test(text)) {
    let resetAt = null;
    const m = text.match(RESET_EPOCH_RE);
    if (m) {
      const n = Number(m[1]);
      const ms = n > 1e12 ? n : n * 1000;
      if (ms > Date.now() && ms < Date.now() + 8 * 24 * 3600_000) resetAt = new Date(ms);
    }
    return { kind: 'usage_limit', resetAt };
  }
  if (AUTH_RE.test(text) || AUTH_RE2.test(text)) return { kind: 'auth' };
  if (MODEL_RE.test(text)) {
    const m = text.match(MODEL_NAME_RE);
    return { kind: 'model', model: (m && (m[1] || m[2])) || null };
  }
  if (TIMEOUT_RE.test(text)) return { kind: 'timeout' };
  return { kind: 'other' };
}

// ── State flips ──────────────────────────────────────────────────────────────

async function kvGet(key) {
  try { const r = await fetch(`${MEMORY}/memory/kv/${key}`); if (r.ok) return (await r.json())?.value ?? null; } catch {}
  return null;
}
async function kvSet(key, value) {
  await fetch(`${MEMORY}/memory/kv`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  }).catch(() => {});
}

/**
 * The active profile hit its usage limit. Persist the cooldown, flip to the
 * other account if one is usable, and say so out loud. Returns the NEW active
 * profile name, or null when every account is exhausted (caller should hold
 * work, not fail it).
 */
export async function reportExhausted(name, resetAt = null) {
  const until = resetAt instanceof Date ? resetAt.getTime() : Date.now() + DEFAULT_COOLDOWN_MS;
  exhausted[name] = until;
  await kvSet(EXHAUSTED_PREFIX + name, new Date(until).toISOString());

  const next = otherUsableProfile();
  const when = new Date(until).toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit', timeZone: 'Pacific/Auckland' });
  if (next) {
    active = next;
    await kvSet(ACTIVE_KEY, next);
    console.warn(`[claude-auth] ${name} exhausted until ${new Date(until).toISOString()} — flipped to ${next}`);
    await notify({
      source: 'claude-auth', level: 'warn',
      title: `Claude account "${name}" hit its usage limit — switched to "${next}"`,
      body: `Cooldown until ${new Date(until).toISOString()}. All new brain turns and workers now bill "${next}".`,
      speech: `Sir, Claude account ${name === 'default' ? 'one' : name} hit its usage limit. I've switched to the other account. It resets around ${when}.`,
    });
    return next;
  }
  console.error(`[claude-auth] ALL profiles exhausted (latest: ${name})`);
  await notify({
    source: 'claude-auth', level: 'alert',
    title: 'ALL Claude accounts have hit their usage limits',
    body: `"${name}" exhausted until ${new Date(until).toISOString()} and no other profile is usable. Claude-runtime work is held until the earliest reset.`,
    speech: `Sir, both Claude accounts have hit their usage limits. I'll hold Claude work until roughly ${when} and carry on with what I can.`,
  });
  return null;
}

/** Manual override — voice "switch account" or ops scripting. */
export async function switchProfile(name) {
  const profiles = listProfiles();
  const target = name === 'other'
    ? (profiles.find(p => p !== getActiveProfile()?.name) || null)
    : (profiles.includes(name) ? name : null);
  if (!target) return null;
  active = target;
  await kvSet(ACTIVE_KEY, target);
  return target;
}

/** The UTC day stamp used to rate-limit "only Craig can fix this" alerts. */
export function utcDay(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

/**
 * An auth-classified failure means a login needs redoing. Same shape as
 * reportExhausted: mark the profile dead, flip to the other account if one is
 * usable, say so. Returns the NEW active profile name, or null when no login
 * works anywhere.
 *
 * TWO defects behind this, both found 2026-08-16 after box-local agent spawns
 * had been dead for three days:
 *
 *  1. This function was only ever called from brain-claude.js. spawn-agent.js
 *     classified the failure and then handled `usage_limit` ONLY, so `auth`
 *     fell through and every autonomous timer (code-health, fix-runner,
 *     self-heal, review-runner, harvester, agent-scheduler) logged a generic
 *     "agent exited 1" forever. Craig was told the BRAIN was down; nothing said
 *     the whole autonomous fleet had stopped with it.
 *
 *  2. The rate limit was an in-process `lastAuthAlert` timestamp. Every one of
 *     those callers is a systemd ONESHOT — a fresh process per run — so the
 *     hourly limiter reset every single time and gated nothing. Paired with
 *     `level:'alert'`, which CLAUDE.md records as exempt from BOTH push dedupe
 *     and the hourly cap, wiring this into the spawner naively would have
 *     rebuilt the 235-notification flood of 2026-08-10 exactly.
 *
 * So the limit is a DURABLE once-per-UTC-day marker in KV, cleared on recovery
 * by noteSpawnSuccess() — a human's rate limit for a human-only fix, which is
 * the rule the flood incident earned.
 */
export async function reportAuthFailure(name, detail = '', now = Date.now()) {
  authBroken[name] = now + AUTH_COOLDOWN_MS;

  const next = otherUsableProfile();
  if (next) {
    active = next;
    await kvSet(ACTIVE_KEY, next);
    console.warn(`[claude-auth] login for ${name} is broken — flipped to ${next}`);
    await notify({
      source: 'claude-auth', level: 'warn',
      title: `Claude login for "${name}" is broken — switched to "${next}"`,
      body: `${detail.slice(0, 300)}\nRe-authorise it on the box: ${loginHint(name)}`,
      speech: `Sir, the Claude login for account ${spoken(name)} needs re-authorising. I've switched to the other account and I'm still working.`,
    });
    return next;
  }

  // Nothing else to fall back on: this is a total outage of every autonomous
  // Claude path, and only Craig can end it. Alert loudly — but once a day.
  const today = utcDay(now);
  if (await kvGet(AUTHFAIL_PREFIX + name) === today) {
    console.error(`[claude-auth] login for ${name} still broken (already alerted ${today})`);
    return null;
  }
  await kvSet(AUTHFAIL_PREFIX + name, today);
  console.error(`[claude-auth] login for ${name} is broken and NO profile is usable`);
  await notify({
    source: 'claude-auth', level: 'alert',
    title: `Claude login for "${name}" is broken — every autonomous agent is stopped`,
    body: `${detail.slice(0, 300)}\n\nNo other profile can authenticate, so EVERY box-local Claude spawn is failing: code-health sweeps, fix-runner repairs, self-heal, review-runner, harvester distillation and the role agents. The services stay "green" because each one only reports its own port.\n\nFix on the box: ${loginHint(name)}`,
    speech: `Sir, the Claude login for account ${spoken(name)} has expired and there's no working account to fall back on. Every autonomous agent is stopped until it's re-authorised.`,
  });
  return null;
}

function loginHint(name) {
  return name === 'default' ? 'claude login' : `CLAUDE_CONFIG_DIR=${PROFILES_DIR}/${name} claude login`;
}
function spoken(name) { return name === 'default' ? 'one' : name; }

/**
 * A spawn authenticated. Records the heartbeat the experience check reads, and
 * clears a standing auth alert so the next real failure is loud again (the
 * daily marker must never outlive the outage it describes).
 */
export async function noteSpawnSuccess(name, now = Date.now()) {
  delete authBroken[name];
  await kvSet(LAST_SPAWN_OK_KEY, new Date(now).toISOString());
  if (await kvGet(AUTHFAIL_PREFIX + name)) {
    await kvSet(AUTHFAIL_PREFIX + name, '');
    await notify({
      source: 'claude-auth', level: 'info',
      title: `Claude login for "${name}" is working again`,
      body: 'A spawn authenticated successfully. Autonomous agents have resumed.',
      speech: `Sir, the Claude login for account ${spoken(name)} is working again. Autonomous agents have resumed.`,
    });
  }
}

/**
 * A model-classified failure means the `claude` binary on this box does not
 * know (or is not entitled to) the tier the code asked for. Name it plainly —
 * the whole point is that Craig should not have to work out that a
 * "brain unavailable" alert actually means "your CLI is older than the model".
 * Alert once/hour per model so a wedged tier can't turn into a flood.
 */
const lastModelAlert = {};
export async function reportModelRejected(model, detail = '') {
  const key = model || 'unknown';
  if (Date.now() - (lastModelAlert[key] || 0) < 3600_000) return;
  lastModelAlert[key] = Date.now();
  await notify({
    source: 'claude-auth', level: 'alert',
    title: `Claude CLI on this box does not recognise "${key}"`,
    body: `${detail.slice(0, 300)}\n\nThe model ID in code is ahead of the binary, or the login isn't entitled to that tier. Every Jarvis spawn sets DISABLE_AUTOUPDATER=1, so the CLI only moves when you move it.\nOn the box: claude --version, then check the tier with\n  claude --model ${key} --print hi\nIf the version is behind, update the CLI and let spawn-agent.js's canary gate re-verify it before dispatch resumes.`,
    speech: `Sir, the Claude command line on this box doesn't recognise ${/opus/i.test(key) ? 'Opus 5' : /fable/i.test(key) ? 'Fable 5' : 'the requested model'}. It likely needs updating.`,
  });
}

// ── KV refresh loop (each service process keeps its own cache warm) ──────────

export async function refreshFromKV() {
  const [act, ...rest] = await Promise.all([
    kvGet(ACTIVE_KEY),
    ...listProfiles().map(async p => [p, await kvGet(EXHAUSTED_PREFIX + p)]),
  ]);
  if (act && listProfiles().includes(act)) active = act;
  for (const [p, iso] of rest) {
    const t = iso ? Date.parse(iso) : NaN;
    if (!Number.isNaN(t)) exhausted[p] = t;
  }
}

function ensureRefreshLoop() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => refreshFromKV().catch(() => {}), REFRESH_MS);
  refreshTimer.unref?.();
  refreshFromKV().catch(() => {});
}

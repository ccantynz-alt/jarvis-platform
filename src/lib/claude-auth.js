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
const REFRESH_MS = 60_000;
// When a limit error carries no reset time, assume the worst-case remainder of
// a 5-hour window is unknowable and re-probe after an hour.
const DEFAULT_COOLDOWN_MS = 60 * 60_000;

let active = null;                  // profile name, in-process cache
let exhausted = {};                 // name → epoch-ms until which it's dead
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

// A profile we could flip to: not the active one, not inside its cooldown.
function otherUsableProfile() {
  const cur = getActiveProfile()?.name;
  const now = Date.now();
  return listProfiles().find(p => p !== cur && (!exhausted[p] || exhausted[p] < now)) || null;
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

/** An auth-classified failure means a login needs redoing — alert once/hour. */
let lastAuthAlert = 0;
export async function reportAuthFailure(name, detail = '') {
  if (Date.now() - lastAuthAlert < 3600_000) return;
  lastAuthAlert = Date.now();
  await notify({
    source: 'claude-auth', level: 'alert',
    title: `Claude login for profile "${name}" is broken`,
    body: `${detail.slice(0, 300)}\nFix on the box: ${name === 'default' ? '' : `CLAUDE_CONFIG_DIR=${PROFILES_DIR}/${name} `}claude login`,
    speech: `Sir, the Claude login for account ${name === 'default' ? 'one' : name} needs re-authorising.`,
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

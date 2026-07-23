/**
 * Jarvis self-heal controller — src/self-heal.js
 *
 * Closes the loop that was missing: fleet-check.sh already writes status="error"
 * to memory when a platform's public site is DOWN, but nothing acted on it —
 * every repair needed a human. This runs on a timer, reads those signals, and
 * AUTO-DISPATCHES a repair agent through the orchestrator, with guardrails so a
 * flap or a runaway can't hurt the fleet.
 *
 * MODE (env SELF_HEAL_MODE): 'off' | 'dry-run' | 'live'
 *   off      — do nothing (kill switch).
 *   dry-run  — detect + log + notify what it WOULD do, but never dispatch.
 *   live     — actually dispatch repairs.
 * Default 'dry-run' — prove decisions against the real fleet before it acts.
 *
 * Guardrails (all automatic, none block on a human — so the plane scenario holds):
 *   - Debounce: a site must be DOWN for >= DOWN_MINUTES (survives a flap).
 *   - Cooldown: no re-attempt within COOLDOWN_MIN of the last one.
 *   - Daily cap: <= MAX_ATTEMPTS_PER_DAY per platform (spend/churn bound).
 *   - Concurrency: <= MAX_CONCURRENT self-heal jobs fleet-wide.
 *   - Scope: only 'active' registry platforms that are SSH-repairable
 *     (local or a reachable remote box). Skips vercel (notify-only), 'jarvis'
 *     itself (that's Phase 3 / the SPOF), and inactive platforms.
 *   - Non-destructive: the repair prompt forbids schema changes / data deletes,
 *     and DB-backed platforms are snapshotted first.
 *   - Report-after: every action + escalation is pushed to Craig via notify.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { loadPlatforms } from './lib/conversation.js';
import { notify } from './lib/notify.js';

const MEMORY       = 'http://127.0.0.1:9200';
const ORCHESTRATOR = 'http://127.0.0.1:9205';
const OWN_IP       = process.env.OWN_IP || '66.42.121.161';

const MODE                 = process.env.SELF_HEAL_MODE || 'dry-run';
// Guardrails must NEVER silently vanish. systemd keeps inline comments as part
// of an env value, so Number() can yield NaN — and every `x < NaN` comparison
// is false, which disabled ALL four gates on 2026-07-17 (117 dispatches/day
// against a cap of 6). Parse defensively: non-finite or non-positive → default.
function guardrail(name, fallback) {
  const n = Number(String(process.env[name] ?? '').trim().split(/\s|#/)[0]);
  if (Number.isFinite(n) && n > 0) return n;
  if (process.env[name] !== undefined) {
    console.error(`[self-heal] BAD GUARDRAIL ${name}=${JSON.stringify(process.env[name])} — using default ${fallback}`);
  }
  return fallback;
}
const DOWN_MINUTES         = guardrail('SELF_HEAL_DOWN_MINUTES', 12);   // > one fleet-check cycle
const COOLDOWN_MIN         = guardrail('SELF_HEAL_COOLDOWN_MIN', 30);
const MAX_ATTEMPTS_PER_DAY = guardrail('SELF_HEAL_MAX_ATTEMPTS', 6);
const MAX_CONCURRENT       = guardrail('SELF_HEAL_MAX_CONCURRENT', 2);

const STATE_DIR = '/var/lib/jarvis/self-heal';
const LOG       = '/var/log/jarvis-self-heal.log';
const MARKER    = '[self-heal]';                 // tags auto-dispatched jobs
// Public URL per platform (mirrors fleet-check.sh FLEET map).
const URLS = {
  zoobicon: 'https://zoobicon.com', vapron: 'https://vapron.ai', gluecron: 'https://gluecron.com',
  alecrae: 'https://alecrae.com', bookaride: 'https://www.bookaride.co.nz', voxlen: 'https://www.voxlen.ai',
  gatetest: 'https://gatetest.ai',
};
// Platforms whose data must be snapshotted before any repair touches the box.
const SNAPSHOT_CMD = { vapron: '/opt/jarvis/scripts/pull-vapron-backup.sh' };
const SKIP = new Set(['jarvis']);                // never self-repair the control box here

const now = () => Date.now();
function log(msg) { const line = `[${new Date().toISOString()}] ${msg}\n`; try { appendFileSync(LOG, line); } catch {} process.stdout.write(line); }
function today() { return new Date().toISOString().slice(0, 10); }

function stateOf(p) {
  const f = join(STATE_DIR, `${p}.json`);
  if (existsSync(f)) { try { return JSON.parse(readFileSync(f, 'utf8')); } catch {} }
  return { firstDown: null, lastAttempt: 0, day: today(), attemptsToday: 0 };
}
function saveState(p, s) { if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(join(STATE_DIR, `${p}.json`), JSON.stringify(s)); }

async function memSummary() {
  const r = await fetch(`${MEMORY}/memory/summary`);
  const t = (await r.text()).replace(/<!DOCTYPE[\s\S]*$/i, '').trim();
  return JSON.parse(t);
}
async function runningSelfHealJobs() {
  try {
    const jobs = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json());
    return (Array.isArray(jobs) ? jobs : []).filter(j => j.status === 'running' && (j.task || '').includes(MARKER));
  } catch { return []; }
}
function snapshot(platform) {
  const cmd = SNAPSHOT_CMD[platform];
  if (!cmd) return Promise.resolve(true);
  return new Promise((res) => execFile('bash', [cmd], { timeout: 300000 }, (e) => { if (e) log(`snapshot ${platform} failed: ${e.message}`); res(!e); }));
}

function repairTask(platform, url, code, mins) {
  return `${MARKER} AUTONOMOUS SELF-HEAL. Platform "${platform}" public site ${url || '(no url)'} has been returning HTTP ${code} — DOWN for ~${mins} min. ` +
    `Diagnose and restore it to serving HTTP 200. Prefer the SAFEST fix that works: restart the service, or redeploy the last-known-good build. ` +
    `Do NOT run destructive database operations, do NOT drop or truncate data, do NOT make schema migrations. ` +
    `After the fix, verify ${url || 'the site'} returns 200. If you cannot restore it safely, stop and report why.`;
}

async function dispatchRepair(platform, url, code, mins) {
  await snapshot(platform); // no-op unless the platform has a DB to protect
  const body = { platform, task: repairTask(platform, url, code, mins), executor: 'auto' };
  const r = await fetch(`${ORCHESTRATOR}/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

export async function runOnce() {
  if (MODE === 'off') { log('mode=off — skipping'); return; }
  log(`tick (mode=${MODE})`);

  let summary;
  try { summary = await memSummary(); } catch (e) { log(`memory unreachable: ${e.message}`); return; }
  const registry = loadPlatforms();
  const down = (summary.platforms || []).filter(p => p.status === 'error' && registry[p.name]);

  if (!down.length) { log('all probed platforms healthy'); return; }
  const concurrent = (await runningSelfHealJobs()).length;

  for (const p of down) {
    const name = p.name;
    const entry = registry[name];
    if (SKIP.has(name)) continue;
    if (entry.status !== 'active') { log(`${name}: skip (registry status ${entry.status})`); continue; }
    // Repairable only if local, or a reachable remote box (IPv4 server). Vercel/hostname-only → notify-only.
    const reachable = entry.server === OWN_IP || /^\d{1,3}(\.\d{1,3}){3}$/.test(entry.server || '');
    const s = stateOf(name);
    if (s.day !== today()) { s.day = today(); s.attemptsToday = 0; }
    if (!s.firstDown) s.firstDown = now();
    const downMin = Math.round((now() - s.firstDown) / 60000);
    const url = URLS[name];
    const code = (String(p.notes || '').match(/HTTP (\d{3})/) || [])[1] || '???';

    // ---- guardrail gauntlet ----
    if (downMin < DOWN_MINUTES) { log(`${name}: DOWN ${downMin}m (< ${DOWN_MINUTES}m debounce) — wait`); saveState(name, s); continue; }
    if (!reachable) {
      log(`${name}: DOWN but not SSH-repairable (server=${entry.server}) — notify only`);
      await notify({ source: 'self-heal', level: 'alert', title: `🔴 ${name} is down (manual)`, body: `${url || name} HTTP ${code}, ${downMin}m. Not auto-repairable (${entry.server}).`, speech: `${name} is down and needs manual attention.` });
      saveState(name, s); continue;
    }
    if (now() - s.lastAttempt < COOLDOWN_MIN * 60000) { log(`${name}: in cooldown (${Math.round((now()-s.lastAttempt)/60000)}m/${COOLDOWN_MIN}m)`); saveState(name, s); continue; }
    if (s.attemptsToday >= MAX_ATTEMPTS_PER_DAY) {
      log(`${name}: daily cap hit (${s.attemptsToday}/${MAX_ATTEMPTS_PER_DAY}) — escalate`);
      await notify({ source: 'self-heal', level: 'alert', title: `⛔ ${name} auto-repair capped`, body: `${name} still down after ${s.attemptsToday} attempts today. Needs a human.`, speech: `${name} keeps failing repair and needs you.` });
      saveState(name, s); continue;
    }
    if (concurrent >= MAX_CONCURRENT) { log(`${name}: at concurrency cap (${concurrent}/${MAX_CONCURRENT}) — defer`); saveState(name, s); continue; }

    // ---- act ----
    if (MODE === 'dry-run') {
      log(`DRY-RUN would repair ${name} (HTTP ${code}, down ${downMin}m, attempt ${s.attemptsToday + 1})`);
      await notify({ source: 'self-heal', level: 'warn', title: `🧪 [dry-run] would auto-repair ${name}`, body: `${url || name} HTTP ${code}, down ${downMin}m. Live mode would dispatch a repair agent now.`, speech: `Dry run. I would repair ${name} now.` });
      saveState(name, s); continue;
    }

    log(`LIVE dispatching repair for ${name} (HTTP ${code}, down ${downMin}m, attempt ${s.attemptsToday + 1})`);
    await notify({ source: 'self-heal', level: 'warn', title: `🔧 Auto-repairing ${name}`, body: `${url || name} was down (HTTP ${code}, ${downMin}m). Dispatched a repair agent; I'll report the result.`, speech: `${name} went down. I'm repairing it now.` });
    try {
      const res = await dispatchRepair(name, url, code, downMin);
      if (res.error) { log(`${name}: dispatch error: ${res.error}`); }
      else { log(`${name}: repair job ${res.jobId} dispatched`); s.lastAttempt = now(); s.attemptsToday += 1; }
    } catch (e) { log(`${name}: dispatch threw: ${e.message}`); }
    saveState(name, s);
  }

  // Clear state for platforms that recovered (so counters reset cleanly).
  const downNames = new Set(down.map(p => p.name));
  for (const name of Object.keys(registry)) {
    if (downNames.has(name)) continue;
    const f = join(STATE_DIR, `${name}.json`);
    if (existsSync(f)) {
      const s = stateOf(name);
      if (s.firstDown) { log(`${name}: recovered — clearing self-heal state`); }
      saveState(name, { firstDown: null, lastAttempt: s.lastAttempt, day: today(), attemptsToday: s.attemptsToday });
    }
  }
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  runOnce().then(() => process.exit(0)).catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
}

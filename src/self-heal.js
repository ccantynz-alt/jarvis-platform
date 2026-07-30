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
import { lookup } from 'dns/promises';
import { loadPlatforms } from './lib/conversation.js';
import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';

const MEMORY       = 'http://127.0.0.1:9200';
const ORCHESTRATOR = 'http://127.0.0.1:9205';
const OWN_IP       = process.env.OWN_IP || '66.42.121.161';

const MODE                 = process.env.SELF_HEAL_MODE || 'dry-run';
// Guardrails must NEVER silently vanish — the 2026-07-17 incident (117
// dispatches/day against a cap of 6, all four gates disabled at once by an
// inline comment in the EnvironmentFile). The defensive parse that came out of
// it now lives in lib/guardrail.js so every other numeric limit on the box
// gets the same protection instead of each service relearning it.
const g = (name, fallback) => guardrail(name, fallback, { source: 'self-heal' });
const DOWN_MINUTES         = g('SELF_HEAL_DOWN_MINUTES', 12);   // > one fleet-check cycle
const COOLDOWN_MIN         = g('SELF_HEAL_COOLDOWN_MIN', 30);
const MAX_ATTEMPTS_PER_DAY = g('SELF_HEAL_MAX_ATTEMPTS', 6);
const MAX_CONCURRENT       = g('SELF_HEAL_MAX_CONCURRENT', 2);

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

/**
 * `day` and `attemptsToday` may only ever move as a PAIR.
 *
 * The bug this fixes (found by the code-health spine, 2026-07-30, and it
 * permanently disabled autonomous repair for any platform that ever hit its
 * daily cap): the recovered-platform loop below runs every tick for every
 * platform that is NOT currently down — so, normally, all of them every 5
 * minutes — and it wrote `day: today()` while carrying the old `attemptsToday`
 * forward. The only reset lived in the down-path (`if (s.day !== today())`), so
 * it could never fire: by the time a platform went down again, `s.day` already
 * equalled today. A platform that spent all 6 attempts on one bad day then hit
 * "daily cap hit — escalate" on every future outage, forever, with nothing but
 * an alert to show for it.
 *
 * Deliberately NOT "reset the count on recovery": the cap is per DAY, not per
 * outage, and a flapping platform that recovers between attempts would otherwise
 * get an unbounded repair budget.
 *
 * Pure and exported so the rollover is testable without waiting for midnight.
 */
export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

/**
 * Does this URL's hostname resolve? 'ok' | 'nxdomain' | 'unresolvable' | 'n/a'
 *
 * The distinction matters and is deliberately three-valued:
 *   nxdomain     — the name does not exist. A registrar/zone problem. Nothing on
 *                  this box can fix it, so no repair agent should be spent.
 *   unresolvable — our resolver failed (EAI_AGAIN, timeout). That says nothing
 *                  about the domain, so we neither dispatch nor blame it.
 * Collapsing those two would either burn agents on expired domains or blame a
 * customer's DNS for our own resolver hiccup.
 */
export async function dnsState(url) {
  const host = hostOf(url);
  if (!host) return 'n/a';
  try {
    await lookup(host);
    return 'ok';
  } catch (e) {
    return e?.code === 'ENOTFOUND' ? 'nxdomain' : 'unresolvable';
  }
}

export function rollDay(s, day = today()) {
  if (!s) return s;
  // Trust `lastAttempt` over the stored `day`. The stored value was being
  // stamped forward every tick, so it carries no history — and on the real box
  // it had already gone incoherent: bookaride said "1 attempt today" for an
  // attempt actually made on 2026-07-12, gluecron on the 14th, zoobicon on the
  // 13th, and gatetest was sitting at 5 of a cap of 6. Deriving the reset from
  // when work ACTUALLY happened both fixes the bug and repairs those files on
  // the next tick, with no hand-editing.
  const attemptDay = s.lastAttempt ? new Date(s.lastAttempt).toISOString().slice(0, 10) : null;
  const countIsToday = attemptDay === day;
  if (s.day === day && (countIsToday || !s.attemptsToday)) return s;
  return { ...s, day, attemptsToday: countIsToday ? s.attemptsToday : 0 };
}

async function memSummary() {
  const r = await fetch(`${MEMORY}/memory/summary`);
  const t = (await r.text()).replace(/<!DOCTYPE[\s\S]*$/i, '').trim();
  return JSON.parse(t);
}
async function fetchJobs() {
  try {
    const jobs = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json());
    return Array.isArray(jobs) ? jobs : [];
  } catch { return []; }
}
// 2026-07-24: this used to only ever see ITS OWN [self-heal]-marked jobs —
// blind to a job audit-runner.js's or deploy-gate.js's own auto-fix-dispatch
// might already have in flight for the same platform (different trigger
// signal: they watch 'critical'/'deploy-gate-blocked' status, this watches
// fleet-check's 'error'). Two independent auto-repair systems piling a
// second agent on the same platform is exactly the kind of redundant-dispatch
// risk worth closing, so this now checks ANY job for that platform, not just
// self-heal's own.
function anyJobInFlight(jobs, platform) {
  return jobs.some(j => j.platform === platform && (j.status === 'running' || j.status === 'queued'));
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
  // priority 1 (2026-07-26): a public site is DOWN — this outranks every
  // scheduled role agent (now 8) and ordinary dispatch (5) in the orchestrator's
  // priority-ASC queue, so a repair can never wait behind routine paperwork.
  const body = { platform, task: repairTask(platform, url, code, mins), executor: 'auto', priority: 1 };
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
  const downNames = new Set(down.map(p => p.name));

  // Clear state for platforms that recovered (so counters/firstDown reset
  // cleanly). MUST run before the "all healthy" early-return below, not just
  // at the bottom of this function — that return used to skip this loop
  // entirely, so a stale `firstDown` set by one flaky probe would survive
  // silently through every subsequent "all probed platforms healthy" tick
  // (which never re-reaches the bottom of the function), then resurface the
  // next time a single transient blip flagged the platform again, computed
  // against the ancient timestamp — dispatching a repair agent for a site
  // "down 505m" (or 9709m, 720m, 275m, 445m — the actual log history) when
  // it had really been up the whole time. This is the root cause of the
  // repeated false "website down" self-heal dispatches against vapron.
  for (const name of Object.keys(registry)) {
    if (downNames.has(name)) continue;
    const f = join(STATE_DIR, `${name}.json`);
    if (existsSync(f)) {
      // rollDay, not `day: today()` — see rollDay's comment. Stamping today's
      // date while carrying yesterday's attempt count forward is what made the
      // daily cap permanent instead of daily.
      const s = rollDay(stateOf(name));
      if (s.firstDown) { log(`${name}: recovered — clearing self-heal state`); }
      saveState(name, { firstDown: null, lastAttempt: s.lastAttempt, day: s.day, attemptsToday: s.attemptsToday });
    }
  }

  if (!down.length) { log('all probed platforms healthy'); return; }
  const jobs = await fetchJobs();
  // mutable (2026-07-26 fix): this used to be a one-time snapshot taken before
  // the loop and never updated as dispatches happened within the same tick —
  // if N platforms were simultaneously flagged down (a shared-hosting/DNS/CDN
  // outage), every one of them would pass the `concurrent >= MAX_CONCURRENT`
  // check against the same stale count and self-heal could dispatch repairs
  // for all N in one run, blowing straight through the fleet-wide concurrency
  // guardrail — the same "guardrail exists in code but doesn't actually bound
  // behavior" class of bug as the 2026-07-17 incident, just a different
  // trigger. Now incremented after each successful dispatch below.
  let concurrent = jobs.filter(j => j.status === 'running' && (j.task || '').includes(MARKER)).length;

  for (const p of down) {
    const name = p.name;
    const entry = registry[name];
    if (SKIP.has(name)) continue;
    if (entry.status !== 'active') { log(`${name}: skip (registry status ${entry.status})`); continue; }
    // Repairable only if local, or a reachable remote box (IPv4 server). Vercel/hostname-only → notify-only.
    const reachable = entry.server === OWN_IP || /^\d{1,3}(\.\d{1,3}){3}$/.test(entry.server || '');
    // Same helper as the recovered-platform loop above — one place decides how a
    // day rolls over, so the two paths cannot disagree again.
    const s = rollDay(stateOf(name));
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
    // ---- is this even a SERVER problem? (2026-07-30) ----
    // A name that no longer resolves cannot be fixed from this box, and no agent
    // should be spent discovering that. gatetest.ai taught this the expensive
    // way: its domain entered .ai redemption on 2026-07-29, DNS went NXDOMAIN,
    // and self-heal dispatched SIX repair agents in one day — twelve runs in
    // total — each of which correctly concluded "registry-level, nothing to do
    // here" after several minutes of a full-permission agent's time. The server
    // was answering 200 on localhost the whole time.
    const dns = await dnsState(url);
    if (dns === 'nxdomain') {
      log(`${name}: DOWN because ${hostOf(url)} does not resolve — registry/DNS, not this box. No agent dispatched.`);
      // Counts as an attempt on purpose: it puts the cooldown in front of the
      // next check so this notify can't repeat every five minutes.
      s.lastAttempt = now();
      s.attemptsToday += 1;
      await notify({
        source: 'self-heal', level: 'alert',
        title: `${name} is down because its DOMAIN does not resolve`,
        body: `${url} returns nothing because ${hostOf(url)} has no DNS record — an expired/parked domain or a ` +
          `deleted zone, not a server fault. Check the registrar. Nothing on this box can fix it, so I have not ` +
          `spent a repair agent (attempt ${s.attemptsToday}/${MAX_ATTEMPTS_PER_DAY} today).`,
        speech: `Sir, ${name} is down because its domain no longer resolves. That is a registrar problem — I can't fix it from here.`,
      });
      saveState(name, s); continue;
    }
    if (dns === 'unresolvable') {
      log(`${name}: DNS lookup for ${hostOf(url)} failed temporarily — waiting for the next tick rather than guessing`);
      saveState(name, s); continue;   // no attempt counted: our resolver, not their domain
    }

    if (now() - s.lastAttempt < COOLDOWN_MIN * 60000) { log(`${name}: in cooldown (${Math.round((now()-s.lastAttempt)/60000)}m/${COOLDOWN_MIN}m)`); saveState(name, s); continue; }
    if (s.attemptsToday >= MAX_ATTEMPTS_PER_DAY) {
      log(`${name}: daily cap hit (${s.attemptsToday}/${MAX_ATTEMPTS_PER_DAY}) — escalate`);
      await notify({ source: 'self-heal', level: 'alert', title: `⛔ ${name} auto-repair capped`, body: `${name} still down after ${s.attemptsToday} attempts today. Needs a human.`, speech: `${name} keeps failing repair and needs you.` });
      saveState(name, s); continue;
    }
    if (concurrent >= MAX_CONCURRENT) { log(`${name}: at concurrency cap (${concurrent}/${MAX_CONCURRENT}) — defer`); saveState(name, s); continue; }
    if (anyJobInFlight(jobs, name)) { log(`${name}: a job is already running/queued for this platform (possibly audit-runner/deploy-gate's own auto-fix) — not piling on`); saveState(name, s); continue; }

    // ---- trust but verify (2026-07-24) ----
    // memory said "error", but that's a 10-minute-old probe result. Before
    // spending a repair agent, check the site LIVE — self-heal "repaired"
    // healthy-but-slow vapron 4× in 12h off stale transient misses.
    if (url) {
      try {
        const live = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (live.ok || (live.status >= 300 && live.status < 400)) {
          log(`${name}: memory says error but LIVE probe returned ${live.status} — false alarm, clearing state`);
          saveState(name, { firstDown: null, lastAttempt: s.lastAttempt, day: s.day, attemptsToday: s.attemptsToday });
          continue;
        }
      } catch { /* live probe also failed — genuinely down, proceed */ }
    }

    // ---- act ----
    if (MODE === 'dry-run') {
      log(`DRY-RUN would repair ${name} (HTTP ${code}, down ${downMin}m, attempt ${s.attemptsToday + 1})`);
      await notify({ source: 'self-heal', level: 'warn', title: `🧪 [dry-run] would auto-repair ${name}`, body: `${url || name} HTTP ${code}, down ${downMin}m. Live mode would dispatch a repair agent now.`, speech: `Dry run. I would repair ${name} now.` });
      saveState(name, s); continue;
    }

    log(`LIVE dispatching repair for ${name} (HTTP ${code}, down ${downMin}m, attempt ${s.attemptsToday + 1})`);
    // The attempt is counted BEFORE the outcome is known (2026-07-30, found by
    // the code-health spine). It used to advance lastAttempt/attemptsToday only
    // on a SUCCESSFUL dispatch — so if /dispatch kept erroring (orchestrator
    // down, registry mismatch, queue rejection) the cooldown and the daily cap
    // never engaged, and this ran again on the very next 5-minute tick, forever.
    // The notify() moved below for the same reason: at one warn-level push per
    // tick that is 288 phone alerts a day about a repair that never started.
    s.lastAttempt = now();
    s.attemptsToday += 1;
    try {
      const res = await dispatchRepair(name, url, code, downMin);
      if (res.error) {
        log(`${name}: dispatch error: ${res.error}`);
        await notify({ source: 'self-heal', level: 'warn', title: `Could not dispatch a repair for ${name}`, body: `${url || name} is down (HTTP ${code}, ${downMin}m) and the orchestrator refused the repair job: ${res.error}. Attempt ${s.attemptsToday}/${MAX_ATTEMPTS_PER_DAY} today; next try after the ${COOLDOWN_MIN}m cooldown.`, speech: `Sir, ${name} is down and I could not start the repair.` });
      } else {
        log(`${name}: repair job ${res.jobId} dispatched`);
        concurrent += 1;
        await notify({ source: 'self-heal', level: 'warn', title: `🔧 Auto-repairing ${name}`, body: `${url || name} was down (HTTP ${code}, ${downMin}m). Dispatched a repair agent; I'll report the result.`, speech: `${name} went down. I'm repairing it now.` });
      }
    } catch (e) {
      log(`${name}: dispatch threw: ${e.message}`);
      await notify({ source: 'self-heal', level: 'warn', title: `Could not reach the orchestrator to repair ${name}`, body: `${url || name} is down (HTTP ${code}, ${downMin}m) and the dispatch call itself failed: ${e.message}.`, speech: `Sir, ${name} is down and I could not reach the orchestrator.` });
    }
    saveState(name, s);
  }
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  runOnce().then(() => process.exit(0)).catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
}

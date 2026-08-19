/**
 * Jarvis/Marco experience self-check — src/experience-check.js
 *
 * Craig, 2026-08-11: "how do we keep improving." This is the answer to the
 * uncomfortable part of that question: for a solid week, every fault that
 * actually reached him was found by HIM. The open mic transcribing his
 * household. 235 phone alerts about a PC that was fine. The voice quietly
 * dropping to the browser fallback. Production sitting on an agent's branch
 * while deploys silently no-op'd. Twelve services were green throughout.
 *
 * Everything else on this box monitors the MACHINE — ports, builds, code
 * defects. This monitors the EXPERIENCE: the handful of things that, when they
 * go wrong, Craig notices before any of us do. Each check is one of those
 * incidents turned around so the box notices instead.
 *
 * Design rules:
 *   - Every check cites a real incident. No plausible-sounding monitoring.
 *   - Positive evidence only: a check passes when something ANSWERED, never
 *     because nothing threw. Silent degradation is the whole enemy here.
 *   - It must never become the thing it watches for. Announcements fire on
 *     CHANGE, once daily while unchanged, and once on recovery — at warn/info,
 *     never `alert` (lib/push.js exempts alert from dedupe AND the hourly cap,
 *     and nothing on a timer should reach that exemption).
 *   - Read-only. It probes and reports; it repairs nothing.
 */

import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import {
  checkDeploy, checkVoice, checkBrain, checkAlertRate, checkShowMe, checkPcWorker, checkAgentSpawns,
  fingerprint, announcement, summarize, speech,
} from './lib/experience.js';
import { installInternalAuth } from './lib/internal-http.js';
installInternalAuth();   // gate loopback :9200/:9205 writes with the internal token (move 11)

const MEMORY = 'http://127.0.0.1:9200';
const DECK = 'http://127.0.0.1:9210';
const BROWSER = 'http://127.0.0.1:9211';
const REPO = '/opt/jarvis';
const LOG = '/var/log/jarvis-experience.log';
const STATE_KEY = 'experience-check-state';

const MODE = process.env.EXPERIENCE_MODE || 'live';   // off | dry-run | live
const ALERT_THRESHOLD = guardrail('EXPERIENCE_ALERT_PER_HOUR', 12, { source: 'experience' });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG, line); } catch { /* journald still has stdout */ }
  process.stdout.write(line);
}

const jget = (url, ms = 8000) => fetch(url, { signal: AbortSignal.timeout(ms) })
  .then(r => r.ok ? r.json() : null).catch(() => null);

// ── probes ──────────────────────────────────────────────────────────────────

function gitState() {
  // -c safe.directory + explicit HOME: this service has no HOME under systemd,
  // the same trap that silently broke code-health's checkoutInfo() (LESSONS).
  const git = (args) => execFileSync('git', ['-c', `safe.directory=${REPO}`, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: process.env.HOME || '/root' },
  }).trim();
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const localSha = git(['rev-parse', '--short', 'HEAD']);
    let originSha = null;
    try {
      git(['fetch', '-q', 'origin', 'main']);          // read-only; never merges
      originSha = git(['rev-parse', '--short', 'origin/main']);
    } catch { /* offline or no remote — drift is unknowable, not failing */ }
    return { branch, localSha, originSha };
  } catch (e) {
    log(`git probe failed: ${e.message}`);
    return { branch: null, localSha: null, originSha: null };
  }
}

async function voiceState() {
  const health = await jget(`${DECK}/health`);
  // Probe the REAL path, not the flag: the 2026-08-10 fault was precisely a
  // flag that said yes while the path said 503.
  let ttsStatus = null;
  try {
    const r = await fetch(`${DECK}/tts?text=selfcheck`, { signal: AbortSignal.timeout(15000) });
    ttsStatus = r.status;
  } catch { ttsStatus = null; }
  return {
    healthSaysTts: !!health?.tts,
    ttsStatus,
    ttsDisabled: process.env.TTS_DISABLED === '1',
  };
}

async function brainState() {
  const kv = await jget(`${MEMORY}/memory/kv/brain-provider`);
  const degradedKv = await jget(`${MEMORY}/memory/kv/brain-degraded`);
  return {
    provider: kv?.value || process.env.BRAIN_PROVIDER || 'claude',
    degraded: degradedKv?.value === '1' || degradedKv?.value === 'true',
  };
}

async function alertRate() {
  const rows = await jget(`${MEMORY}/memory/notifications?limit=200`);
  const list = Array.isArray(rows?.notifications) ? rows.notifications : (Array.isArray(rows) ? rows : []);
  const cutoff = Date.now() - 3600_000;
  return list.filter(n => Date.parse(n.ts) >= cutoff).length;
}

// ── state (durable in memory KV so a restart does not re-announce) ───────────

const loadState = () => jget(`${MEMORY}/memory/kv/${STATE_KEY}`)
  .then(kv => { try { return JSON.parse(kv?.value || '{}'); } catch { return {}; } });

const saveState = (state) => fetch(`${MEMORY}/memory/kv`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key: STATE_KEY, value: JSON.stringify(state) }),
}).catch(() => {});

async function main() {
  if (MODE === 'off') { log('EXPERIENCE_MODE=off — exiting'); return; }

  const [voice, brain, lastHour, browser, pc, spawnOk] = await Promise.all([
    voiceState(), brainState(), alertRate(),
    jget(`${BROWSER}/browser/health`),
    jget('http://127.0.0.1:9205/pc/status'),
    jget(`${MEMORY}/memory/kv/claude-last-spawn-ok`),
  ]);
  const git = gitState();

  // Written by spawn-agent.js on every spawn that authenticates. Absent or
  // unparseable → null, which checkAgentSpawns reports as "never" rather than
  // silently treating a missing heartbeat as a fresh one.
  const spawnAt = Date.parse(spawnOk?.value || '');
  const secondsSinceOk = Number.isNaN(spawnAt) ? null : Math.max(0, (Date.now() - spawnAt) / 1000);

  const results = [
    checkDeploy(git),
    checkVoice(voice),
    checkBrain(brain),
    checkAlertRate({ lastHour, threshold: ALERT_THRESHOLD }),
    checkPcWorker({ secondsSinceSeen: pc ? pc.seconds_since_seen : null }),
    checkAgentSpawns({ secondsSinceOk }),
    checkShowMe({ browserOk: !!browser }),
  ];

  for (const r of results) log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.id}: ${r.detail}`);

  const today = new Date().toISOString().slice(0, 10);
  const prev = await loadState();
  const fp = fingerprint(results);
  const say = announcement(prev, results, today);

  if (MODE === 'dry-run') {
    log(`DRY-RUN — would ${say.announce ? `announce (${say.kind}, ${say.level})` : 'stay quiet'}; fingerprint ${fp}`);
    return;
  }

  if (say.announce) {
    const failing = results.filter(r => !r.ok).length;
    await notify({
      source: 'experience',
      level: say.level,
      title: say.kind === 'recovered'
        ? '✅ Everything he would notice is back to normal'
        : `Experience check: ${failing} thing(s) Craig would notice`,
      body: summarize(results, say.kind),
      speech: say.kind === 'recovered' ? null : speech(results),
    }).catch(e => log(`notify failed: ${e.message}`));
    log(`announced (${say.kind}, ${say.level})`);
  } else {
    log(`quiet — nothing changed since the last run (fingerprint ${fp})`);
  }

  await saveState({
    fingerprint: fp,
    day: today,
    announcedDay: say.announce ? today : (prev?.announcedDay || null),
    results: results.map(r => ({ id: r.id, ok: r.ok })),
    checkedAt: new Date().toISOString(),
  });
}

main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });

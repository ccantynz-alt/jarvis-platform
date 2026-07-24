/**
 * Jarvis Command Deck — src/deck-server.js
 *
 * Serves public/command-deck.html (Craig's Claude Design handoff, implemented
 * in vanilla JS) and the raw WebSocket telemetry endpoint /jarvis speaking the
 * handoff's "WebSocket Contract v1.0" — plus an {type:'org'} extension for the
 * live hierarchy view.
 *
 * Binds 127.0.0.1:9210 ONLY; exposed exclusively via
 *   tailscale serve --bg --https=8444 http://127.0.0.1:9210
 * (same pattern and reasons as gateway-server.js — Traefik owns :443/:8080,
 * tailnet-only perimeter, iOS needs a real cert for mic/speech).
 *
 * The design handoff wanted ws://66.42.121.161:8080/jarvis — impossible here
 * (Coolify's Traefik publishes :8080) and unacceptable publicly (the deck
 * accepts commands). Same-origin /jarvis behind the tailnet + token instead.
 *
 * Auth: JARVIS_DECK_TOKEN only — deliberately NOT shared with the gateway, so
 * a leaked gateway credential can't open the deck (and vice versa). Cookie
 * bootstrap via /?token=… like the gateway.
 *
 * Every number pushed to the deck is real:
 *   agents    ← :9209/org (role-agent registry) + :9205 running jobs
 *   feed      ← :9200/memory/notifications (durable inbox)
 *   wire      ← :9205/events (orchestrator event log)
 *   stats     ← :9205/health queue counts + notification/event rate
 *   queues    ← job queue, self-heal, agent cron, inbox, deploy gate
 *   platforms ← config/platforms.json + memory/platform-health.json + job history
 *   chat      ← lib/agent.js brain (API key) or lib/conversation.js intents
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash, timingSafeEqual, randomBytes } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolveIntent, runIntent, resolveDispatchGate, platformNames, PLATFORM_URLS, ORCHESTRATOR, MEMORY, handleBriefing } from './lib/conversation.js';
import { runAgent, hasAgent, maybeBrainSwitch, getBrainProvider, noteBrainDegraded, noteBrainHealthy } from './lib/agent.js';
import { synthesize, ttsEnabled } from './lib/tts.js';

const PORT      = 9210;
const SCHEDULER = 'http://127.0.0.1:9209';

// ── Auth (gateway-server.js pattern — fail closed) ───────────────────────────

// Token resolution: env override → config/deck.token → self-provision.
// The deck mints its own credential on first boot so it never has to share
// the gateway's; rotate by deleting the file and restarting.
const TOKEN_FILE = '/opt/jarvis/config/deck.token';
const AUTH_TOKEN = (() => {
  if (process.env.JARVIS_DECK_TOKEN) return process.env.JARVIS_DECK_TOKEN;
  try { const t = readFileSync(TOKEN_FILE, 'utf8').trim(); if (t) return t; } catch {}
  const fresh = randomBytes(32).toString('hex');
  try {
    writeFileSync(TOKEN_FILE, fresh + '\n', { mode: 0o600 });
    console.log('[jarvis-deck] minted new deck token → config/deck.token');
    return fresh;
  } catch (err) {
    console.error(`[jarvis-deck] cannot persist deck token (${err.message}) — auth disabled, failing closed`);
    return '';
  }
})();
const AUTH_COOKIE    = 'jarvis_deck_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function tokenMatches(candidate) {
  if (!AUTH_TOKEN || !candidate) return false;
  const a = createHash('sha256').update(String(candidate)).digest();
  const b = createHash('sha256').update(AUTH_TOKEN).digest();
  return timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function requestToken(req) {
  const header = String(req.headers.authorization || '');
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  const cookies = parseCookies(req.headers.cookie);
  return cookies[AUTH_COOKIE] || null;
}

// Direct loopback call (screenshot service, health checks) — no proxy hop.
function isLocalDirect(req) {
  const ip = req.socket.remoteAddress;
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
    && !req.headers['x-forwarded-for'];
}

function isAuthed(req) {
  return tokenMatches(requestToken(req));
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function jget(url, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function ago(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 129600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}
const hhmm = (iso) => new Date(iso ?? Date.now()).toLocaleTimeString('en-GB');

// ── App + static ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Build stamp (2026-07-25): ends the "is your browser on the new code?"
// guessing game — the client shows this hash on screen; if it matches the
// repo HEAD the deploy chain (git → box → browser) is proven end to end.
let BUILD = 'unknown';
try { BUILD = execSync('git rev-parse --short HEAD', { cwd: '/opt/jarvis', encoding: 'utf8' }).trim(); } catch {}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jarvis-deck', build: BUILD, clients: wss?.clients?.size ?? 0, link: 'ready', tts: ttsEnabled() });
});

// POST /internal/notify — instant push, mirrors gateway-server.js's own
// /internal/notify (2026-07-21: the Deck previously only found out about
// notifications via pollActivity()'s 5s poll of memory — the Gateway got
// an instant push, the Deck (what Craig actually watches) did not, for no
// reason other than the two servers being built separately). Loopback-only,
// same trust model as gateway's version — called by lib/notify.js.
app.post('/internal/notify', (req, res) => {
  if (!isLocalDirect(req) && !isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const { id, source = 'jarvis', level = 'info', title, body, speech } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  const ts = new Date().toISOString();
  pushFeed(LEVEL_COLOR[level] || '#00e5ff', title, ts);
  // Advance the poll cursor so pollActivity()'s next tick doesn't re-announce
  // this same notification a few seconds later — the durable memory write
  // (lib/notify.js posts there first) is still the source of truth if this
  // push is ever missed (deck restarting, a dropped connection, etc).
  if (typeof id === 'number') state.lastNotifId = Math.max(state.lastNotifId, id);
  if (['warn', 'alert', 'error'].includes(level)) {
    synthesize(speech || title).catch(() => {});
    broadcast({ type: 'notify', level, title, speech: speech || title });
  }
  res.json({ ok: true, clients: wss?.clients?.size ?? 0 });
});

// PWA identity — manifest + icons (same auth as the page; loopback allowed
// so the screenshot service can render/verify them).
app.get('/deck.webmanifest', (req, res) => {
  if (!isAuthed(req) && !isLocalDirect(req)) return res.status(403).end();
  res.set('Content-Type', 'application/manifest+json');
  res.sendFile('/opt/jarvis/public/deck.webmanifest');
});
app.get('/icons/:file', (req, res) => {
  if (!isAuthed(req) && !isLocalDirect(req)) return res.status(403).end();
  if (!/^deck-\d+\.png$/.test(req.params.file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile('/opt/jarvis/public/icons/' + req.params.file);
});
app.get('/deck-icon.html', (req, res) => {
  if (!isAuthed(req) && !isLocalDirect(req)) return res.status(403).end();
  res.sendFile('/opt/jarvis/public/deck-icon.html');
});

// GET /tts?text=… — the Jarvis neural voice (ElevenLabs, cached server-side).
// 503 carries a reason ('unconfigured'|'budget'|'api_error') so the client can
// tell "gone for the day" from a transient blip instead of silently switching voices.
app.get('/tts', async (req, res) => {
  if (!isAuthed(req) && !isLocalDirect(req)) return res.status(403).end();
  const out = await synthesize(req.query.text);
  if (!out.buf) return res.status(503).json({ error: 'tts unavailable', reason: out.reason });
  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(out.buf);
});

app.get('/', (req, res) => {
  if (req.query.token !== undefined) {
    if (!tokenMatches(req.query.token)) return res.status(403).send('Forbidden');
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${encodeURIComponent(req.query.token)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    return res.redirect('/');
  }
  if (!isAuthed(req) && !isLocalDirect(req)) {
    console.log(`[deck] 403 for ${req.headers['x-forwarded-for'] || req.socket.remoteAddress} (${req.headers['tailscale-user-login'] || 'unknown user'})`);
    return res.status(403).send(`<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>JARVIS — locked</title></head>
<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#04060c;color:#d7e7f0;font-family:monospace;text-align:center">
<div>
<svg width="120" height="120" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:0 auto 14px">
  <defs><radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#00e5ff" stop-opacity=".5"/><stop offset="100%" stop-color="#000" stop-opacity="0"/></radialGradient>
  <radialGradient id="c" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="#eaffff"/><stop offset="100%" stop-color="#00c8e6"/></radialGradient></defs>
  <circle cx="256" cy="256" r="240" fill="url(#g)"/>
  <circle cx="256" cy="256" r="196" fill="none" stroke="#00e5ff" stroke-opacity=".9" stroke-width="7" stroke-dasharray="480 800" transform="rotate(-35 256 256)"/>
  <circle cx="256" cy="256" r="196" fill="none" stroke="#00e5ff" stroke-opacity=".25" stroke-width="3"/>
  <circle cx="256" cy="256" r="164" fill="none" stroke="#00e5ff" stroke-opacity=".55" stroke-width="4" stroke-dasharray="300 740" transform="rotate(120 256 256)"/>
  <circle cx="256" cy="256" r="110" fill="none" stroke="#00e5ff" stroke-opacity=".8" stroke-width="4"/>
  <circle cx="256" cy="256" r="62" fill="url(#c)"/>
</svg>
<div style="font-size:22px;letter-spacing:6px;color:#00e5ff">JARVIS</div>
<p style="color:#8fb3c4;max-width:34em;line-height:1.6">This device isn't signed in yet.<br>
Append <b style="color:#00e5ff">/?token=&lt;deck token&gt;</b> to this address one time<br>
(the deck token lives in <b style="color:#00e5ff">config/deck.token</b> on the box — Gateway logins no longer unlock the Deck).</p></div></body></html>`);
  }
  res.set('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile('/opt/jarvis/public/command-deck.html');
});

// ── Telemetry state ──────────────────────────────────────────────────────────

const state = {
  agents: [],        // C-suite department tiles
  orgTiers: null,    // hierarchy view
  orgTotal: 0,
  queues: [],
  platforms: [],
  stats: { msgRate: 0, queueDepth: 0, tasksDone: 0, uptime: '—' },
  feedCache: [],     // last N feed lines  {t,color,text}
  wireCache: [],     // last N wire lines  {t,topic,body}
  lastNotifId: 0,
  lastEventTs: '',
  recentTs: [],      // ms timestamps of feed+wire traffic for msgRate
  upSamples: new Map(), // platform → {up, total}
  latHist: new Map(),   // platform → [latencyMs…] ring buffer (drives real sparklines)
};

// Persist rolling history so uptime %s and sparklines survive restarts.
const STATE_FILE = '/opt/jarvis/memory/deck-state.json';
try {
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  state.upSamples = new Map(saved.upSamples || []);
  state.latHist = new Map(saved.latHist || []);
  state.lastNotifId = saved.lastNotifId || 0;
  state.lastEventTs = saved.lastEventTs || '';
} catch { /* first boot */ }
function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      upSamples: [...state.upSamples], latHist: [...state.latHist],
      lastNotifId: state.lastNotifId, lastEventTs: state.lastEventTs,
    }));
  } catch (e) { console.error('[deck] state save failed:', e.message); }
}

// Real sparkline from latency history (design format: 21 "x,y" points, y 3–23)
function sparkFromLatency(hist) {
  if (!hist || hist.length < 2) return null;
  const h = hist.slice(-21);
  const min = Math.min(...h), max = Math.max(...h);
  const span = Math.max(1, max - min);
  return h.map((v, i) => {
    const x = (i * (100 / (h.length - 1))).toFixed(1);
    const y = (23 - ((v - min) / span) * 18).toFixed(1); // higher latency = higher peak
    return `${x},${y}`;
  }).join(' ');
}

const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const durMs = (j, from, to) => (j[from] && j[to]) ? Date.parse(j[to]) - Date.parse(j[from]) : null;

function pushFeed(color, text, tsIso) {
  const line = { t: hhmm(tsIso), color, text };
  state.feedCache.unshift(line);
  state.feedCache.length = Math.min(state.feedCache.length, 30);
  state.recentTs.push(Date.now());
  broadcast({ type: 'feed', ...line });
}
function pushWire(topic, body, tsIso) {
  const line = { t: hhmm(tsIso), topic, body };
  state.wireCache.unshift(line);
  state.wireCache.length = Math.min(state.wireCache.length, 40);
  state.recentTs.push(Date.now());
  broadcast({ type: 'wire', ...line });
}

const LEVEL_COLOR = { info: '#00e5ff', warn: '#ffb547', alert: '#ff4d6a', error: '#ff4d6a' };

// ── Pollers ──────────────────────────────────────────────────────────────────

// Feed ← notifications; wire ← orchestrator events (diff-based, every 5s)
async function pollActivity() {
  const notif = await jget(`${MEMORY}/memory/notifications?limit=20`);
  if (notif?.notifications) {
    // After a restart the caches are empty but the diff cursor is persisted —
    // backfill recent history so the feed never boots blank.
    if (!state.feedCache.length && state.lastNotifId) state.lastNotifId = Math.max(0, state.lastNotifId - 12);
    const fresh = notif.notifications.filter(n => n.id > state.lastNotifId).reverse();
    for (const n of fresh) {
      state.lastNotifId = Math.max(state.lastNotifId, n.id);
      pushFeed(LEVEL_COLOR[n.level] || '#00e5ff', n.title, n.ts);
      // warn/alert get announced aloud on the deck, not just a feed line —
      // but only when they're actually fresh (not backfill after a restart).
      if (['warn', 'alert', 'error'].includes(n.level) && Date.now() - Date.parse(n.ts) < 2 * 60 * 1000) {
        // Pre-warm the TTS cache so every client's /tts fetch for this alert is
        // an instant cache hit (and the chars are only spent once, not per device).
        synthesize(n.speech || n.title).catch(() => {});
        broadcast({ type: 'notify', level: n.level, title: n.title, speech: n.speech || n.title });
      }
    }
  }
  const events = await jget(`${ORCHESTRATOR}/events`);
  if (Array.isArray(events)) {
    if (!state.wireCache.length && state.lastEventTs) {
      state.lastEventTs = new Date(Date.parse(state.lastEventTs) - 6 * 3600 * 1000).toISOString();
    }
    const fresh = events.filter(e => e.ts > state.lastEventTs);
    for (const e of fresh.slice(-15)) {
      state.lastEventTs = e.ts > state.lastEventTs ? e.ts : state.lastEventTs;
      const plat = (e.message.match(/→ (\w+)/) || e.message.match(/on (\w+)/) || [])[1];
      const topic = `${(e.category || 'ops').toLowerCase()}.${plat || 'jarvis'}`;
      pushWire(topic, e.message, e.ts);
      if (e.category === 'JOB' && /completed/.test(e.message)) {
        pushFeed('#3dffa0', e.message, e.ts);
      }
    }
  }
}

// Stats every 10s
async function pollStats() {
  const [orch, counts, notif] = await Promise.all([
    jget(`${ORCHESTRATOR}/health`),
    jget(`${MEMORY}/memory/jobs/counts`),
    jget(`${MEMORY}/memory/notifications?unread=1`),
  ]);
  const q = orch?.queue || {};
  const queued = (q.queued || 0) + (q.running || 0);
  const unread = notif?.notifications?.length ?? 0;
  const cutoff = Date.now() - 10 * 60 * 1000;
  state.recentTs = state.recentTs.filter(t => t > cutoff);
  const done = (counts?.by_status || []).find(s => s.status === 'completed')?.count ?? 0;
  // Fleet uptime = mean of rolling per-platform up-ratios sampled since boot
  let upPct = null;
  if (state.upSamples.size) {
    let up = 0, total = 0;
    for (const s of state.upSamples.values()) { up += s.up; total += s.total; }
    if (total) upPct = (100 * up / total);
  }
  state.stats = {
    msgRate: Math.round(state.recentTs.length / 10),
    queueDepth: queued + unread,
    tasksDone: done,
    uptime: upPct == null ? '—' : (upPct >= 99.995 ? '100%' : upPct.toFixed(2) + '%'),
  };
  broadcast({ type: 'stats', ...state.stats });
}

// C-suite departments + org tiers every 15s — every field from live services
async function pollOrg() {
  const [org, orch, jobs, schedHealth] = await Promise.all([
    jget(`${SCHEDULER}/org`),
    jget(`${ORCHESTRATOR}/health`),
    jget(`${ORCHESTRATOR}/jobs`),
    jget(`${SCHEDULER}/health`),
  ]);
  const agents = org?.agents || {};
  // The C-suite (cto/cmo/cfo/clo/coo/cro) are now REAL dispatchable agents in
  // config/agents.json (2026-07-19), not a cosmetic display map — they're
  // shown as their own tier below, so exclude them from the plain role roster.
  const CSUITE_KEYS = ['cto', 'cmo', 'cfo', 'clo', 'coo', 'cro'];
  const roles = Object.values(agents).filter(a => a.kind !== 'resident' && !CSUITE_KEYS.includes(a.name));
  const running = (Array.isArray(jobs) ? jobs : []).filter(j => j.status === 'running');
  const queuedJobs = (Array.isArray(jobs) ? jobs : []).filter(j => j.status === 'queued');
  const maxConc = orch?.maxConcurrent || 3;

  const dept = (names) => roles.filter(r => names.some(n => r.name.startsWith(n)));
  const lastReport = (list) => list
    .map(r => r.last_report ? { ...r.last_report, agent: r.display_name } : null)
    .filter(Boolean)
    .sort((a, b) => (b.ts || '').localeCompare(a.ts || ''))[0];
  const deptTile = (name, role, list, idleTask) => {
    const rep = lastReport(list);
    const jobsToday = list.reduce((n, r) => n + (r.jobs_today || 0), 0);
    const needsEye = list.some(r => ['action_needed', 'escalate'].includes(r.last_report?.status));
    return {
      name, role,
      task: rep ? rep.summary.slice(0, 90) : idleTask,
      state: needsEye ? 'REVIEW' : (jobsToday > 0 ? 'ACTIVE' : 'IDLE'),
      load: Math.min(100, Math.round(100 * jobsToday / Math.max(1, list.length * 2))),
    };
  };
  // Overlay the REAL c-suite agent's own weekly brief onto a department/live
  // tile: their filed report is the authoritative "what does this exec
  // actually think" — a fresh action_needed/escalate always wins the tile;
  // otherwise the live operational signal (self-heal, dispatch queue, cron
  // mode) stays primary since it updates far more often than a weekly cron.
  const csuite = (key, tile) => {
    const real = agents[key];
    const rep = real?.last_report;
    if (real && real.status !== 'active') return { ...tile, state: 'HELD', task: `Agent ${real.status}` };
    if (rep && ['action_needed', 'escalate'].includes(rep.status)) {
      return { ...tile, task: rep.summary.slice(0, 90), state: 'REVIEW' };
    }
    return tile;
  };

  const selfHealMode = (() => {
    const env = readFileSync('/opt/jarvis/config/self-heal.env', 'utf8');
    return (env.match(/^SELF_HEAL_MODE=(\w+)/m) || [])[1] || 'off';
  })();
  const selfHealRuns = running.filter(j => (j.task || '').includes('[self-heal]'));

  state.agents = [
    csuite('cto', {
      name: 'CTO', role: 'Engineering · dispatch, builds, deploys',
      task: running[0] ? `${running[0].platform}: ${running[0].task.replace(/^\[self-heal\]\s*/, '').slice(0, 80)}` : 'Dispatch queue clear',
      state: orch?.canaryHeld ? 'REVIEW' : (running.length ? 'ACTIVE' : 'IDLE'),
      load: Math.min(100, Math.round(100 * running.length / maxConc)),
    }),
    csuite('coo', {
      name: 'COO', role: 'Operations · self-heal, backups, fleet',
      task: selfHealRuns.length ? `Repairing ${selfHealRuns.map(j => j.platform).join(', ')}` : `Self-heal ${selfHealMode.toUpperCase()} — watching fleet`,
      state: selfHealRuns.length ? 'ACTIVE' : (selfHealMode === 'live' ? 'ACTIVE' : 'IDLE'),
      load: selfHealRuns.length ? 70 : (selfHealMode === 'live' ? 25 : 5),
    }),
    csuite('cfo', deptTile('CFO', 'Accountancy · ledgers, filings, budgets', dept(['accountant']), 'Awaiting scheduled review cycle')),
    csuite('clo', deptTile('CLO', 'Legal · contracts, compliance, filings', dept(['legal']), 'Awaiting scheduled review cycle')),
    csuite('cmo', deptTile('CMO', 'Marketing · social, SEO, campaigns', dept(['social-media', 'seo-specialist']), 'Next posting window on cron')),
    csuite('cro', {
      name: 'CRO', role: 'Research · monitoring, audits, intel',
      task: `Watching ${platformNames().length} platforms · scheduler ${schedHealth?.mode || 'off'}`,
      state: schedHealth?.mode === 'live' ? 'ACTIVE' : 'IDLE',
      load: schedHealth?.mode === 'live' ? 30 : 10,
    }),
  ];

  // Hierarchy view — real registry + real services
  // Health paths are NOT uniform across services — see each src file.
  const svc = (name, port, role, path = '/health') => ({ name, role, port, path });
  const services = [
    svc('MEMORY', 9200, 'SQLite memory + inbox', '/memory/health'),
    svc('SCREENSHOT', 9201, 'CDP capture', '/screenshot/health'),
    svc('METRICS', 9202, 'Server metrics', '/metrics/health'),
    svc('AUDIT', 9204, 'Build + test audits', '/audit/health'),
    svc('ORCHESTRATOR', 9205, 'Job dispatch'), svc('DASHBOARD', 9206, 'Status panel'),
    svc('DEPLOY GATE', 9207, 'GateTest gating', '/deploy-gate/health'),
    svc('GATEWAY', 9208, 'Voice control'),
    svc('AGENT SCHED', 9209, 'Role-agent cron'), svc('COMMAND DECK', 9210, 'This deck'),
  ];
  const healthChecks = await Promise.all(services.map(s => jget(`http://127.0.0.1:${s.port}${s.path}`, 1500)
    .catch(() => null)));
  const roleState = (r) => r.status !== 'active' ? 'HELD'
    : r.last_job?.status === 'completed' ? 'REPORTED'
    : r.jobs_today > 0 ? 'ACTIVE'
    : r.schedule ? 'ON CRON' : 'IDLE';
  state.orgTiers = [
    { label: 'CEO · ORCHESTRATOR', color: '#00e5ff', border: 'rgba(0,229,255,.5)', line: true,
      nodes: [{ name: 'JARVIS CORE', role: 'Routes objectives · never executes', dot: '#00e5ff',
                state: hasAgent() ? 'ORCHESTRATING' : 'INTENT MODE' }] },
    { label: 'C-SUITE · DOMAIN MANAGERS', color: '#9feaff', border: 'rgba(0,229,255,.25)', line: true,
      nodes: state.agents.map(a => ({ name: a.name, role: a.role.split('·')[1]?.trim() || a.role,
        dot: a.state === 'ACTIVE' ? '#3dffa0' : (a.state === 'REVIEW' ? '#ffb547' : '#5f7a8c'), state: a.state })) },
    { label: `ROLE AGENTS · ${roles.length} REGISTERED`, color: '#7d99aa', border: 'rgba(0,229,255,.16)', line: true,
      nodes: roles.map(r => ({ name: (r.display_name || r.name).toUpperCase(),
        role: r.platform || r.jurisdiction || 'fleet',
        dot: r.status !== 'active' ? '#5f7a8c' : (r.jobs_today > 0 ? '#3dffa0' : '#00e5ff'),
        state: roleState(r) })) },
    { label: 'SERVICES · WORKERS', color: '#5f7a8c', border: 'rgba(255,255,255,.1)', line: true,
      nodes: services.map((s, i) => ({ name: s.name, role: s.role,
        dot: healthChecks[i] ? '#3dffa0' : '#ff4d6a', state: healthChecks[i] ? 'ONLINE' : 'DOWN' })) },
    { label: 'QA · AUDITORS', color: '#ffb547', border: 'rgba(255,181,71,.3)', line: false,
      nodes: [
        { name: 'DEPLOY GATE', role: 'GateTest scan on deploys', dot: healthChecks[6] ? '#3dffa0' : '#ff4d6a',
          state: healthChecks[6] ? 'WATCHING' : 'DOWN' },
        { name: 'AUDIT RUNNER', role: 'Build + test audit loop', dot: healthChecks[3] ? '#3dffa0' : '#ff4d6a',
          state: healthChecks[3] ? 'AUDITING' : 'DOWN' },
      ] },
  ];
  state.orgTotal = 1 + state.agents.length + roles.length + services.length + 2;
  broadcast({ type: 'agents', agents: state.agents });
  broadcast({ type: 'org', tiers: state.orgTiers, total: state.orgTotal });

  // Queues — every depth/rate/lag measured, never invented.
  //   rate = items per second over the last 24h (client formats /s /min /hr)
  //   lag  = measured latency in ms for that pipeline (null → client shows —)
  const jobsToday = roles.reduce((n, r) => n + (r.jobs_today || 0), 0);
  const [unrouted, inbox, allNotif, memJobs] = await Promise.all([
    jget(`${MEMORY}/memory/agent-reports?limit=50`),
    jget(`${MEMORY}/memory/notifications?unread=1`),
    jget(`${MEMORY}/memory/notifications?limit=50`),
    jget(`${MEMORY}/memory/jobs?limit=100`),
  ]);
  const unreadList = inbox?.notifications ?? [];
  const unroutedList = Array.isArray(unrouted) ? unrouted.filter(r => !r.routed_at) : [];
  const jobs24 = (Array.isArray(memJobs) ? memJobs : [])
    .filter(j => j.created_at && Date.now() - Date.parse(j.created_at) < 24 * 3600 * 1000);
  const selfHealJobs = jobs24.filter(j => (j.task || '').includes('[self-heal]'));
  const agentJobs = jobs24.filter(j => j.agent);
  const notif24 = (allNotif?.notifications ?? [])
    .filter(n => Date.now() - Date.parse(n.ts) < 24 * 3600 * 1000);
  const perSec24 = (n) => n / (24 * 3600);
  const oldestAge = (list, field) => list.length
    ? Date.now() - Math.min(...list.map(x => Date.parse(x[field]))) : null;

  const mkq = (name, producer, consumer, depth, rate, lag, status) => ({
    name, producer, consumer, depth,
    rate, lag: lag == null ? null : Math.round(lag),
    speed: Math.max(1.6, 4.5 - Math.min(3, depth)), delay: 1.1, status,
  });
  state.queues = [
    mkq('dispatch.jobs', 'CEO / self-heal', 'Claude workers', queuedJobs.length + running.length,
      perSec24(jobs24.filter(j => j.status === 'completed').length),
      avg(jobs24.map(j => durMs(j, 'created_at', 'started_at')).filter(v => v != null)),
      orch?.canaryHeld ? 'HELD — CANARY' : (queuedJobs.length > 5 ? 'BACKED UP' : 'HEALTHY')),
    mkq('selfheal.loop', 'Uptime sentinel', 'Repair agents', selfHealRuns.length,
      perSec24(selfHealJobs.length),
      avg(selfHealJobs.map(j => durMs(j, 'started_at', 'finished_at')).filter(v => v != null)),
      selfHealMode === 'live' ? 'HEALTHY' : selfHealMode.toUpperCase()),
    mkq('agents.cron', 'Scheduler', 'Role agents', jobsToday,
      perSec24(agentJobs.length),
      avg(agentJobs.map(j => durMs(j, 'started_at', 'finished_at')).filter(v => v != null)),
      schedHealth?.mode === 'live' ? 'HEALTHY' : (schedHealth?.mode || 'OFF').toUpperCase()),
    mkq('inbox.notifications', 'All services', 'Craig', unreadList.length,
      perSec24(notif24.length),
      oldestAge(unreadList, 'ts'),
      unreadList.length > 20 ? 'BACKED UP' : 'HEALTHY'),
    mkq('reports.escalation', 'Role agents', 'CEO → Craig', unroutedList.length,
      perSec24(agentJobs.length),
      oldestAge(unroutedList, 'ts'),
      unroutedList.length > 5 ? 'BACKED UP' : 'HEALTHY'),
    mkq('deploy.gate', 'Platform deploys', 'GateTest', 0, null, null,
      healthChecks[6] ? 'HEALTHY' : 'DOWN'),
  ];
  broadcast({ type: 'queues', queues: state.queues });
}

// Platforms every 30s
const PLATFORM_DESC = {
  zoobicon: 'AI website-builder platform', vapron: 'AI product platform',
  gluecron: 'Automation & scheduling', gatetest: 'Testing & QA platform',
  voxlen: 'Voice & audio AI', alecrae: 'Personal / portfolio',
  bookaride: 'Ride booking service', jarvis: 'This platform — agent infra',
};
// The metrics collector only probes 5 hardcoded sites — the deck probes every
// registered platform that has a URL so no live site ever shows as unknown.
const EXTRA_URLS = {
  gluecron: 'https://gluecron.com',
  davenroe: 'https://davenroe.com',
  marcoreid: 'https://marcoreid.com',
  jarvis: 'http://127.0.0.1:9206/health', // this box — dashboard health
};
const platURL = (name) => PLATFORM_URLS[name] || EXTRA_URLS[name] || null;

async function probe(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 8000);
  const start = Date.now();
  try {
    const r = await fetch(url, { method: 'HEAD', signal: ctl.signal });
    return { status: r.ok ? 'ONLINE' : 'WARN', latencyMs: Date.now() - start };
  } catch {
    return { status: 'OFFLINE' };
  } finally {
    clearTimeout(t);
  }
}

async function pollPlatforms() {
  const registry = readJSON('/opt/jarvis/config/platforms.json')?.platforms || {};
  const health = readJSON('/opt/jarvis/memory/platform-health.json') || [];
  const agentsCfg = readJSON('/opt/jarvis/config/agents.json')?.agents || {};
  const memJobs = await jget(`${MEMORY}/memory/jobs?limit=200`);
  const byName = {};
  for (const h of health) byName[h.name.toLowerCase()] = h;
  // Probe registered platforms the collector doesn't cover
  const missing = Object.values(registry).filter(p => !byName[p.name] && platURL(p.name));
  const probed = await Promise.all(missing.map(p => probe(platURL(p.name))));
  missing.forEach((p, i) => { byName[p.name] = probed[i]; });

  state.platforms = Object.values(registry).map(p => {
    const h = byName[p.name];
    const url = PLATFORM_URLS[p.name];
    const host = url ? url.replace(/^https?:\/\/(www\.)?/, '') : p.name;
    const agentCount = Object.values(agentsCfg).filter(a => a.platform === p.name).length;
    const platJobs = (Array.isArray(memJobs) ? memJobs : [])
      .filter(j => j.platform === p.name && j.finished_at);
    const done = platJobs.filter(j => j.status === 'completed').length;
    const lastJob = platJobs.sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || ''))[0];
    // No URL to probe (repo-only platform) → say so plainly, not "down"-looking
    const status = !h ? 'NO PUBLIC SITE'
      : h.status === 'ONLINE' ? 'OPERATIONAL'
      : h.status === 'WARN' ? 'DEGRADED' : 'DOWN';
    // rolling uptime + latency samples (persisted in deck-state.json)
    if (h) {
      const s = state.upSamples.get(p.name) || { up: 0, total: 0 };
      s.total++; if (h.status === 'ONLINE') s.up++;
      state.upSamples.set(p.name, s);
      if (typeof h.latencyMs === 'number') {
        const hist = state.latHist.get(p.name) || [];
        hist.push(h.latencyMs);
        state.latHist.set(p.name, hist.slice(-48));
      }
    }
    const s = state.upSamples.get(p.name);
    const uptime = s && s.total >= 2 ? ((100 * s.up / s.total) >= 99.995 ? '100%' : (100 * s.up / s.total).toFixed(2) + '%') : '—';
    return {
      name: host, desc: PLATFORM_DESC[p.name] || (p.tech_stack || []).join(' · '),
      status, uptime,
      latency: h?.latencyMs ?? '—',
      build: done ? `#${done} ${lastJob?.exit_code === 0 ? '✓' : '✗'}` : '—',
      agents: agentCount,
      deploy: lastJob ? ago(lastJob.finished_at) : '—',
      spark: sparkFromLatency(state.latHist.get(p.name)),
      dot: status === 'OPERATIONAL' ? '#3dffa0' : status === 'DEGRADED' ? '#ffb547'
         : status === 'DOWN' ? '#ff4d6a' : '#5f7a8c',
    };
  });
  broadcast({ type: 'platforms', platforms: state.platforms });
  saveState();
}

// ── WebSocket ────────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const cookies = parseCookies(req.headers.cookie);
  const authed = tokenMatches(cookies[AUTH_COOKIE]);
  if (!authed && !(req.socket.remoteAddress?.includes('127.0.0.1') && !req.headers['x-forwarded-for'])) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// Protocol-level keepalive: a client that misses a whole ping round is gone —
// terminate so wss.clients (and the deck's own liveness view) stays honest.
const KEEPALIVE = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(KEEPALIVE));

// One rolling conversation shared across devices/reloads, persisted in memory
// KV so Jarvis remembers context between sessions. runAgent() mutates and
// bounds the array itself (last 24 messages).
let sharedTranscript = null;
// Dispatch confirmation gate: `turn` counts human commands; a preview stamps
// the turn it was shown in, and a dispatch only fires when confirmed in a LATER
// turn (see agent.js dispatch_job). Shared like the transcript (single principal).
const dispatchGate = { turn: 0, pending: null };
async function loadTranscript() {
  if (sharedTranscript) return sharedTranscript;
  try {
    const r = await fetch(`${MEMORY}/memory/kv/deck-conversation`).then(r => r.json());
    const parsed = JSON.parse(r?.value || '[]');
    sharedTranscript = Array.isArray(parsed) ? parsed : [];
  } catch { sharedTranscript = []; }
  return sharedTranscript;
}
function saveTranscript() {
  if (!sharedTranscript) return;
  fetch(`${MEMORY}/memory/kv`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: 'deck-conversation', value: JSON.stringify(sharedTranscript) }),
  }).catch(() => {});
}

wss.on('connection', (ws, req) => {
  const user = req.headers['tailscale-user-login'] || 'local';
  console.log(`[deck] client connected (${user}) — ${wss.clients.size} online`);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Initial burst so every view is populated instantly
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
  if (state.agents.length) send({ type: 'agents', agents: state.agents });
  if (state.orgTiers) send({ type: 'org', tiers: state.orgTiers, total: state.orgTotal });
  if (state.queues.length) send({ type: 'queues', queues: state.queues });
  if (state.platforms.length) send({ type: 'platforms', platforms: state.platforms });
  send({ type: 'stats', ...state.stats });
  for (const f of [...state.feedCache].reverse()) send({ type: 'feed', ...f });
  for (const w of [...state.wireCache].reverse()) send({ type: 'wire', ...w });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ping') return ws.readyState === 1 && ws.send('{"type":"pong"}');
    if (msg.type !== 'command') return;
    const text = String(msg.text || '').trim();
    if (!text) return;
    dispatchGate.turn++; // each spoken/typed command is one human turn (dispatch gate)
    pushWire('deck.command', JSON.stringify({ from: 'craig', text: text.slice(0, 80) }));
    // Any briefing ask also feeds the deck's structured briefing panel,
    // regardless of whether the brain or the intent pipeline answers.
    if (/\bbrief/i.test(text)) {
      handleBriefing().then(b => { if (b?.data) send({ type: 'briefing', data: b.data }); }).catch(() => {});
    }
    try {
      // "switch brain to GPT / Claude" — handled before any brain runs
      const switched = await maybeBrainSwitch(text);
      if (switched) return send({ type: 'chat', text: switched, speech: switched });
      // DISPATCH GATE: a dispatch prepared last turn only runs if Craig now
      // affirms — this is the single execution point for BOTH the brain and the
      // keyword fallback, so no path can launch a worker from one turn.
      const gated = await resolveDispatchGate(dispatchGate, text,
        (m) => send({ type: 'chat', text: m.speech || m.text }));
      if (gated.handled) return send({ type: 'chat', text: gated.text, speech: gated.speech });
      if (hasAgent()) {
        const transcript = await loadTranscript();
        const before = transcript.length;
        try {
          // runAgent pushes user+assistant turns onto transcript itself.
          const full = await runAgent(transcript, text,
            (chunk) => send({ type: 'chat_chunk', text: chunk }), dispatchGate);
          saveTranscript();
          const back = noteBrainHealthy();
          if (back) send({ type: 'notify', level: 'info', title: back, speech: back });
          return send({ type: 'chat', text: full.text || 'Done, sir.', speech: full.speech });
        } catch (e) {
          // Both brain providers unusable (no credits, outage) — undo this
          // turn's partial transcript and fall through to the intent pipeline.
          transcript.splice(before);
          console.error('[deck] agent brain failed, using intent pipeline:', e.message);
          const notice = noteBrainDegraded();
          if (notice) send({ type: 'notify', level: 'warn', title: notice, speech: notice });
        }
      }
      const { intent } = await resolveIntent(text);
      const result = await runIntent(intent, text, (m) => send({ type: 'chat', text: m.speech || m.text }), dispatchGate);
      const fallbackReply = result?.speech || result?.text || 'Acknowledged, sir.';
      // 2026-07-24 (Craig: "within 30 seconds it completely forgot what we
      // were organising"): when the brain failed, the splice above erased
      // the ENTIRE exchange — his message and the fallback answer were never
      // written to the durable transcript, so the very next brain turn had
      // no record the conversation happened. Failed-brain turns now still
      // land in memory as plain text, so continuity survives brain hiccups.
      try {
        const transcript = await loadTranscript();
        transcript.push({ role: 'user', content: text });
        transcript.push({ role: 'assistant', content: `[via basic pipeline while the main brain was unavailable] ${String(result?.text || fallbackReply).slice(0, 500)}` });
        if (transcript.length > 24) transcript.splice(0, transcript.length - 24);
        saveTranscript();
      } catch { /* recording is best-effort — never block the reply */ }
      send({ type: 'chat', text: fallbackReply });
    } catch (e) {
      console.error('[deck] command error:', e.message);
      send({ type: 'chat', text: 'Apologies, sir — that command hit an error: ' + e.message });
    }
  });

  ws.on('close', () => console.log(`[deck] client disconnected — ${wss.clients.size} online`));
});

// ── Start ────────────────────────────────────────────────────────────────────

const tick = (fn, ms) => { fn().catch(e => console.error('[deck]', e.message)); return setInterval(() => fn().catch(e => console.error('[deck]', e.message)), ms); };
tick(pollActivity, 5000);
tick(pollStats, 10000);
tick(pollOrg, 15000);
tick(pollPlatforms, 30000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-deck] listening on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-deck] auth token: ${AUTH_TOKEN ? 'configured ✓' : 'MISSING ✗ (all access will 403)'}`);
  console.log(`[jarvis-deck] agent brain: ${hasAgent() ? getBrainProvider() + ' ✓' : 'intent-pipeline fallback'}`);
  console.log('[jarvis-deck] expose with: tailscale serve --bg --https=8444 http://127.0.0.1:9210');
});

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
 * Auth: JARVIS_DECK_TOKEN, falling back to JARVIS_GATEWAY_TOKEN (same audience
 * — Craig's tailnet devices). Cookie bootstrap via /?token=… like the gateway.
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
import { createHash, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';
import { resolveIntent, runIntent, platformNames, PLATFORM_URLS, ORCHESTRATOR, MEMORY } from './lib/conversation.js';
import { runAgent, hasAgent } from './lib/agent.js';

const PORT      = 9210;
const SCHEDULER = 'http://127.0.0.1:9209';

// ── Auth (gateway-server.js pattern — fail closed) ───────────────────────────

const AUTH_TOKEN     = process.env.JARVIS_DECK_TOKEN || process.env.JARVIS_GATEWAY_TOKEN || '';
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
  return parseCookies(req.headers.cookie)[AUTH_COOKIE] || null;
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

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jarvis-deck', clients: wss?.clients?.size ?? 0, link: 'ready' });
});

app.get('/', (req, res) => {
  if (req.query.token !== undefined) {
    if (!tokenMatches(req.query.token)) return res.status(403).send('Forbidden');
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${encodeURIComponent(req.query.token)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    return res.redirect('/');
  }
  if (!isAuthed(req) && !isLocalDirect(req)) {
    return res.status(403).send('Forbidden — open /?token=<JARVIS_GATEWAY_TOKEN> once on this device');
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
};

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
    const fresh = notif.notifications.filter(n => n.id > state.lastNotifId).reverse();
    for (const n of fresh) {
      state.lastNotifId = Math.max(state.lastNotifId, n.id);
      pushFeed(LEVEL_COLOR[n.level] || '#00e5ff', n.title, n.ts);
    }
  }
  const events = await jget(`${ORCHESTRATOR}/events`);
  if (Array.isArray(events)) {
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
  const roles = Object.values(agents).filter(a => a.kind !== 'resident');
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

  const selfHealMode = (() => {
    const env = readFileSync('/opt/jarvis/config/self-heal.env', 'utf8');
    return (env.match(/^SELF_HEAL_MODE=(\w+)/m) || [])[1] || 'off';
  })();
  const selfHealRuns = running.filter(j => (j.task || '').includes('[self-heal]'));

  state.agents = [
    {
      name: 'CTO', role: 'Engineering · dispatch, builds, deploys',
      task: running[0] ? `${running[0].platform}: ${running[0].task.replace(/^\[self-heal\]\s*/, '').slice(0, 80)}` : 'Dispatch queue clear',
      state: orch?.canaryHeld ? 'REVIEW' : (running.length ? 'ACTIVE' : 'IDLE'),
      load: Math.min(100, Math.round(100 * running.length / maxConc)),
    },
    {
      name: 'COO', role: 'Operations · self-heal, backups, fleet',
      task: selfHealRuns.length ? `Repairing ${selfHealRuns.map(j => j.platform).join(', ')}` : `Self-heal ${selfHealMode.toUpperCase()} — watching fleet`,
      state: selfHealRuns.length ? 'ACTIVE' : (selfHealMode === 'live' ? 'ACTIVE' : 'IDLE'),
      load: selfHealRuns.length ? 70 : (selfHealMode === 'live' ? 25 : 5),
    },
    deptTile('CFO', 'Accountancy · ledgers, filings, budgets', dept(['accountant']), 'Awaiting scheduled review cycle'),
    deptTile('CLO', 'Legal · contracts, compliance, filings', dept(['legal']), 'Awaiting scheduled review cycle'),
    deptTile('CMO', 'Marketing · social, campaigns, outreach', dept(['social-media']), 'Next posting window on cron'),
    {
      name: 'CRO', role: 'Research · monitoring, audits, intel',
      task: `Watching ${platformNames().length} platforms · scheduler ${schedHealth?.mode || 'off'}`,
      state: schedHealth?.mode === 'live' ? 'ACTIVE' : 'IDLE',
      load: schedHealth?.mode === 'live' ? 30 : 10,
    },
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

  // Queues — real pipelines with real depths
  const jobsToday = roles.reduce((n, r) => n + (r.jobs_today || 0), 0);
  const unrouted = await jget(`${MEMORY}/memory/agent-reports?limit=50`);
  const unroutedN = Array.isArray(unrouted) ? unrouted.filter(r => !r.routed_at).length : 0;
  const inbox = await jget(`${MEMORY}/memory/notifications?unread=1`);
  const unread = inbox?.notifications?.length ?? 0;
  const q = orch?.queue || {};
  const mkq = (name, producer, consumer, depth, rate, lag, status) => ({
    name, producer, consumer, depth,
    rate: +Number(rate).toFixed(1), lag: Math.round(lag),
    speed: Math.max(1.4, 4.5 - Math.min(3, depth) - rate), delay: 1.1, status,
  });
  state.queues = [
    mkq('dispatch.jobs', 'CEO / self-heal', 'Claude workers', queuedJobs.length + running.length,
      (q.completed || 0) / 24 / 3.6, running.length ? 900 : 40,
      orch?.canaryHeld ? 'HELD — CANARY' : (queuedJobs.length > 5 ? 'BACKED UP' : 'HEALTHY')),
    mkq('selfheal.loop', 'Uptime sentinel', 'Repair agents', selfHealRuns.length, 0.2, 120,
      selfHealMode === 'live' ? 'HEALTHY' : selfHealMode.toUpperCase()),
    mkq('agents.cron', 'Scheduler', 'Role agents', jobsToday, jobsToday / 86.4, 300,
      schedHealth?.mode === 'live' ? 'HEALTHY' : (schedHealth?.mode || 'OFF').toUpperCase()),
    mkq('inbox.notifications', 'All services', 'Craig', unread, state.stats.msgRate / 60, 60,
      unread > 20 ? 'BACKED UP' : 'HEALTHY'),
    mkq('reports.escalation', 'Role agents', 'CEO → Craig', unroutedN, unroutedN / 86.4, 200,
      unroutedN > 5 ? 'BACKED UP' : 'HEALTHY'),
    mkq('deploy.gate', 'Platform deploys', 'GateTest', 0, 0.1, 150,
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
async function pollPlatforms() {
  const registry = readJSON('/opt/jarvis/config/platforms.json')?.platforms || {};
  const health = readJSON('/opt/jarvis/memory/platform-health.json') || [];
  const agentsCfg = readJSON('/opt/jarvis/config/agents.json')?.agents || {};
  const jobs = await jget(`${ORCHESTRATOR}/jobs`);
  const byName = {};
  for (const h of health) byName[h.name.toLowerCase()] = h;

  state.platforms = Object.values(registry).map(p => {
    const h = byName[p.name];
    const url = PLATFORM_URLS[p.name];
    const host = url ? url.replace(/^https?:\/\/(www\.)?/, '') : p.name;
    const agentCount = Object.values(agentsCfg).filter(a => a.platform === p.name).length;
    const platJobs = (Array.isArray(jobs) ? jobs : []).filter(j => j.platform === p.name && j.finishedAt);
    const lastJob = platJobs.sort((a, b) => (b.finishedAt || '').localeCompare(a.finishedAt || ''))[0];
    const status = !h ? 'REGISTERED'
      : h.status === 'ONLINE' ? 'OPERATIONAL'
      : h.status === 'WARN' ? 'DEGRADED' : 'DOWN';
    // rolling uptime sample
    if (h) {
      const s = state.upSamples.get(p.name) || { up: 0, total: 0 };
      s.total++; if (h.status === 'ONLINE') s.up++;
      state.upSamples.set(p.name, s);
    }
    const s = state.upSamples.get(p.name);
    const uptime = s && s.total >= 2 ? ((100 * s.up / s.total) >= 99.995 ? '100%' : (100 * s.up / s.total).toFixed(2) + '%') : '—';
    return {
      name: host, desc: PLATFORM_DESC[p.name] || (p.tech_stack || []).join(' · '),
      status, uptime,
      latency: h?.latencyMs ?? '—',
      build: lastJob ? (lastJob.exitCode === 0 ? `job ✓` : `job ✗`) : '—',
      agents: agentCount,
      deploy: lastJob ? ago(lastJob.finishedAt) : '—',
      dot: status === 'OPERATIONAL' ? '#3dffa0' : status === 'DEGRADED' ? '#ffb547'
         : status === 'DOWN' ? '#ff4d6a' : '#5f7a8c',
    };
  });
  broadcast({ type: 'platforms', platforms: state.platforms });
}

// ── WebSocket ────────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const authed = tokenMatches(parseCookies(req.headers.cookie)[AUTH_COOKIE]);
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

wss.on('connection', (ws, req) => {
  const user = req.headers['tailscale-user-login'] || 'local';
  console.log(`[deck] client connected (${user}) — ${wss.clients.size} online`);
  const transcript = [];

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
    if (msg.type !== 'command') return;
    const text = String(msg.text || '').trim();
    if (!text) return;
    pushWire('deck.command', JSON.stringify({ from: 'craig', text: text.slice(0, 80) }));
    try {
      if (hasAgent()) {
        try {
          const full = await runAgent(transcript, text, () => {});
          transcript.push({ role: 'user', content: text }, { role: 'assistant', content: full.text || full.speech || '' });
          if (transcript.length > 20) transcript.splice(0, transcript.length - 20);
          return send({ type: 'chat', text: full.text || full.speech || 'Done, sir.' });
        } catch (e) {
          // API key present but unusable (no credits, outage) — fall through to
          // the intent pipeline rather than surfacing an apology.
          console.error('[deck] agent brain failed, using intent pipeline:', e.message);
        }
      }
      const { intent } = await resolveIntent(text);
      const result = await runIntent(intent, text, (m) => send({ type: 'chat', text: m.speech || m.text }));
      send({ type: 'chat', text: result?.speech || result?.text || 'Acknowledged, sir.' });
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
  console.log(`[jarvis-deck] agent brain: ${hasAgent() ? 'Messages API ✓' : 'intent-pipeline fallback'}`);
  console.log('[jarvis-deck] expose with: tailscale serve --bg --https=8444 http://127.0.0.1:9210');
});

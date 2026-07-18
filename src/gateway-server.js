/**
 * Jarvis Gateway — src/gateway-server.js  (spec: docs/GATEWAY.md)
 *
 * The Jarvis-native conversational interface: voice/text over the tailnet.
 * Binds 127.0.0.1:9208 ONLY; exposed exclusively via
 *   tailscale serve --bg --https=8443 http://127.0.0.1:9208
 * which terminates HTTPS with a real cert on jarvis.tailbd6217.ts.net (required
 * for iOS microphone access) and is reachable from tailnet devices only.
 * NOTE: NOT port 443 — Coolify's Traefik (docker-proxy) binds 0.0.0.0:443,
 * which blocks tailscaled from ever getting its own :443 listener. Confirmed
 * 2026-07-09: tailscaled logged "bind: address already in use" for both the
 * v4 and v6 tailscale-IP listeners. Use a free port (8443) instead of fighting
 * Traefik for :443 — do not touch Traefik's port publishing (Rule 4).
 *
 * Auth model:
 *   - Perimeter = tailnet membership (tailscale serve never faces the internet).
 *   - Defense in depth = JARVIS_GATEWAY_TOKEN cookie/bearer (same pattern as
 *     dashboard-server.js). Fails CLOSED if the token is unset.
 *   - Requests proxied by tailscale serve carry X-Forwarded-For +
 *     Tailscale-User-Login headers; direct loopback calls (other Jarvis
 *     services hitting /internal/*) carry neither.
 *
 * WS protocol (docs/GATEWAY.md):
 *   in : {type:'utterance', text, mode:'auto'|'converse'} | {type:'dispatch', platform, task} | {type:'ping'}
 *   out: {type:'reply', text, speech, intent, via, ms} | {type:'reply_chunk', text} |
 *        {type:'reply_done', speech} | {type:'notify', notification} |
 *        {type:'dispatch_result', payload} | {type:'job_update', payload} | {type:'pong'}
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { spawn } from 'child_process';
import { resolveIntent, runIntent, resolveDispatchGate, platformNames, loadRoadmap } from './lib/conversation.js';
import { runAgent, hasAgent, maybeBrainSwitch, noteBrainDegraded, noteBrainHealthy } from './lib/agent.js';
import { notify } from './lib/notify.js';

const PORT         = 9208;
const ORCHESTRATOR = 'http://127.0.0.1:9205';
const MEMORY       = 'http://127.0.0.1:9200';

// ── Auth (dashboard-server.js pattern — fail closed) ────────────────────────

const AUTH_TOKEN     = process.env.JARVIS_GATEWAY_TOKEN || '';
const AUTH_COOKIE    = 'jarvis_gw_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds

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

// Direct loopback call from another Jarvis service (no proxy hop)?
function isLocalService(req) {
  const ip = req.socket.remoteAddress;
  return (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')
    && !req.headers['x-forwarded-for'];
}

function isAuthed(req) {
  return tokenMatches(requestToken(req));
}

// ── App ──────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// GET /health — open (mirrors dashboard convention)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jarvis-gateway', clients: wss?.clients?.size ?? 0 });
});

// Token bootstrap: /?token=... sets the cookie once per device, then redirects clean.
// CONSOLIDATED (2026-07-17): the Command Deck is the one Jarvis. This old voice
// UI now forwards there, so any old bookmark/home-screen icon lands on the Deck.
// The internal endpoints below (/ws, /internal/notify, /health) are unchanged —
// the gateway server keeps running for notification fan-out, it just no longer
// serves a separate human page.
const DECK_URL = 'https://jarvis.tailbd6217.ts.net:8444/';
app.get('/', (_req, res) => res.redirect(302, DECK_URL));

app.get('/icon-180.png', (req, res) => {
  if (!isAuthed(req)) return res.status(403).end();
  res.sendFile('/opt/jarvis/public/icon-180.png');
});

// (Removed dead /jarvis-bg.mp4 + .jpg routes — leftovers from the rejected
// video-avatar experiment; no client references them and the assets are gone.)

// ── Internal endpoints (other Jarvis services / tailnet peers) ───────────────

// POST /internal/notify — live push of a notification to connected clients.
// Callers: src/lib/notify.js (loopback). Remote callers need the bearer token.
app.post('/internal/notify', (req, res) => {
  if (!isLocalService(req) && !isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const { source = 'jarvis', level = 'info', title, body, speech } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  broadcast({ type: 'notify', notification: { source, level, title, body: body ?? title, speech: speech ?? title, ts: new Date().toISOString() } });
  res.json({ ok: true, clients: wss.clients.size });
});

// POST /internal/heartbeat — dead-man's signal from tailnet peers (e.g. box 158).
// State-change transitions raise durable notifications; steady-state is silent.
const heartbeats = new Map(); // source → { last: ms-epoch, alerted: bool }
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

app.post('/internal/heartbeat', (req, res) => {
  if (!isLocalService(req) && !isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const { source, status = 'ok' } = req.body || {};
  if (!source) return res.status(400).json({ error: 'source required' });
  const prev = heartbeats.get(source);
  heartbeats.set(source, { last: Date.now(), alerted: false });
  if (prev?.alerted) {
    notify({ source: 'gateway-heartbeat', level: 'info', title: `💓 ${source} heartbeat recovered`, speech: `${source} is back.` });
  }
  res.json({ ok: true, status });
});

setInterval(() => {
  const now = Date.now();
  for (const [source, hb] of heartbeats) {
    if (!hb.alerted && now - hb.last > HEARTBEAT_STALE_MS) {
      hb.alerted = true;
      notify({
        source: 'gateway-heartbeat', level: 'alert',
        title: `🚨 ${source} heartbeat STALE — nothing received for ${Math.round((now - hb.last) / 60000)} min`,
        speech: `Alert. The ${source} heartbeat has gone stale.`,
      });
    }
  }
}, 60 * 1000);

// ── Roadmap (project-completion checklist, see docs/GATEWAY.md) ─────────────
// loadRoadmap() lives in lib/conversation.js — shared with the voice handler.

app.get('/api/roadmap', (req, res) => {
  if (!isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    res.json(loadRoadmap());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Inbox proxy (browser → memory service) ──────────────────────────────────

app.get('/api/inbox', async (req, res) => {
  if (!isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const qs = req.query.unread ? '?unread=1' : '';
    const r = await fetch(`${MEMORY}/memory/notifications${qs}`);
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/inbox/:id/read', async (req, res) => {
  if (!isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const path = req.params.id === 'all' ? 'read-all' : `${encodeURIComponent(req.params.id)}/read`;
    const r = await fetch(`${MEMORY}/memory/notifications/${path}`, { method: 'POST' });
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── Open-ended conversation (streamed Claude) ────────────────────────────────
//
// With ANTHROPIC_API_KEY: Messages API streaming (fast first token).
// Without: locally-authenticated `claude` CLI, non-streaming fallback.

const CONVERSE_MODEL = 'claude-fable-5'; // top-tier brain — Craig's call, 2026-07-16
const CONVERSE_SYSTEM = () => [
  'You are Jarvis, the ops assistant for Craig\'s platform estate, spoken to by voice.',
  `Platforms you manage: ${platformNames().join(', ')}.`,
  'Jarvis services run on this box (memory, metrics, screenshot, audit, orchestrator, gateway).',
  'Be concise and conversational — answers are read aloud. Prefer 1-3 sentences unless asked for detail.',
].join(' ');

async function converseStream(transcript, onChunk) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CONVERSE_MODEL,
        max_tokens: 1000,
        stream: true,
        system: CONVERSE_SYSTEM(),
        messages: transcript,
      }),
    });
    if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          const delta = ev?.delta?.text;
          if (delta) { full += delta; onChunk(delta); }
        } catch { /* keepalives / non-JSON lines */ }
      }
    }
    return full;
  }

  // CLI fallback — single shot, no streaming
  const prompt = `${CONVERSE_SYSTEM()}\n\nConversation so far:\n` +
    transcript.map(t => `${t.role === 'user' ? 'Craig' : 'Jarvis'}: ${t.content}`).join('\n') +
    '\nJarvis:';
  const full = await new Promise((resolve) => {
    let out = '';
    const proc = spawn('claude', ['--model', CONVERSE_MODEL, '--print', prompt],
      { env: { ...process.env, HOME: '/root' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(out || 'Sorry, that took too long.'); }, 60000);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve('Sorry, my conversation engine is unavailable.'); });
    proc.on('close', () => { clearTimeout(timer); resolve(out.trim() || 'Sorry, I have no answer.'); });
  });
  onChunk(full);
  return full;
}

// ── WebSocket hub ────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!tokenMatches(parseCookies(req.headers.cookie)[AUTH_COOKIE])) {
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

// Watch a dispatched job and announce its completion.
const watchedJobs = new Set();
async function watchJob(jobId, platform) {
  if (!jobId || watchedJobs.has(jobId)) return;
  watchedJobs.add(jobId);
  const deadline = Date.now() + 30 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const jobs = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json());
      const job = (Array.isArray(jobs) ? jobs : []).find(j => j.id === jobId);
      if (!job) continue;
      if (job.status !== 'running') {
        const ok = job.status === 'completed';
        broadcast({ type: 'job_update', payload: job });
        notify({
          source: 'gateway-dispatch', level: ok ? 'info' : 'warn',
          title: `${ok ? '✅' : '❌'} Job ${jobId.slice(0, 8)} on ${platform} ${job.status}`,
          body: `Task: ${(job.task || '').slice(0, 200)}`,
          speech: `The ${platform} job ${ok ? 'finished successfully' : `ended with status ${job.status}`}.`,
        });
        break;
      }
    } catch { /* orchestrator hiccup — keep polling */ }
  }
  watchedJobs.delete(jobId);
}

wss.on('connection', (ws, req) => {
  const user = req.headers['tailscale-user-login'] || 'local';
  console.log(`[gateway] client connected (${user}) — ${wss.clients.size} online`);
  const transcript = []; // per-connection conversational memory (converse mode)
  const dispatchGate = { turn: 0, pending: null }; // dispatch confirmation gate (per connection)

  ws.send(JSON.stringify({ type: 'hello', platforms: platformNames() }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));

    if (msg.type === 'dispatch') {
      const { platform, task } = msg;
      if (!platform || !task) {
        return ws.send(JSON.stringify({ type: 'dispatch_result', payload: { error: 'platform and task required' } }));
      }
      try {
        const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform, task }),
        });
        const result = await r.json();
        ws.send(JSON.stringify({ type: 'dispatch_result', payload: result }));
        if (result.jobId) watchJob(result.jobId, platform);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'dispatch_result', payload: { error: e.message } }));
      }
      return;
    }

    if (msg.type === 'utterance') {
      const text = String(msg.text || '').trim();
      if (!text) return;
      dispatchGate.turn++; // each utterance is one human turn (dispatch gate)
      const t0 = Date.now();

      try {
        // Forced open-ended conversation
        if (msg.mode === 'converse') {
          transcript.push({ role: 'user', content: text });
          const full = await converseStream(transcript, (chunk) =>
            ws.send(JSON.stringify({ type: 'reply_chunk', text: chunk })));
          transcript.push({ role: 'assistant', content: full });
          if (transcript.length > 20) transcript.splice(0, transcript.length - 20);
          return ws.send(JSON.stringify({ type: 'reply_done', speech: full.slice(0, 400), ms: Date.now() - t0 }));
        }

        // "switch brain to GPT / Claude" — handled before any brain runs
        const switched = await maybeBrainSwitch(text);
        if (switched) {
          return ws.send(JSON.stringify({ type: 'reply', text: switched, speech: switched, via: 'brain-switch', ms: Date.now() - t0 }));
        }

        // DISPATCH GATE: run a dispatch prepared last turn only if Craig now
        // affirms — the single execution point for both brain and fallback.
        const gated = await resolveDispatchGate(dispatchGate, text,
          (m) => ws.send(JSON.stringify({ type: 'reply', text: m.text, speech: m.speech, interim: true })));
        if (gated.handled) {
          if (gated.data?.jobId) watchJob(gated.data.jobId, gated.data.platform || 'auto');
          return ws.send(JSON.stringify({ type: 'reply', text: gated.text, speech: gated.speech, via: 'dispatch-gate', ms: Date.now() - t0 }));
        }

        // Default path — talk to the agentic brain (tool-calling, GPT or
        // Claude per the brain provider) when an API key is configured;
        // otherwise fall back to the frozen keyword/Haiku intent pipeline.
        if (hasAgent()) {
          const before = transcript.length;
          try {
            const full = await runAgent(transcript, text, (chunk) =>
              ws.send(JSON.stringify({ type: 'reply_chunk', text: chunk })), dispatchGate);
            if (full.dispatched?.jobId) {
              watchJob(full.dispatched.jobId, full.dispatched.platform || 'auto');
            }
            const back = noteBrainHealthy();
            if (back) ws.send(JSON.stringify({ type: 'reply', text: back, speech: back, interim: true }));
            return ws.send(JSON.stringify({
              type: 'reply_done', speech: full.speech, via: 'agent', ms: Date.now() - t0,
            }));
          } catch (e) {
            // Both brain providers unusable — undo the partial turn and fall
            // through to the keyword intent pipeline (previously this branch
            // dead-ended in a generic error and never reached the fallback).
            transcript.splice(before);
            console.error('[gateway] agent brain failed, using intent pipeline:', e.message);
            const notice = noteBrainDegraded();
            if (notice) ws.send(JSON.stringify({ type: 'reply', text: notice, speech: notice, interim: true }));
          }
        }

        // Intent pipeline (same engine as the frozen Slack bridge)
        const { intent, via } = await resolveIntent(text);
        console.log(`[gateway] intent via ${via}: ${JSON.stringify(intent)} "${text.slice(0, 60)}"`);

        // Job-completion announcements for voice-dispatched work
        const onEvent = (m) => ws.send(JSON.stringify({ type: 'reply', text: m.text, speech: m.speech, interim: true }));
        const result = await runIntent(intent, text, onEvent, dispatchGate);
        // dispatch/passthrough now only PREVIEW (gate runs them next turn), so
        // there's no jobId here to watch — the gate's dispatch handles watchJob.
        ws.send(JSON.stringify({
          type: 'reply',
          text: result?.text ?? '(no reply)',
          speech: result?.speech ?? '',
          intent: intent.type, via, ms: Date.now() - t0,
        }));
      } catch (e) {
        console.error('[gateway] utterance error:', e.message);
        ws.send(JSON.stringify({ type: 'reply', text: `❌ ${e.message}`, speech: 'Sorry, something went wrong.' }));
      }
    }
  });

  ws.on('close', () => console.log(`[gateway] client disconnected — ${wss.clients.size} online`));
});

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-gateway] listening on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-gateway] auth token: ${AUTH_TOKEN ? 'configured ✓' : 'MISSING ✗ (all access will 403)'}`);
  console.log('[jarvis-gateway] expose with: tailscale serve --bg --https=8443 http://127.0.0.1:9208');
});

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
 *   in : {type:'utterance', text} | {type:'dispatch', platform, task} | {type:'ping'}
 *   out: {type:'reply', text, speech, intent, via, ms} | {type:'reply_chunk', text} |
 *        {type:'reply_done', speech} | {type:'notify', notification} |
 *        {type:'dispatch_result', payload} | {type:'job_update', payload} | {type:'pong'}
 *
 * There is deliberately only ONE conversational path (the agent brain via
 * hasAgent()/runAgent(), falling back to the intent pipeline) — an earlier
 * revision had a second `mode:'converse'` path that bypassed all tools and
 * standing context (removed 2026-07-20; no client ever sent it, but it was
 * a footgun any future client could trigger into a silently dumber Jarvis).
 */

import express from 'express';
import { parseCookies } from './lib/cookies.js';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveIntent, runIntent, resolveDispatchGate, platformNames, loadRoadmap } from './lib/conversation.js';
import { runAgent, hasAgent, maybeBrainSwitch, noteBrainDegraded, noteBrainHealthy } from './lib/agent.js';
import { notify } from './lib/notify.js';
import { loadTranscript, saveTranscript, recordFallbackTurn, recordTurn } from './lib/transcript.js';

const PORT         = 9208;
const ORCHESTRATOR = 'http://127.0.0.1:9205';
const MEMORY       = 'http://127.0.0.1:9200';

// ── Auth (dashboard-server.js pattern — fail closed) ────────────────────────

const AUTH_TOKEN     = process.env.JARVIS_GATEWAY_TOKEN || '';
const AUTH_COOKIE    = 'jarvis_gw_auth';
// COOKIE_MAX_AGE (30 days) was removed 2026-07-30: nothing set a cookie here any
// more. The 2026-07-17 consolidation turned this server's human UI into a 302 to
// the Deck, which took the token-bootstrap route with it and left the constant
// behind. AUTH_COOKIE itself is still read (below, and by the /ws upgrade check),
// so a cookie minted before that change still authenticates.

function tokenMatches(candidate) {
  if (!AUTH_TOKEN || !candidate) return false;
  const a = createHash('sha256').update(String(candidate)).digest();
  const b = createHash('sha256').update(AUTH_TOKEN).digest();
  return timingSafeEqual(a, b);
}

// parseCookies lives in lib/cookies.js and must never throw — see that file.
// The upgrade handler here is raw Node, so a URIError from a malformed cookie
// took the whole gateway down before the token was ever checked.

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
// 4 MB, not the 100 KB default: /worker/shot carries a screenshot PNG from the
// PC worker (2026-08-19). Tailnet-only + token-authed surface; express.json's
// own limit is what bounds it.
app.use(express.json({ limit: '4mb' }));

// GET /health — open (mirrors dashboard convention)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jarvis-gateway', clients: wss?.clients?.size ?? 0 });
});

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
// A peer box gets its OWN scoped, revocable token (JARVIS_HEARTBEAT_TOKEN_<name>)
// rather than the master gateway login — a peer never needs (or gets) the
// power to drive the brain or dispatch fleet jobs, just to say "I'm alive".
const heartbeats = new Map(); // source → { last: ms-epoch, alerted: bool }
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

function heartbeatAuthed(req) {
  const provided = String(req.headers['x-jarvis-heartbeat-token'] || '');
  if (!provided) return false;
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('JARVIS_HEARTBEAT_TOKEN_') || !v) continue;
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(v).digest();
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

app.post('/internal/heartbeat', (req, res) => {
  if (!isLocalService(req) && !isAuthed(req) && !heartbeatAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const { source, status = 'ok' } = req.body || {};
  if (!source) return res.status(400).json({ error: 'source required' });
  const prev = heartbeats.get(source);
  heartbeats.set(source, { last: Date.now(), alerted: false });
  if (prev?.alerted) {
    notify({ source: 'gateway-heartbeat', level: 'info', title: `💓 ${source} heartbeat recovered`, speech: `${source} is back.` });
  }
  res.json({ ok: true, status });
});

// ── PC worker proxy (Craig's Windows box pulls jobs over the tailnet) ───────
// The orchestrator's /worker/* endpoints stay loopback-only like everything
// else in the fleet (Rule 4 posture); this is the one tailnet-reachable door,
// gated by its OWN bearer token (never the general gateway login) so a leaked
// worker token can't also drive the conversational brain or dispatch fleet
// jobs directly.
const WORKER_TOKEN = process.env.JARVIS_WORKER_TOKEN || '';
function workerAuthed(req) {
  if (!WORKER_TOKEN) return false; // fail closed if unconfigured
  const header = String(req.headers['x-jarvis-worker-token'] || '');
  if (!header) return false;
  const a = createHash('sha256').update(header).digest();
  const b = createHash('sha256').update(WORKER_TOKEN).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}
// POST /worker/shot — the PC worker hands over a screenshot of Craig's screen
// (pc-actions.js `screen.capture`, 2026-08-19 move 38). A PNG cannot ride the
// 8 KB job output, so it comes here: worker-token authed, size-capped, magic-
// bytes checked, written under the deck's SHOT_DIR with a fixed name prefix,
// then put ON THE DECK through the same /internal/show path as show_me. Only
// the filename ever crosses to a client.
const SHOT_DIR = '/opt/jarvis/screenshots';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
app.post('/worker/shot', async (req, res) => {
  if (!workerAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const b64 = String(req.body?.png_b64 || '');
  if (!b64 || b64.length > 3_500_000) return res.status(400).json({ error: 'png_b64 missing or too large (3.5 MB cap)' });
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ error: 'bad base64' }); }
  if (buf.length < 64 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return res.status(400).json({ error: 'not a PNG' });
  const name = `pc-screen-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
  try {
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(join(SHOT_DIR, name), buf, { mode: 0o600 });
  } catch (e) {
    return res.status(500).json({ error: `could not store capture: ${e.message}` });
  }
  let shown = false;
  try {
    const r = await fetch('http://127.0.0.1:9210/internal/show', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ screenshot: name, title: "Craig's PC — screen", note: `captured ${new Date().toLocaleTimeString('en-NZ', { timeZone: 'Pacific/Auckland' })} NZT` }),
      signal: AbortSignal.timeout(5000),
    });
    shown = !!(await r.json().catch(() => ({}))).shown;
  } catch { /* deck down — the file is still there */ }
  res.json({ ok: true, name, bytes: buf.length, shown });
});

app.post('/worker/:action(claim|heartbeat|result)', async (req, res) => {
  if (!workerAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await fetch(`${ORCHESTRATOR}/worker/${req.params.action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    if (r.status === 204) return res.status(204).end();
    res.status(r.status).json(await r.json());
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
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
      // TERMINAL statuses only. This used to treat anything that wasn't
      // 'running' as finished — including 'queued', which is where a job sits
      // while the orchestrator is at its concurrency cap, while the canary or
      // usage-limit gate holds dispatch, or (for a pc-executor job) until
      // Craig's PC claims it. Craig was told "the job ended with status queued"
      // seconds after asking for it, and watching then STOPPED, so he never
      // heard about the real result. Found by the code-health spine, 2026-07-30.
      if (['completed', 'failed', 'interrupted', 'canceled'].includes(job.status)) {
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
  // Conversational memory is NOT per-connection any more (2026-07-28). It was
  // `const transcript = []` right here, which meant a page reload, a device
  // swap, or a `systemctl restart jarvis-gateway` wiped the conversation on
  // the interface Craig actually talks to. It now comes from lib/transcript.js
  // — the same durable, KV-backed conversation the deck uses.
  const dispatchGate = { turn: 0, pending: null }; // dispatch confirmation gate (per connection, deliberately)

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
          // Keep the shared conversation whole even when the gate, not the
          // brain, answered — see recordTurn (2026-07-30).
          recordTurn(text, gated.speech || gated.text).catch(() => {});
          return ws.send(JSON.stringify({ type: 'reply', text: gated.text, speech: gated.speech, via: 'dispatch-gate', ms: Date.now() - t0 }));
        }

        // Default path — talk to the agentic brain (tool-calling, GPT or
        // Claude per the brain provider) when an API key is configured;
        // otherwise fall back to the frozen keyword/Haiku intent pipeline.
        if (hasAgent()) {
          const transcript = await loadTranscript();
          try {
            const full = await runAgent(transcript, text, (chunk) =>
              ws.send(JSON.stringify({ type: 'reply_chunk', text: chunk })), dispatchGate);
            saveTranscript();
            if (full.dispatched?.jobId) {
              watchJob(full.dispatched.jobId, full.dispatched.platform || 'auto');
            }
            const back = noteBrainHealthy();
            if (back) ws.send(JSON.stringify({ type: 'reply', text: back, speech: back, interim: true }));
            return ws.send(JSON.stringify({
              type: 'reply_done', speech: full.speech, via: 'agent', ms: Date.now() - t0,
            }));
          } catch (e) {
            // Both brain providers unusable — fall through to the keyword
            // intent pipeline (previously this branch dead-ended in a generic
            // error and never reached the fallback). runAgent has already
            // rolled its own turn back by identity; the `transcript.splice(
            // before)` that used to sit here truncated by INDEX and could
            // delete a concurrent turn's messages (2026-08-04 finding).
            console.error('[gateway] agent brain failed, using intent pipeline:', e.message);
            const notice = noteBrainDegraded();
            if (notice) ws.send(JSON.stringify({ type: 'reply', text: notice, speech: notice, interim: true }));
          }
        } else {
          // Brain already known-unavailable (auth cooldown on every login) —
          // announce basic mode once rather than quietly answering dumb (2026-08-19).
          const notice = noteBrainDegraded();
          if (notice) ws.send(JSON.stringify({ type: 'reply', text: notice, speech: notice, interim: true }));
        }

        // Intent pipeline (same engine as the frozen Slack bridge)
        const { intent, via } = await resolveIntent(text);
        console.log(`[gateway] intent via ${via}: ${JSON.stringify(intent)} "${text.slice(0, 60)}"`);

        // Job-completion announcements for voice-dispatched work
        const onEvent = (m) => ws.send(JSON.stringify({ type: 'reply', text: m.text, speech: m.speech, interim: true }));
        const result = await runIntent(intent, text, onEvent, dispatchGate);
        // Keep the exchange even though the brain couldn't serve it — the
        // keyword pipeline has no memory of its own, so without this the next
        // brain turn has no record the conversation happened (deck got this
        // on 2026-07-24; the gateway had been missing it ever since).
        await recordFallbackTurn(text, result?.text ?? '(no reply)');
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

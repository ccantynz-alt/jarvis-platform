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
import { parseCookies } from './lib/cookies.js';
import { parseAllowlist, tailnetIdentity } from './lib/tailnet-identity.js';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { createHash, timingSafeEqual, randomBytes } from 'crypto';
import { readFileSync, writeFileSync, existsSync, createReadStream } from 'fs';
import { basename, join } from 'path';
import { execSync } from 'child_process';
import { resolveIntent, runIntent, resolveDispatchGate, platformNames, platformUrl, ORCHESTRATOR, MEMORY, handleBriefing } from './lib/conversation.js';
import { runAgent, hasAgent, maybeBrainSwitch, getBrainProvider, noteBrainDegraded, noteBrainHealthy } from './lib/agent.js';
import { authHold } from './lib/claude-auth.js';
import { synthesize, ttsEnabled } from './lib/tts.js';
import { openTtsStream } from './lib/tts-stream.js';
import { loadTranscript, saveTranscript, recordFallbackTurn, recordTurn, msgText } from './lib/transcript.js';
import { spawnClaude } from './lib/spawn-agent.js';
import { modelFor } from './lib/model-routing.js';
import { situationFingerprint, situationPrompt, parseSituation, needsAttention } from './lib/situation.js';
import { installInternalAuth } from './lib/internal-http.js';
installInternalAuth();   // gate loopback :9200/:9205 writes with the internal token (move 11)

const PORT      = 9210;
const SCHEDULER = 'http://127.0.0.1:9209';
// How long a v2 turn waits for ElevenLabs to produce its first audio before
// declaring itself unvoiced and telling the client to speak the text instead.
// Must stay LONGER than lib/tts-stream.js's own handshake/first-audio deadlines
// (4s each) so a failure resolves this wait early, rather than the wait timing
// out first and the stream's `fallback` arriving after the final chat message.
const VOICE_GRACE_MS = 6000;

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

// parseCookies lives in lib/cookies.js and must never throw: the WebSocket
// upgrade handler below is raw Node, so an exception there is an
// uncaughtException that kills this process — before any token is compared.
// `Cookie: a=%` was enough. See that file for the full account.

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

// Tailnet identity (2026-08-19): an allowlisted Tailscale login arriving
// through `tailscale serve` is authenticated — see lib/tailnet-identity.js for
// why this adds no trust beyond what isLocalDirect() already grants. This is
// what lets Craig's PHONE in without typing a token from a file on the box
// (the deck had logged "403 for 100.111.46.68 (ccantynz@gmail.com)" ten times).
// `DECK_TAILNET_USERS` (secrets.env), comma-separated; unset = off.
const TAILNET_USERS = parseAllowlist(process.env.DECK_TAILNET_USERS);

function identityLogin(req) {
  return tailnetIdentity(req.headers, TAILNET_USERS);
}

function isAuthed(req) {
  return tokenMatches(requestToken(req)) || !!identityLogin(req);
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
// -c safe.directory for the same reason as dashboard-server's lastCommit(): this
// service has no HOME, so git cannot read root's config. /opt/jarvis is root-owned
// so it works today — this keeps it working if that ever changes, since the catch
// would otherwise leave BUILD as 'unknown' with no explanation.
try {
  BUILD = execSync('git -c safe.directory=/opt/jarvis rev-parse --short HEAD',
    { cwd: '/opt/jarvis', encoding: 'utf8' }).trim();
} catch (e) { console.warn(`[deck] could not read build sha: ${e.message}`); }

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'jarvis-deck', build: BUILD, clients: wss?.clients?.size ?? 0, link: 'ready', tts: ttsEnabled() });
});

// ── SHOW ME (2026-08-11) ────────────────────────────────────────────────────
// Craig, twice in different words: "pull up websites for me to view" and "it
// automatically pops up on my screen". Until now Marco could read the web and
// DESCRIBE it — search, fetch, render — but had no way to put anything in front
// of him. He narrated; he never showed.
//
// Deliberately ONE primitive rather than a feature per thing worth showing: a
// capture (already produced by browser-service's guarded Playwright render) is
// served here and pushed to every connected deck. That makes it work on the
// iPad and phone too, needs no browser on the box, and needs nothing running on
// Craig's PC — the three ways a "show me" built the obvious way would fail him.
//
// Screenshot rather than an iframe on purpose: X-Frame-Options/CSP block most
// real sites from being framed, and a blank panel is a worse answer than a
// picture. The panel carries the live URL so he can open it properly when he
// wants to interact.
const SHOT_DIR = '/opt/jarvis/screenshots';

// GET /shot/:name — serve one capture. Same auth as the rest of the deck.
app.get('/shot/:name', (req, res) => {
  if (!isLocalDirect(req) && !isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  // basename() first, then an allowlist pattern, then a prefix assertion: this
  // serves files from a directory by NAME, which is the classic traversal
  // shape, so it is closed three independent ways rather than cleverly once.
  const name = basename(String(req.params.name || ''));
  if (!/^[\w.-]+\.png$/i.test(name)) return res.status(400).json({ error: 'png captures only' });
  const file = join(SHOT_DIR, name);
  if (!file.startsWith(SHOT_DIR + '/')) return res.status(400).json({ error: 'bad path' });
  if (!existsSync(file)) return res.status(404).json({ error: 'no such capture' });
  res.type('png');
  res.set('Cache-Control', 'private, max-age=600');
  createReadStream(file).pipe(res);
});

// POST /internal/show { url?, screenshot?, title?, note? } — put it on screen.
app.post('/internal/show', (req, res) => {
  if (!isLocalDirect(req) && !isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  const { url = null, screenshot = null, title = null, note = null } = req.body || {};
  if (!url && !screenshot) return res.status(400).json({ error: 'url or screenshot required' });
  // Only the FILENAME crosses to the client — never the box path. The browser
  // fetches it back through /shot/:name, so the deck never learns the layout of
  // the filesystem and a caller cannot point the panel at an arbitrary file.
  const shot = screenshot ? basename(String(screenshot)) : null;
  if (shot && !/^[\w.-]+\.png$/i.test(shot)) return res.status(400).json({ error: 'bad capture name' });
  broadcast({ type: 'show', url, shot, title, note, ts: new Date().toISOString() });
  const clients = wss?.clients?.size ?? 0;
  // Honest about reach: nothing is "shown" if no deck is open, and Marco must
  // be able to say so rather than claiming it landed.
  res.json({ ok: true, clients, shown: clients > 0 });
});

// POST /internal/notify — instant push, mirrors gateway-server.js's own
// /internal/notify (2026-07-21: the Deck previously only found out about
// notifications via pollActivity()'s 5s poll of memory — the Gateway got
// an instant push, the Deck (what Craig actually watches) did not, for no
// reason other than the two servers being built separately). Loopback-only,
// same trust model as gateway's version — called by lib/notify.js.
app.post('/internal/notify', (req, res) => {
  if (!isLocalDirect(req) && !isAuthed(req)) return res.status(403).json({ error: 'forbidden' });
  // `source` and `body` are accepted by the notify() contract but not rendered
  // here: the HUD banner is title + level, and the full body is already durable
  // in the memory inbox (lib/notify.js writes there first). Destructuring them
  // and dropping them read as a bug, so they are simply not taken.
  const { id, level = 'info', title, speech } = req.body || {};
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

// PWA identity — manifest, icons and the service worker are PUBLIC on this
// tailnet-only origin (2026-08-19, audit move 28). They were behind the page's
// auth, and browsers fetch a manifest WITHOUT cookies unless the link carries
// crossorigin="use-credentials" (it did not) — so the manifest 403'd, Chrome
// never offered a real install and iOS fell back to the apple-* meta tags with
// whatever URL it was on. Nothing here leaks: a name, an icon, and a worker
// whose only content is an "open Tailscale" page.
app.get('/deck.webmanifest', (req, res) => {
  res.set('Content-Type', 'application/manifest+json');
  res.set('Cache-Control', 'public, max-age=3600');
  res.sendFile('/opt/jarvis/public/deck.webmanifest');
});
app.get('/icons/:file', (req, res) => {
  if (!/^deck-\d+\.png$/.test(req.params.file)) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile('/opt/jarvis/public/icons/' + req.params.file);
});
app.get('/sw.js', (req, res) => {
  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-cache');            // the browser re-checks it on every load
  res.set('Service-Worker-Allowed', '/');
  res.sendFile('/opt/jarvis/public/sw.js');
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

// ── OPS tab data (2026-08-05, Craig: "we need it all available on command deck")
//
// Everything Jarvis knows was already durable in memory (:9200) but only
// reachable by asking the brain or curling loopback — the inbox sat at 754
// unread because no surface Craig actually watches showed it. These three
// routes put the work itself on the deck: the inbox (with the only mutating
// action, mark-read), code-health findings, agent-org reports, and the job
// queue. Same auth model as /tts: cookie/token, or loopback for the
// screenshot service.
//
// GET /api/ops exists alongside the WS `ops` broadcast for two reasons: the
// client fetches it at boot so the tab is populated before the first tick,
// and :9201 virtual-time captures never see WS pushes at all (the same
// reason the ?demo-* QA hooks exist) — without this, every screenshot of
// the tab would be empty and Rule 2 unverifiable.
app.get('/api/ops', (req, res) => {
  if (!isAuthed(req) && !isLocalDirect(req)) return res.status(403).json({ error: 'forbidden' });
  // situation rides along: a :9201 virtual-time capture never sees a WS push,
  // so without this every screenshot of the tab would show an empty SITUATION
  // panel and Rule 2 could not be satisfied for it.
  res.json({ ...(state.ops || {}), situation: state.situation || null });
});

// POST /api/ops/review {id, decision, notes} — Craig decides a proposal.
//
// This is the ONE place a human verdict enters the governance layer from the
// deck (docs/GOVERNANCE.md). actor_kind is hardcoded 'human' and actor_id
// 'craig': reaching this route already required the deck token, so the caller
// IS Craig, and letting the body name the actor would make the audit trail
// forgeable by anything that could reach loopback.
//
// The decision is NOT applied here — it is forwarded to memory-server, whose
// canTransition() is the single authority. If Craig taps approve on something
// an agent staged illegally, the gate still refuses and says why.
app.post('/api/ops/review', async (req, res) => {
  if (!isAuthed(req) && !isLocalDirect(req)) return res.status(403).json({ error: 'forbidden' });
  const { id, decision, notes } = req.body || {};
  const TO = { approve: 'approved', reject: 'rejected', escalate: 'escalated' };
  if (!Number.isInteger(id) || !TO[decision]) {
    return res.status(400).json({ error: 'id (integer) and decision (approve|reject|escalate) required' });
  }
  const transition = (to, note) => fetch(`${MEMORY}/memory/proposals/${id}/transition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, actor_id: 'craig', actor_kind: 'human', notes: note }),
    signal: AbortSignal.timeout(8000),
  });

  try {
    // Pick it up before deciding it. TRANSITIONS.proposed is
    // ['under_review','withdrawn'] — there is no edge from 'proposed' straight
    // to a verdict, so every tap of APPROVE/REJECT on the deck came back 409
    // REFUSED. That was EVERY proposal in the queue: REVIEW_RUNNER_MODE=dry-run
    // never transitions anything, so all 8 open proposals sat at 'proposed'
    // and the buttons had never once worked (found 2026-08-07, fixed
    // 2026-08-16).
    //
    // Two explicit transitions rather than a new proposed→approved edge, so the
    // state machine keeps its meaning and the audit trail records what actually
    // happened: Craig picked it up, then Craig decided it. canTransition stays
    // the single authority — if the verdict is illegal it still refuses here.
    const current = await fetch(`${MEMORY}/memory/proposals/${id}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : null).catch(() => null);
    const status = current?.status ?? null;   // GET returns {...row, audit, decision}

    if (status === 'proposed') {
      const pickup = await transition('under_review', 'picked up for review from the deck');
      if (!pickup.ok) {
        pollOps().catch(() => {});
        return res.status(pickup.status).json(await pickup.json().catch(() => ({ error: 'pickup refused' })));
      }
    }

    const r = await transition(TO[decision], notes || null);
    const body = await r.json();
    pollOps().catch(() => {});   // push the new queue to every client now
    res.status(r.status).json(body);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// POST /api/ops/inbox-read {id} or {all:true} — the deliberate v1 scope of
// deck WRITE access: marking a notification read is harmless and idempotent.
// Findings/jobs/reports stay read-only here — dismissing a finding is sticky
// (code-health doctrine) and killing a job is a real action; both belong in
// the confirmation-gated brain path, not one tap on a touchscreen.
app.post('/api/ops/inbox-read', async (req, res) => {
  if (!isAuthed(req) && !isLocalDirect(req)) return res.status(403).json({ error: 'forbidden' });
  const { id, all } = req.body || {};
  if (!all && typeof id !== 'number') return res.status(400).json({ error: 'id (number) or all:true required' });
  const path = all ? 'read-all' : `${id}/read`;
  try {
    const r = await fetch(`${MEMORY}/memory/notifications/${path}`, { method: 'POST' });
    const out = await r.json();
    pollOps().catch(() => {}); // push the new unread count to every client now, not at the next tick
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

const authCookieHeader = (token) =>
  `${AUTH_COOKIE}=${encodeURIComponent(token)}; Max-Age=${COOKIE_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax; Secure`;

app.get('/', (req, res) => {
  if (req.query.token !== undefined) {
    if (!tokenMatches(req.query.token)) return res.status(403).send('Forbidden');
    res.setHeader('Set-Cookie', authCookieHeader(req.query.token));
    // Preserve the rest of the query — a ?token=…&view=ops login used to land
    // on CORE because this redirect dropped everything (2026-08-05, found the
    // first time Craig was sent a deep-linked login URL).
    const rest = new URLSearchParams(req.query);
    rest.delete('token');
    const qs = rest.toString();
    return res.redirect('/' + (qs ? '?' + qs : ''));
  }
  if (!isAuthed(req) && !isLocalDirect(req)) {
    console.log(`[deck] 403 for ${req.headers['x-forwarded-for'] || req.socket.remoteAddress} (${req.headers['tailscale-user-login'] || 'unknown user'})`);
    const hint = TAILNET_USERS.length
      ? `<br>Or connect this device to the tailnet as <b style="color:#00e5ff">${TAILNET_USERS[0]}</b> — Tailscale identity unlocks the Deck on its own.`
      : '';
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
(the deck token lives in <b style="color:#00e5ff">config/deck.token</b> on the box — Gateway logins no longer unlock the Deck).${hint}</p></div></body></html>`);
  }
  res.set('Cache-Control', 'no-cache, must-revalidate');
  // Sliding session (2026-08-05): the cookie was stamped ONCE at ?token= login
  // with a hard 30-day Max-Age, so a device that visited the deck every single
  // day still got silently locked out a month after login — "Forbidden" with no
  // explanation, indistinguishable from a broken deck. Re-stamp on every authed
  // page load: a device only expires after 30 days of not visiting at all.
  const tok = requestToken(req);
  if (tok && tokenMatches(tok)) res.setHeader('Set-Cookie', authCookieHeader(tok));
  else {
    // Identity-authed load with no valid cookie: stamp one, so the WebSocket
    // upgrade and an installed home-screen PWA (its own cookie jar on iOS)
    // keep working. Logged so the first phone login is visible in the journal.
    const who = identityLogin(req);
    if (who && AUTH_TOKEN) {
      res.setHeader('Set-Cookie', authCookieHeader(AUTH_TOKEN));
      console.log(`[deck] tailnet identity login: ${who} from ${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`);
    }
  }
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
  situation: null,      // Jarvis's ranked synthesis of the OPS picture
};

// Persist rolling history so uptime %s and sparklines survive restarts.
const STATE_FILE = '/opt/jarvis/memory/deck-state.json';
try {
  const saved = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  state.upSamples = new Map(saved.upSamples || []);
  state.latHist = new Map(saved.latHist || []);
  state.lastNotifId = saved.lastNotifId || 0;
  state.lastEventTs = saved.lastEventTs || '';
  state.situation = saved.situation || null;
} catch { /* first boot */ }
function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({
      upSamples: [...state.upSamples], latHist: [...state.latHist],
      lastNotifId: state.lastNotifId, lastEventTs: state.lastEventTs,
      // Persisted so a deploy restart does not re-spend a subscription turn
      // re-deriving a synthesis whose facts have not moved.
      situation: state.situation,
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
// Registry site_url is the source (move 21); jarvis is the local dashboard,
// which has no public site_url, so it stays here.
const LOCAL_URLS = { jarvis: 'http://127.0.0.1:9206/health' };
const platURL = (name) => platformUrl(name) || LOCAL_URLS[name] || null;

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
    const url = platURL(p.name);
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
      monitored: p.monitor !== false,   // non-products (monitor:false) never sit in NEEDS ATTENTION (2026-08-20)
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

// OPS every 15s — the inbox, code-health findings, agent-org reports and the
// job queue, compacted to what the tab renders. Each block falls back to its
// previous value on a failed fetch rather than blanking a panel: memory being
// briefly unreachable should read as "stale", never as "there are no findings".
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
async function pollOps() {
  const [inbox, findings, summary, reports, jobs, proposals] = await Promise.all([
    jget(`${MEMORY}/memory/notifications?limit=40`),
    jget(`${MEMORY}/memory/findings?open_only=1&limit=60`),
    jget(`${MEMORY}/memory/findings/summary`),
    jget(`${MEMORY}/memory/agent-reports?limit=30`),
    jget(`${MEMORY}/memory/jobs?limit=30`),
    jget(`${MEMORY}/memory/proposals?open_only=1&limit=40`),
  ]);
  const prev = state.ops || {};
  state.ops = {
    inbox: inbox?.notifications ? {
      unread: inbox.unread,
      items: inbox.notifications.map(n => ({
        id: n.id, ts: n.ts, level: n.level, source: n.source,
        title: trunc(n.title, 140), read: !!n.read_at,
      })),
    } : prev.inbox ?? null,
    findings: Array.isArray(findings) ? findings.map(f => ({
      id: f.id, platform: f.platform, severity: f.severity, kind: f.kind,
      title: trunc(f.title, 160),
      file: f.file_path ? `${f.file_path}${f.line ? ':' + f.line : ''}` : null,
      status: f.status, seen: f.seen_count, last_seen: f.last_seen,
    })) : prev.findings ?? null,
    findingCounts: summary?.openBySeverity ?? prev.findingCounts ?? null,
    reports: Array.isArray(reports) ? reports.map(r => ({
      id: r.id, agent: r.agent, ts: r.ts, status: r.status, summary: trunc(r.summary, 180),
    })) : prev.reports ?? null,
    // Escalations first — those are the ones waiting on Craig specifically.
    proposals: Array.isArray(proposals) ? proposals
      .sort((a, b) => (a.status === 'escalated' ? 0 : 1) - (b.status === 'escalated' ? 0 : 1) || b.id - a.id)
      .map(p => ({
        id: p.id, domain: p.domain, platform: p.platform, status: p.status,
        change_class: p.change_class, risk: p.risk,
        title: trunc(p.title, 150), rationale: trunc(p.rationale, 240),
        artifact_url: p.artifact_url, created_by: p.created_by,
        reviewed_by: p.reviewed_by, review_notes: trunc(p.review_notes, 200),
        created_at: p.created_at,
      })) : prev.proposals ?? null,
    jobs: Array.isArray(jobs) ? jobs.map(j => ({
      id: String(j.id).slice(0, 8), platform: j.platform, task: trunc(j.task, 100),
      status: j.status, runtime: j.runtime, created_at: j.created_at,
      finished_at: j.finished_at, exit_code: j.exit_code,
    })) : prev.jobs ?? null,
  };
  broadcast({ type: 'ops', ...state.ops });
  refreshSituation().catch(e => console.error('[deck] situation:', e.message));
}

// ── SITUATION — Jarvis's judgement, not his tables (2026-08-05) ──────────────
//
// Craig: "how can we make jarvis command deck seriously more intelligent". The
// OPS panels show everything at equal weight; this asks the brain what it MEANS
// and ranks it.
//
// Generated ONLY when the underlying facts materially change
// (lib/situation.js's fingerprint). Every synthesis is a subscription turn from
// the same window the voice brain and every repair agent draw from, and there
// is no metered fallback — an unconditional timer would burn ~48 turns a day
// restating an unchanged picture.
//
// spawnClaude, deliberately NOT runAgent: runAgent writes to the shared
// conversation transcript, and a background synthesis every time a finding
// lands would pollute the thing Craig is actually talking to.
// Failure back-off (2026-08-19): a failed synthesis left `state.situation`
// untouched, so the SAME fingerprint was retried on every 15-second ops tick —
// a `claude` spawn every 15 s, each dying in ~2 s, 34,821 journal lines in
// three days while both logins were dead (and each attempt re-touching the
// shared credentials file). Remember the last failed fingerprint and sit out
// SITUATION_RETRY_MS before trying that exact picture again; a CHANGED picture
// still retries at once. `authHeld` is honoured like `limitHeld` — the
// claude-auth layer has already alerted, the deck must not add to it.
const SITUATION_RETRY_MS = 10 * 60 * 1000;
const SITUATION_MIN_GAP_MS = 10 * 60 * 1000;   // ≤ 144 syntheses/day however busy the fleet gets
let situationBusy = false;
let situationLastFail = { fp: null, at: 0 };
async function refreshSituation() {
  if (situationBusy) return;
  const facts = {
    findings: state.ops?.findings || [],
    proposals: state.ops?.proposals || [],
    platforms: state.platforms || [],
    jobs: state.ops?.jobs || [],
  };
  const fp = situationFingerprint(facts);
  if (fp === state.situation?.fingerprint) return;   // nothing worth re-thinking
  if (fp === situationLastFail.fp && Date.now() - situationLastFail.at < SITUATION_RETRY_MS) return;
  // Floor between syntheses regardless of how the picture moves (2026-08-19):
  // the fingerprint includes every failed job id, so a run of failures (42 in
  // three days during the auth outage) was 42 changed pictures and 42 turns. A
  // changed picture still gets re-thought — at most once per SITUATION_MIN_GAP_MS,
  // picked up by the next 15-second ops tick once the gap has passed.
  if (state.situation?.at && Date.now() - Date.parse(state.situation.at) < SITUATION_MIN_GAP_MS) return;
  // Nothing at all to synthesise yet (first boot, memory unreachable).
  if (!facts.findings.length && !facts.proposals.length) return;

  situationBusy = true;
  const t0 = Date.now();
  try {
    const out = await spawnClaude({
      prompt: situationPrompt(facts),
      cwd: '/opt/jarvis',
      timeoutMin: 4,
      model: modelFor('situation'),   // a ranking, not deep reasoning: cheap tier (move 17)
    });
    if (out.limitHeld || out.authHeld || out.code !== 0) {
      situationLastFail = { fp, at: Date.now() };
      if (out.limitHeld) console.warn('[deck] situation held — accounts usage-limited; retry in 10 min');
      else if (out.authHeld) console.warn('[deck] situation held — no Claude login can authenticate; retry in 10 min');
      else console.warn(`[deck] situation agent exited ${out.code}; retry in 10 min`);
      return;
    }
    const parsed = parseSituation(out.stdout);
    state.situation = {
      fingerprint: fp,
      ok: parsed.ok,
      sections: parsed.sections,
      raw: parsed.ok ? null : parsed.raw,     // shown verbatim rather than dropped
      error: parsed.error || null,
      attention: needsAttention(parsed),
      at: new Date().toISOString(),
      ms: Date.now() - t0,
    };
    saveState();
    broadcast({ type: 'situation', ...state.situation });
    console.log(`[deck] situation refreshed in ${state.situation.ms}ms — ${state.situation.attention} item(s) need Craig`);
  } finally {
    situationBusy = false;
  }
}

// ── WebSocket ────────────────────────────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const cookies = parseCookies(req.headers.cookie);
  const authed = tokenMatches(cookies[AUTH_COOKIE]) || !!identityLogin(req);
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

// The one rolling conversation — now lib/transcript.js, shared with the
// gateway so context follows Craig between surfaces instead of each server
// keeping its own. runAgent() mutates and bounds the array itself.

wss.on('connection', (ws, req) => {
  // Dispatch confirmation gate: `turn` counts human commands; a preview stamps
  // the turn it was shown in, and a dispatch only fires when confirmed in a
  // LATER turn (see agent.js dispatch_job).
  //
  // PER CONNECTION, deliberately — matching gateway-server.js:302. This sat at
  // MODULE scope until 2026-08-16, one object shared by every deck socket,
  // while the comment three lines above it declared the opposite invariant:
  // "a preview shown on one surface must not be confirmable from another".
  //
  // The live sequence: Craig, on the iPad deck, asks for a repair or a PC
  // change; previewPcAction/previewDispatch writes gate.pending stamped with
  // turn N. A SECOND connected client — a desktop tab he left open, his phone's
  // PWA — sends any compact affirmation ("ok"). That client's message bumps the
  // SAME shared gate.turn to N+1, so classifyGateReply sees a confirmation in a
  // later turn and the staged action fires. A full-permission agent launched
  // from a device that was never shown the preview. This is the ONE path from
  // "Craig said go" to a production agent, so it gets the strictest reading.
  const dispatchGate = { turn: 0, pending: null };

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
  if (state.ops) send({ type: 'ops', ...state.ops });
  if (state.situation) send({ type: 'situation', ...state.situation });
  send({ type: 'stats', ...state.stats });
  send({ type: 'brain', ...brainState() });   // honest from the first frame (move 33)
  for (const f of [...state.feedCache].reverse()) send({ type: 'feed', ...f });
  for (const w of [...state.wireCache].reverse()) send({ type: 'wire', ...w });

  // Rehydrate the conversation on connect (mobile command-centre, move 31): the
  // phone/iPad boots into a REAL scrollable transcript, not the single ephemeral
  // line it showed before. Non-blocking; a cold transcript store is an empty
  // history, never a failure. Only string-content user/assistant turns cross.
  loadTranscript().then((transcript) => {
    if (!Array.isArray(transcript) || !transcript.length) return;
    const turns = transcript
      .filter((mm) => (mm.role === 'user' || mm.role === 'assistant') && msgText(mm).trim())
      .slice(-40)
      .map((mm) => ({ who: mm.role === 'user' ? 'YOU' : 'MARCO', text: msgText(mm).slice(0, 4000), ts: mm.ts || null }));
    if (turns.length) send({ type: 'history', turns });
  }).catch(() => {});

  // Voice v2 (docs/VOICE-V2.md): per-connection streaming-speech session.
  // voiceSession.discard flips on interrupt — the brain may keep generating,
  // but nothing more is voiced or streamed for that turn.
  let voiceSession = null;
  function killVoiceSession() {
    if (voiceSession) { voiceSession.discard = true; voiceSession.tts?.abort(); voiceSession = null; }
  }
  ws.on('close', () => killVoiceSession());

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ping') return ws.readyState === 1 && ws.send('{"type":"pong"}');
    if (msg.type === 'interrupt') { // v2: kill this turn's voice AT THE SOURCE
      killVoiceSession();
      return send({ type: 'audio_ctl', ev: 'end' });
    }
    if (msg.type !== 'command') return;
    const text = String(msg.text || '').trim();
    if (!text) return;
    killVoiceSession(); // a new ask always supersedes whatever he was saying
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
      if (gated.handled) {
        // The gate answered instead of the brain — put it in the shared
        // conversation anyway, or the brain's next turn thinks the job is still
        // waiting on a yes it never saw arrive (2026-07-30).
        recordTurn(text, gated.speech || gated.text).catch(() => {});
        return send({ type: 'chat', text: gated.text, speech: gated.speech });
      }
      if (hasAgent()) {
        const transcript = await loadTranscript();
        // Voice v2 (docs/VOICE-V2.md): stream speech server-side while the
        // brain streams text. Sentences feed ONE ElevenLabs stream; mp3
        // chunks go to the client as binary frames on this same socket.
        //
        // The stream opens LAZILY, on the first finished sentence (2026-07-30).
        // It used to open before the brain had said anything, and ElevenLabs'
        // stream-input socket terminates after 20 SECONDS with no text — while
        // brain-claude's own warm first-token watchdog is itself 20s, and a turn
        // with a tool call is routinely slower. So a perfectly healthy reply
        // killed its own voice stream before speaking a word: Craig's 22:34 UTC
        // deck session showed exactly that ("Have not received a new text input
        // within the timeout of 20 seconds"). Opening when there is something to
        // say costs one WS handshake and removes the whole race.
        let session = null;
        if (msg.v2) {
          session = { discard: false, tts: null, opening: null, buf: '', queue: [], spokenAny: false, failed: false, audioAny: false };
          // Resolved by the first real audio chunk OR by a stream failure — the
          // two outcomes that let this turn stop wondering whether it has a voice.
          session.settle = new Promise((r) => { session.markSettled = r; });
          voiceSession = session; // claim the turn NOW so an interrupt during the open still lands
        }
        const openStream = () => {
          if (!session || session.discard || session.failed) return Promise.resolve(null);
          if (session.tts) return Promise.resolve(session.tts);
          if (session.opening) return session.opening;
          session.opening = openTtsStream({
            onAudio: (chunk) => {
              session.audioAny = true;
              session.markSettled();
              if (!session.discard && ws.readyState === 1) ws.send(chunk);
            },
            onDone: () => { session.markSettled(); if (!session.discard) send({ type: 'audio_ctl', ev: 'end' }); },
            onError: (e) => {
              console.error('[deck] v2 tts stream failed:', e.message);
              if (!session.discard) send({ type: 'audio_ctl', ev: 'fallback' }); // client re-voices via v1
              session.tts = null;
              session.failed = true;
              session.markSettled();
            },
          }).catch(() => null).then((tts) => {
            if (!tts) { session.failed = true; return null; }   // TTS off or over budget
            if (session.discard) { tts.abort(); return null; }  // interrupted mid-handshake
            session.tts = tts;
            send({ type: 'audio_ctl', ev: 'start' });
            return tts;
          });
          return session.opening;
        };
        const drainSpeech = () => {
          while (session?.queue.length && session.tts && !session.discard) {
            session.tts.sendText(session.queue.shift());
            session.spokenAny = true;
          }
        };
        const flushSpeech = () => {
          if (!session?.queue.length || session.discard || session.failed) return;
          if (session.tts) return drainSpeech();
          openStream().then(() => drainSpeech());
        };
        const SENT_END = /[.!?]["')\]]?(?:\s|$)/;
        const feedSpeech = (chunk) => {
          if (!session || session.discard || session.failed) return;
          session.buf += chunk;
          let m;
          while ((m = session.buf.match(SENT_END))) {
            const cut = m.index + m[0].length;
            session.queue.push(session.buf.slice(0, cut));
            session.buf = session.buf.slice(cut);
          }
          flushSpeech();
        };
        try {
          // runAgent pushes user+assistant turns onto transcript itself.
          const full = await runAgent(transcript, text,
            (chunk) => { send({ type: 'chat_chunk', text: chunk }); feedSpeech(chunk); }, dispatchGate);
          saveTranscript();
          if (session && !session.discard) {
            if (session.buf.trim()) session.queue.push(session.buf);            // the tail fragment
            else if (!session.spokenAny && !session.queue.length && full.text) session.queue.push(full.text.slice(0, 1200));
            if (session.queue.length) { await openStream(); drainSpeech(); }
            session.tts?.end();
            // Handing text to ElevenLabs is not the same as being heard
            // (2026-07-30). spokenAny only means the sentences went into the
            // stream; if ElevenLabs accepted the socket and then rendered
            // nothing, this turn is silent and every check below used to pass.
            // Wait for real audio — normally already true, since the first chunk
            // arrives ~300-500ms after the first sentence while the reply is
            // still streaming — and settle early on failure. The stream's own
            // deadlines are shorter than this grace, so onError has fired and
            // sent `fallback` before the final chat message goes out; after it,
            // the client's flag is set too late to voice anything.
            if (session.spokenAny && !session.audioAny) {
              await Promise.race([session.settle, new Promise((r) => setTimeout(r, VOICE_GRACE_MS))]);
            }
            // Nothing was voiced server-side (TTS disabled, over budget, the
            // stream never opened, or it opened and stayed mute). A v2 client
            // does NOT speak the streamed text itself, so without this it just
            // sits there in silence — the failure mode where Jarvis loses his
            // voice the moment the daily ElevenLabs budget runs out, and never
            // says why.
            if (!session.audioAny) {
              console.warn('[deck] v2 turn produced no audio — telling the client to speak it');
              send({ type: 'audio_ctl', ev: 'fallback' });
            }
          }
          const back = noteBrainHealthy();
          if (back) send({ type: 'notify', level: 'info', title: back, speech: back });
          // Suppress client re-speak ONLY when the server actually spoke — which
          // means audio came back, not that text was handed over. v1 clients
          // never set msg.v2, so they always get their speech text.
          return send({ type: 'chat', text: full.text || 'Done, sir.', speech: session?.audioAny ? null : full.speech });
        } catch (e) {
          if (session) { session.tts?.abort(); session.discard = true; if (voiceSession === session) voiceSession = null; }
          // Both brain providers unusable (no credits, outage) — fall through
          // to the intent pipeline. runAgent has already rolled its own turn
          // back BY IDENTITY (lib/transcript.js). This used to be
          // `transcript.splice(before)` with `before` captured before runAgent
          // ran, which truncated by index and so deleted whatever a CONCURRENT
          // turn had appended in the meantime — the 2026-08-04 finding.
          console.error('[deck] agent brain failed, using intent pipeline:', e.message);
          const notice = noteBrainDegraded();
          if (notice) send({ type: 'notify', level: 'warn', title: notice, speech: notice });
        }
      } else {
        // hasAgent() is already false (every login inside its auth cooldown —
        // lib/brain-claude.js hasClaudeBrain, 2026-08-19). Say so ONCE, the
        // same way the failure path does; silently answering in keyword mode
        // is how "basic mode" passed for a stupid brain for three days.
        const notice = noteBrainDegraded();
        if (notice) send({ type: 'notify', level: 'warn', title: notice, speech: notice });
      }
      const { intent } = await resolveIntent(text);
      const result = await runIntent(intent, text, (m) => send({ type: 'chat', text: m.speech || m.text }), dispatchGate);
      const fallbackReply = result?.speech || result?.text || 'Acknowledged, sir.';
      // 2026-07-24 (Craig: "within 30 seconds it completely forgot what we
      // were organising"): when the brain failed, the splice above erased
      // the ENTIRE exchange — his message and the fallback answer were never
      // written to the durable transcript, so the very next brain turn had
      // no record the conversation happened. Now in lib/transcript.js so the
      // gateway gets the same continuity instead of only the deck.
      await recordFallbackTurn(text, result?.text || fallbackReply);
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
tick(pollOps, 15000);

// ── Brain state → every client (2026-08-19, audit move 33) ──────────────────
// For the 2026-08-16..19 outage the deck's link badge said LIVE LINK while the
// brain was dead; a phone that connected mid-outage got only oddly dumb answers
// (the one-shot noteBrainDegraded notice reaches whoever is on THAT socket at
// THAT moment). Now the state is pushed on every connect and broadcast on every
// change, so the badge can say BASIC MODE — honestly, from the first frame.
function brainState() {
  const ok = hasAgent();
  const hold = ok ? null : authHold();
  return {
    ok,
    provider: getBrainProvider(),
    reason: ok ? null : (hold?.held ? 'auth' : 'unavailable'),
    until: hold?.held ? hold.at : null,
  };
}
let lastBrainKey = null;
function pollBrain() {
  const b = brainState();
  const key = `${b.ok}|${b.provider}|${b.reason}|${b.until}`;
  if (key === lastBrainKey) return Promise.resolve();
  lastBrainKey = key;
  broadcast({ type: 'brain', ...b });
  console.log(`[deck] brain state → ${b.ok ? `${b.provider} ok` : `DOWN (${b.reason}${b.until ? `, re-probe ${b.until}` : ''})`}`);
  return Promise.resolve();
}
tick(pollBrain, 5000);
tick(pollPlatforms, 30000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-deck] listening on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-deck] auth token: ${AUTH_TOKEN ? 'configured ✓' : 'MISSING ✗ (all access will 403)'}`);
  console.log(`[jarvis-deck] agent brain: ${hasAgent() ? getBrainProvider() + ' ✓' : 'intent-pipeline fallback'}`);
  console.log('[jarvis-deck] expose with: tailscale serve --bg --https=8444 http://127.0.0.1:9210');
});

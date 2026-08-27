/**
 * push.js — the alert that reaches Craig when nothing of his is open.
 *
 * Every existing notification path needs something to be listening: the memory
 * inbox is a pull, the gateway and deck pushes only land in a CONNECTED tab, and
 * TTS only speaks to a page that exists. Close the laptop and walk out of the
 * house — which is the exact moment an alert matters — and Jarvis was shouting
 * into an empty room. Craig, 2026-07-30: "we need a reliable set across all my
 * devices for alerts and communication between myself and jarvis".
 *
 * Transport is ntfy (https://ntfy.sh, or a self-hosted server via NTFY_SERVER)
 * for one reason: it needs NO account and NO app-store credential. The topic
 * name IS the credential, so it lives in config/secrets.env and never in git.
 * Craig installs the ntfy app on each device once, subscribes to the topic, and
 * every device is covered — iOS, Android, desktop, or just a browser tab.
 *
 * Doctrine notes:
 *  - Rule 5 (no competitor dependencies) is satisfied: this is a plain HTTP POST,
 *    no SDK, no client library.
 *  - Failure is logged and swallowed. Notification plumbing must never take down
 *    a caller — same contract as notify.js.
 *  - Silence is a valid state: with no NTFY_TOPIC set this module is a no-op and
 *    says so once, rather than pretending to deliver.
 */

import { guardrail } from './guardrail.js';
import { createHash } from 'crypto';
import { routeAlert, buildDigest, shouldFlush } from './alert-smart.js';
import { deliverWebPush, listDevices, _setKv as _setSubsKv } from './push-subs.js';

const DEFAULT_SERVER = 'https://ntfy.sh';

// TWO transports, ONE set of gates (2026-08-27).
//
// Web Push to the deck PWA was added beside ntfy rather than instead of it, and
// the temptation was to give it its own send path — it has its own encryption,
// its own subscription store, its own failure modes. That would have been the
// second bespoke notification pipeline on this box, and every rule above about
// dedupe, rate caps and levels would have applied to exactly half the alerts.
//
// So the gates run once, here, and BOTH transports are handed the result. A
// change to what counts as a repeat changes it everywhere, by construction.

// info is deliberately NOT pushed by default. A phone that buzzes for routine
// chatter gets muted, and a muted channel is worse than no channel — that is the
// whole lesson of the Slack firehose (see notify-center.js).
const LEVEL_ORDER = { info: 1, warn: 2, alert: 3 };

// ntfy priorities: 1 min · 2 low · 3 default · 4 high · 5 max (bypasses the
// phone's own quiet modes when the app is set up for it).
const LEVEL_PRIORITY = { info: 2, warn: 4, alert: 5 };
const LEVEL_TAGS = { info: 'information_source', warn: 'warning', alert: 'rotating_light' };

// PER PROCESS, and that matters more than it looks (noted 2026-07-31).
//
// The long-running services — deck, gateway, metrics, orchestrator, agents — keep
// this across every alert they raise, so the dedupe and the hourly cap below work
// as written. The ONESHOT ones do not: self-heal and code-health are a fresh
// process on every timer tick, so this map is always empty for them and neither
// limit ever applies. Their protection has to be their own durable state — as
// self-heal's `dnsNoticeDay` marker is, which is why gatetest produced 42 "does
// not resolve" detections and exactly one alert on 31 July, against 8 the day
// before.
//
// So: do not add a limit HERE and assume it covers a timer-driven caller. It will
// look correct in a test, work in the services you are watching, and do nothing at
// all in the ones that fire every five minutes.
const state = {
  warned: false,          // "no topic configured" is said once, not per alert
  recent: new Map(),      // title → {at, level} of the last push, for dedupe
  hourStart: 0,
  hourCount: 0,
};

// DURABLE twin of `state` (2026-08-19, audit move 7). The dedupe window and
// the hourly cap live in memory-server KV, shared by EVERY process — oneshot
// timers included — so the comment above stops being true: a 5-minute timer
// can no longer push the same headline every tick, and twelve processes cannot
// each spend their own twelve-an-hour. The in-process map stays as a cache and
// as the fallback when memory is unreachable (better a per-process limit than
// none). Keys: push-recent:<sha1(title)> → {at, level}; push-hour → {start, count}.
const MEMORY = 'http://127.0.0.1:9200';
const titleKey = (t) => 'push-recent:' + createHash('sha1').update(String(t)).digest('hex').slice(0, 24);
// Swappable so tests (which mock global fetch and count calls) and a future
// non-memory store can replace it: _reset() installs an in-memory stub.
let kv = { get: kvGetHttp, set: kvSetHttp };
const kvGet = (k) => kv.get(k);
const kvSet = (k, v) => kv.set(k, v);
async function kvGetHttp(key) {
  try {
    const r = await fetch(`${MEMORY}/memory/kv/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(2000) });
    const j = await r.json();
    return j && j.value ? JSON.parse(j.value) : null;
  } catch { return null; }
}
async function kvSetHttp(key, value) {
  try {
    await fetch(`${MEMORY}/memory/kv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value: JSON.stringify(value) }), signal: AbortSignal.timeout(2000),
    });
  } catch { /* memory down — in-process state still applies */ }
}

const cfg = () => ({
  topic: (process.env.NTFY_TOPIC || '').trim(),
  server: (process.env.NTFY_SERVER || DEFAULT_SERVER).replace(/\/+$/, ''),
  token: (process.env.NTFY_TOKEN || '').trim(),
  minLevel: (process.env.PUSH_MIN_LEVEL || 'warn').trim().toLowerCase(),
  disabled: process.env.PUSH_DISABLED === '1',
  click: (process.env.PUSH_CLICK_URL || '').trim(),
});

/**
 * Is a device-push transport actually configured?
 *
 * Synchronous, so it can only answer for ntfy — registered Web Push devices
 * live in KV behind an await. Use pushStatus() when the answer has to be true.
 */
export function hasPush() {
  const c = cfg();
  return !!c.topic && !c.disabled;
}

/** The honest, complete answer: which legs of the device-push channel exist. */
export async function pushStatus() {
  const c = cfg();
  const devices = await listDevices().catch(() => []);
  return {
    disabled: c.disabled,
    ntfy: !!c.topic,
    devices: devices.length,
    deviceLabels: devices.map(d => d.label),
    any: !c.disabled && (!!c.topic || devices.length > 0),
    held: await heldCount().catch(() => 0),
  };
}

/**
 * Send one push. Returns a reason string when it deliberately did nothing, so
 * callers and tests can tell "not configured" from "delivered" — the old
 * fire-and-forget style is what let the off-box watchdog look healthy for weeks
 * while delivering nothing (see docs/OFF-BOX-WATCHDOG.md).
 *
 * @returns {Promise<{sent: boolean, reason?: string, status?: number}>}
 */
export async function pushAlert({ level = 'info', title, body, source = 'jarvis', click } = {}) {
  const c = cfg();
  if (c.disabled) return { sent: false, reason: 'disabled' };
  if (!title) return { sent: false, reason: 'no-title' };
  // No longer an early return. ntfy being unconfigured used to end the function,
  // which would have silently disabled Web Push too the moment it was added —
  // a device leg switched off by the absence of an unrelated one.
  if (!c.topic && !state.warned) {
    state.warned = true;
    console.warn('[push] no NTFY_TOPIC configured — ntfy leg is OFF (Web Push to registered devices still applies)');
  }

  // notify() normalises levels before it gets here, but pushAlert() is also
  // called directly. An unrecognised level resolves UP to 'warn', never down to
  // 'info': below-threshold silence is how "job failed" alerts disappeared
  // (see LEVEL_SYNONYMS in notify.js — found by the code-health spine).
  const lvl = LEVEL_ORDER[level] ? level : 'warn';
  const min = LEVEL_ORDER[c.minLevel] ? c.minLevel : 'warn';
  if (LEVEL_ORDER[lvl] < LEVEL_ORDER[min]) return { sent: false, reason: 'below-min-level' };

  const now = Date.now();

  // Rate cap. An alert storm must not become the reason he silences the one
  // channel that works — overflow is HELD here (2026-08-27; it used to be
  // dropped and left to the inbox, which meant the twelfth warning of the hour
  // was indistinguishable from no warning at all unless he went looking).
  const perHour = guardrail('PUSH_MAX_PER_HOUR', 12, { source: 'push' });
  const hour = (await kvGet('push-hour')) || { start: state.hourStart, count: state.hourCount };
  if (now - (hour.start || 0) > 3_600_000) { hour.start = now; hour.count = 0; }
  state.hourStart = hour.start; state.hourCount = hour.count;
  if (hour.count >= perHour && lvl !== 'alert') {
    await hold({ level: lvl, title, body, source, at: new Date(now).toISOString() });
    return { sent: false, reason: 'rate-capped-held' };
  }

  // Dedupe repeats of the same headline.
  //
  // 'alert' used to be exempt entirely, on the reasoning that a real emergency
  // repeating IS the signal and self-heal caps its own retries. That holds for
  // self-heal and NOT for the agent org, which re-runs on cron and re-escalates
  // anything still unfixed — so an identical max-priority push would arrive on
  // every run, for as long as the issue lasts. Two demonstrations, both real:
  //
  //   social-media-voxlen escalated "voxlen.com is a parked for-sale page" at
  //   alert level on 19, 20, 21, 22 and 23 July — five identical alerts, and it
  //   would have kept going for the eleven days the issue has now lasted;
  //   self-heal raised the same gatetest DNS alert five times in 90 minutes on
  //   2026-07-30 (fixed at the source that day, but push.js is the last line).
  //
  // Priority 5 bypasses Do Not Disturb by design — docs/ALERTS.md tells him to
  // enable that — so identical repeats are exactly what makes someone mute the
  // one channel that works. The answer is not to silence a persistent problem but
  // to let it REMIND rather than repeat: alerts keep their own, much longer
  // window. Dedupe is per-title, so distinct criticals are unaffected; an
  // unfolding incident with different headlines still comes through in full.
  // An ESCALATION is never deduped, though: if a headline went out as a warning
  // and the same headline now arrives as an alert, the severity itself is the new
  // information. Only a repeat at the same level or lower is suppressed.
  const dedupeMs = lvl === 'alert'
    ? guardrail('PUSH_ALERT_DEDUPE_HOURS', 6, { source: 'push' }) * 3_600_000
    : guardrail('PUSH_DEDUPE_MINUTES', 10, { source: 'push' }) * 60_000;
  const last = (await kvGet(titleKey(title))) || state.recent.get(title);
  if (last && now - last.at < dedupeMs && LEVEL_ORDER[lvl] <= LEVEL_ORDER[last.level]) {
    return { sent: false, reason: 'deduped' };
  }

  // Triage (lib/alert-smart.js): wake him, or wait for him? And where does
  // tapping it take him? A warn at 3am is held for the morning digest; an alert
  // never is.
  const route = routeAlert({ level: lvl, source, title, now: new Date(now) });
  if (route.hold) {
    await hold({ level: lvl, title, body, source, at: new Date(now).toISOString() });
    return { sent: false, reason: route.reason, held: true };
  }

  const clickUrl = click || deepLink(route.view, c.click);
  const results = await Promise.all([
    sendNtfy({ c, lvl, title, body, source, clickUrl }),
    // The deck's own devices — his iPhone and iPad. Failure here must not stop
    // the ntfy leg and vice versa: two transports exist precisely so that one
    // being broken is survivable.
    deliverWebPush(
      { level: lvl, title, body: body || title, source, view: route.view, url: clickUrl, ts: new Date(now).toISOString() },
      { ttl: route.ttl, urgency: route.urgency, topic: route.topic },
    ).catch(e => ({ sent: 0, reason: 'error', error: e.message })),
  ]);
  const [ntfy, web] = results;
  const sent = !!ntfy.sent || (web.sent || 0) > 0;

  // The dedupe/rate ledger advances only on a delivery that actually happened.
  // Advancing it on a failed send would suppress the RETRY of an alert nobody
  // received — the quiet failure this whole module exists to prevent.
  if (sent) {
    state.recent.set(title, { at: now, level: lvl });
    state.hourCount++;
    if (state.recent.size > 200) state.recent.clear();  // unbounded maps are leaks
    await kvSet(titleKey(title), { at: now, level: lvl });
    await kvSet('push-hour', { start: state.hourStart, count: state.hourCount });
  }
  return {
    sent,
    reason: sent ? undefined : (ntfy.reason || web.reason || 'no-transport'),
    // Kept at the top level: callers and tests have read `status` since this
    // module shipped, and an HTTP refusal is the one failure worth naming
    // precisely (a 403 from ntfy is a revoked token, not a flaky network).
    status: ntfy.status,
    ntfy: ntfy.sent ? 'ok' : (ntfy.reason || 'failed'),
    devices: web.sent || 0,
    of: web.devices || 0,
  };
}

/** The deck tab this alert is about, as a URL a phone can open. */
function deepLink(view, base) {
  if (!base) return '';
  try {
    const u = new URL(base);
    if (view) u.searchParams.set('view', view);
    return u.toString();
  } catch { return base; }
}

/** The ntfy leg, unchanged in behaviour — just no longer the whole function. */
async function sendNtfy({ c, lvl, title, body, source, clickUrl }) {
  if (!c.topic) return { sent: false, reason: 'no-topic' };
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    // The visual marker comes from Tags (ntfy renders those as emoji itself) —
    // putting one in Title would only be escaped away by asciiHeader below.
    Title: asciiHeader(title),
    Priority: String(LEVEL_PRIORITY[lvl]),
    Tags: LEVEL_TAGS[lvl],
  };
  if (clickUrl) headers.Click = clickUrl;
  if (c.token) headers.Authorization = `Bearer ${c.token}`;
  try {
    const r = await fetch(`${c.server}/${encodeURIComponent(c.topic)}`, {
      method: 'POST',
      headers,
      body: `${body || title}\n\n— ${source}`,
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      console.warn(`[push] ntfy responded ${r.status}`);
      return { sent: false, reason: 'http', status: r.status };
    }
    return { sent: true, status: r.status };
  } catch (e) {
    console.warn(`[push] ntfy failed: ${e.message}`);
    return { sent: false, reason: 'error' };
  }
}

// ── the held queue ───────────────────────────────────────────────────────────
//
// Held is not dropped. Everything in here is already durable in the memory
// inbox — this queue exists so it also ARRIVES, as one line in the morning
// rather than eleven buzzes at 2am. Durable in KV for the reason recorded at
// the top of this file: most callers are oneshot timers, so anything kept in
// process memory is empty on every tick and gates nothing.

const HELD_KEY = 'push-held';
const HELD_MAX = 50;

async function hold(item) {
  const cur = (await kvGet(HELD_KEY)) || { items: [] };
  const items = Array.isArray(cur.items) ? cur.items : [];
  // Collapse a repeat of the same headline rather than listing it eleven times:
  // a digest that is one message repeated is the flood, delayed.
  const dup = items.find(i => i.title === item.title);
  if (dup) { dup.count = (dup.count || 1) + 1; dup.at = item.at; }
  else items.push({ ...item, count: 1 });
  await kvSet(HELD_KEY, { items: items.slice(-HELD_MAX) });
}

/**
 * Deliver the held queue as one digest, if it is time.
 *
 * Called from the orchestrator's 30-second loop — the same place due reminders
 * fire — rather than from a tenth systemd timer. Safe to call constantly: it
 * returns immediately unless shouldFlush() says otherwise.
 */
export async function flushHeld({ force = false, now = new Date() } = {}) {
  const cur = (await kvGet(HELD_KEY)) || { items: [] };
  const items = Array.isArray(cur.items) ? cur.items : [];
  if (!items.length) return { flushed: 0 };
  if (!force && !shouldFlush(items, { now })) return { flushed: 0, holding: items.length };

  const digest = buildDigest(items);
  if (!digest) return { flushed: 0 };

  // Clear FIRST. A flush that fails after sending would otherwise re-send the
  // same digest every 30 seconds; the items are still in the inbox either way,
  // so losing a digest is recoverable and repeating one is not.
  await kvSet(HELD_KEY, { items: [] });

  const c = cfg();
  const clickUrl = deepLink('ops', c.click);
  const [ntfy, web] = await Promise.all([
    sendNtfy({ c, lvl: 'warn', title: digest.title, body: digest.body, source: 'held-digest', clickUrl }),
    deliverWebPush(
      { level: 'warn', title: digest.title, body: digest.body, source: 'held-digest', view: 'ops', url: clickUrl, ts: now.toISOString() },
      { ttl: 21600, urgency: 'normal', topic: 'held-digest' },
    ).catch(e => ({ sent: 0, error: e.message })),
  ]);
  return { flushed: digest.count, ntfy: !!ntfy.sent, devices: web.sent || 0 };
}

/** How many notifications are waiting for the next digest. */
export async function heldCount() {
  const cur = (await kvGet(HELD_KEY)) || { items: [] };
  return Array.isArray(cur.items) ? cur.items.length : 0;
}

/**
 * ntfy headers are HTTP headers, and HTTP headers are latin-1. An emoji in a
 * Title crashes undici with ERR_INVALID_CHAR before anything is sent — so a
 * decorative character could take out the whole alert channel. Non-latin-1 goes
 * out as an escape rather than an exception.
 */
function asciiHeader(s) {
  return String(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, (ch) => {
    const cp = ch.codePointAt(0);
    return cp > 0xFF ? `\\u${cp.toString(16).padStart(4, '0')}` : '';
  }).trim() || 'Jarvis';
}

/** Test seam — drops dedupe/rate state. */
export function _reset() {
  state.warned = false;
  state.recent.clear();
  state.hourStart = 0;
  state.hourCount = 0;
  // Tests run against an in-memory KV: durable semantics, no network.
  const mem = new Map();
  kv = { get: async (k) => (mem.has(k) ? mem.get(k) : null), set: async (k, v) => { mem.set(k, v); } };
  // The device store gets one too, or every assertion about "how many HTTP
  // calls did this make" silently counts push-subs' KV read as an ntfy post.
  const subMem = new Map();
  _setSubsKv({ get: async (k) => (subMem.has(k) ? subMem.get(k) : null), set: async (k, v) => { subMem.set(k, v); return true; } });
}
/** Install a KV transport ({get(key)→value|null, set(key,value)}). Production = memory-server over HTTP. */
export function _setKv(transport) { kv = transport; }

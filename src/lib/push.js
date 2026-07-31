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

const DEFAULT_SERVER = 'https://ntfy.sh';

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

const cfg = () => ({
  topic: (process.env.NTFY_TOPIC || '').trim(),
  server: (process.env.NTFY_SERVER || DEFAULT_SERVER).replace(/\/+$/, ''),
  token: (process.env.NTFY_TOKEN || '').trim(),
  minLevel: (process.env.PUSH_MIN_LEVEL || 'warn').trim().toLowerCase(),
  disabled: process.env.PUSH_DISABLED === '1',
  click: (process.env.PUSH_CLICK_URL || '').trim(),
});

/** Is a device-push transport actually configured? */
export function hasPush() {
  const c = cfg();
  return !!c.topic && !c.disabled;
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
  if (!c.topic) {
    if (!state.warned) {
      state.warned = true;
      console.warn('[push] no NTFY_TOPIC configured — device alerts are OFF (set it in config/secrets.env)');
    }
    return { sent: false, reason: 'no-topic' };
  }
  if (!title) return { sent: false, reason: 'no-title' };

  // notify() normalises levels before it gets here, but pushAlert() is also
  // called directly. An unrecognised level resolves UP to 'warn', never down to
  // 'info': below-threshold silence is how "job failed" alerts disappeared
  // (see LEVEL_SYNONYMS in notify.js — found by the code-health spine).
  const lvl = LEVEL_ORDER[level] ? level : 'warn';
  const min = LEVEL_ORDER[c.minLevel] ? c.minLevel : 'warn';
  if (LEVEL_ORDER[lvl] < LEVEL_ORDER[min]) return { sent: false, reason: 'below-min-level' };

  const now = Date.now();

  // Rate cap. An alert storm must not become the reason he silences the one
  // channel that works — overflow is dropped here and still lives in the inbox.
  const perHour = guardrail('PUSH_MAX_PER_HOUR', 12, { source: 'push' });
  if (now - state.hourStart > 3_600_000) { state.hourStart = now; state.hourCount = 0; }
  if (state.hourCount >= perHour && lvl !== 'alert') return { sent: false, reason: 'rate-capped' };

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
  const last = state.recent.get(title);
  if (last && now - last.at < dedupeMs && LEVEL_ORDER[lvl] <= LEVEL_ORDER[last.level]) {
    return { sent: false, reason: 'deduped' };
  }

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    // The visual marker comes from Tags (ntfy renders those as emoji itself) —
    // putting one in Title would only be escaped away by asciiHeader below.
    Title: asciiHeader(title),
    Priority: String(LEVEL_PRIORITY[lvl]),
    Tags: LEVEL_TAGS[lvl],
  };
  const clickUrl = click || c.click;
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
    state.recent.set(title, { at: now, level: lvl });
    state.hourCount++;
    if (state.recent.size > 200) state.recent.clear();  // unbounded maps are leaks
    return { sent: true, status: r.status };
  } catch (e) {
    console.warn(`[push] ntfy failed: ${e.message}`);
    return { sent: false, reason: 'error' };
  }
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
}

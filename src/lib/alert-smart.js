/**
 * alert-smart.js — the difference between a phone that alerts and a phone that
 * gets muted (2026-08-27, Craig: "we need smart alerts pushed and enabled
 * through to the mobile and ipad devices").
 *
 * Everything here is a pure decision about ONE notification. It sends nothing;
 * push.js does the sending. That split exists because every rule below was
 * earned by an incident, and a rule you cannot write a test for is a rule that
 * quietly stops applying:
 *
 *   - 235 pushes in 48 hours for a PC that was fine (2026-08-10). The lesson
 *     recorded in CLAUDE.md was "use a daily marker", which fixed that caller.
 *     It did not fix the shape: any timer that can reach `alert` can still do
 *     it, because `alert` is exempt from both the dedupe and the hourly cap.
 *   - Five identical "voxlen.com is a parked page" alerts on five consecutive
 *     days, at priority 5, which bypasses Do Not Disturb by design.
 *
 *   Both are the same failure: a channel that treats 3am and 3pm identically,
 *   and treats "the box is on fire" and "a finding is still open" identically.
 *   A phone that buzzes at 3am for a code finding gets its notifications turned
 *   off, and then NOTHING reaches him — including the fire.
 *
 * So the smartness is not cleverness, it is triage with three questions:
 *   1. Does this deserve to WAKE him, or to be waiting when he next looks?
 *   2. Where should tapping it TAKE him? (a notification with nowhere to go is
 *      a notification he has to do work to act on, at the worst moment to)
 *   3. Should it REPLACE the last one about the same thing, or stack on it?
 *
 * Quiet hours deliberately never hold an `alert`. The whole point of the
 * off-box watchdog and the 5-minute fleet check is the 3am case; a quiet-hours
 * rule that silences those would be the most expensive line in the repo.
 */

import { guardrail } from './guardrail.js';
import { createHash } from 'crypto';

const TZ = 'Pacific/Auckland';

/** Local hour in NZ, 0–23. Intl rather than an offset: NZDT is a thing. */
export function localHour(now = new Date(), tz = TZ) {
  const h = new Intl.DateTimeFormat('en-NZ', { timeZone: tz, hour: 'numeric', hour12: false }).format(now);
  // 'en-NZ' renders midnight as '24' in some ICU builds — normalise it.
  return Number(h) % 24;
}

/** guardrail() bounds a number below, not above — an hour needs both ends. */
const clampHour = (n) => Math.min(23, Math.max(0, Math.trunc(Number(n) || 0)));

/**
 * Is it the middle of Craig's night?
 *
 * Wraps midnight, so the comparison is an OR, not a range — the version that
 * reads `h >= start && h < end` is silently false all night, every night, and
 * looks correct.
 */
export function inQuietHours(now = new Date(), { start, end, tz = TZ } = {}) {
  // allowZero because midnight is a legitimate boundary, and guardrail()'s
  // default rejection of 0 would silently turn ALERT_QUIET_END=0 into 7.
  const s = clampHour(start ?? guardrail('ALERT_QUIET_START', 22, { source: 'alert-smart', allowZero: true }));
  const e = clampHour(end ?? guardrail('ALERT_QUIET_END', 7, { source: 'alert-smart', allowZero: true }));
  const h = localHour(now, tz);
  if (s === e) return false;                 // quiet hours disabled by making them empty
  return s < e ? (h >= s && h < e) : (h >= s || h < e);
}

/**
 * Which deck tab answers this alert?
 *
 * A push that opens the deck's default view makes him navigate, on a phone, at
 * whatever hour it arrived. Every source we raise alerts from has an obvious
 * destination, so it may as well land there. Unknown sources go to the HUD,
 * which is the honest default rather than a guess.
 */
export function deckView(source = '', title = '') {
  const s = `${source} ${title}`.toLowerCase();
  if (/finding|code-health|fix-runner|review|proposal|inbox|mail|report/.test(s)) return 'ops';
  if (/fleet|platform|self-heal|deploy|uptime|dns|health/.test(s)) return 'plat';
  if (/agent|officer|scheduler|org/.test(s)) return 'org';
  if (/job|dispatch|queue|orchestrat/.test(s)) return 'flow';
  return 'hud';
}

/**
 * The collapse key. Two notifications sharing it never stack on the lock
 * screen — the newer replaces the older.
 *
 * Keyed on the TITLE, matching push.js's dedupe, so the two layers agree about
 * what "the same alert" means. They protect different things: dedupe stops us
 * SENDING a repeat, collapse stops a repeat that was already in flight (phone
 * in a pocket, radio asleep) from arriving as a pile the moment it unlocks.
 */
export function collapseTopic(title = '') {
  return createHash('sha1').update(String(title)).digest('base64url').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
}

/**
 * Decide what happens to one notification.
 *
 * @returns {{deliver:boolean, hold:boolean, reason:string, urgency:string,
 *            ttl:number, topic:string, view:string}}
 */
export function routeAlert({ level = 'info', source = '', title = '', now = new Date(), quiet = null } = {}) {
  const view = deckView(source, title);
  const topic = collapseTopic(title);
  const isQuiet = quiet === null ? inQuietHours(now) : !!quiet;

  if (level === 'alert') {
    // Wakes the device. TTL is a full day: if his phone is off or out of
    // coverage, an unfixed fire is still worth telling him about when it
    // comes back, and it is the one class where lateness beats silence.
    return { deliver: true, hold: false, reason: 'alert', urgency: 'high', ttl: 86400, topic, view };
  }
  if (level === 'warn') {
    if (isQuiet) {
      // Held, not dropped — the distinction the inbox already makes and the
      // push layer never did. flushDigest() delivers these as one line in the
      // morning, so an overnight warn is late rather than lost.
      return { deliver: false, hold: true, reason: 'quiet-hours', urgency: 'low', ttl: 21600, topic, view };
    }
    return { deliver: true, hold: false, reason: 'warn', urgency: 'normal', ttl: 21600, topic, view };
  }
  // info never buzzes anything. It is already durable in the inbox and visible
  // on the deck's OPS tab; a phone that vibrates for routine chatter is the
  // Slack firehose again.
  return { deliver: false, hold: false, reason: 'below-min-level', urgency: 'low', ttl: 3600, topic, view };
}

/**
 * Turn everything held overnight into ONE notification.
 *
 * Grouped by source, because "4 warnings" is not actionable and "3 fleet-check,
 * 1 code-health" tells him whether to get up. Titles are included up to a
 * readable limit — the full set is in the inbox the tap opens.
 */
export function buildDigest(held = [], { max = 6 } = {}) {
  const items = held.filter(h => h && h.title);
  if (!items.length) return null;

  const bySource = new Map();
  for (const h of items) {
    const k = h.source || 'jarvis';
    bySource.set(k, (bySource.get(k) || 0) + 1);
  }
  const breakdown = [...bySource.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');

  const lines = items.slice(-max).map(h => `• ${h.title}`);
  if (items.length > max) lines.unshift(`(showing the last ${max} of ${items.length})`);

  return {
    title: items.length === 1 ? items[0].title : `${items.length} held overnight — ${breakdown}`,
    body: lines.join('\n'),
    count: items.length,
  };
}

/**
 * Should the held queue go out now?
 *
 * Two triggers, and the second is the one that matters: quiet hours ending is
 * the normal path, but a queue that is only ever flushed by a clock is a queue
 * that never flushes if the flusher is down at 7am. `maxAgeMin` guarantees
 * anything held eventually arrives, whatever the hour.
 */
export function shouldFlush(held = [], { now = new Date(), quiet = null, maxAgeMin = null } = {}) {
  if (!held.length) return false;
  const isQuiet = quiet === null ? inQuietHours(now) : !!quiet;
  if (!isQuiet) return true;
  const cap = maxAgeMin ?? guardrail('ALERT_HOLD_MAX_MINUTES', 600, { source: 'alert-smart' });
  const oldest = held.reduce((min, h) => Math.min(min, Date.parse(h.at) || Infinity), Infinity);
  return Number.isFinite(oldest) && (now.getTime() - oldest) > cap * 60_000;
}

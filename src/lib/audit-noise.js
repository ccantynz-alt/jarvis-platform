/**
 * Audit repeat suppression — src/lib/audit-noise.js
 *
 * An audit that finds the SAME thing it found yesterday is not news, and
 * saying it at the same volume every day is how a notification channel gets
 * ignored (2026-08-05, Craig: "why am i receiving over 100 slack
 * notifications").
 *
 * What was actually happening. Two platforms can never be auto-fixed by
 * design — vapron has no local checkout on this box, screenshot-to-code is a
 * third-party fork carrying `noAutoFix` — so their audits landed on an
 * identical `critical` verdict every single day, forever:
 *
 *   VAPRON AUDIT REPORT — Score: 50/100 — HTTP: https://vapron.ai — status 000
 *   SCREENSHOT-TO-CODE  — Score: 47/100 — HTTP: http://127.0.0.1:3000 — ...
 *
 * Byte-identical, once a day, since 30 July. Each one posted to Slack at
 * `critical` (which bypasses quiet hours AND mute in notify-center.js) and
 * raised a `warn` notify(), which is at/above PUSH_MIN_LEVEL and therefore
 * buzzed his phone through ntfy as well. NotifyCenter's per-key dedupe could
 * never catch it: its cooldown is 30 minutes and the repeat interval is 24
 * hours, so every repeat arrived looking brand new.
 *
 * The rule: say it, say it once more, then stop shouting until something
 * CHANGES. Nothing is dropped — a stale repeat still lands in the durable
 * inbox and still shows in the Slack digest, so the condition stays visible
 * for as long as it lasts. What stops is the interrupt: no `critical` Slack
 * post, no phone push, no spoken alert.
 *
 * Note what "changed" means here: the fingerprint covers the verdict, the
 * score AND the sorted error list, so a platform that breaks in a NEW way
 * announces itself immediately even if it was already critical yesterday.
 * That is the case this must never suppress — "already broken" must not
 * become a reason to swallow "and now it is broken differently".
 *
 * Pure functions only — no I/O, no clock. Tests: test/audit-noise.test.js.
 */

/**
 * How many consecutive IDENTICAL audit results still get announced at full
 * volume before the condition is treated as known. Two, not one: the first
 * could be a flake, and hearing it twice is what tells you it is real.
 */
export const ANNOUNCE_REPEATS = 2;

/**
 * A stable identity for "what this audit found".
 *
 * Errors are sorted because their order is an artifact of how the checks ran
 * (httpFailed then screenshotsFailed, each in registry order) and a reorder
 * is not a change worth re-announcing. They are NOT truncated: two different
 * failures that happen to share a prefix must not collide into one
 * fingerprint, or the second one would be silently suppressed as a repeat.
 */
export function auditFingerprint(report = {}) {
  const errors = Array.isArray(report.errors) ? report.errors.map(e => String(e)) : [];
  return [
    report.status ?? 'unknown',
    report.health_score ?? 'null',
    ...errors.slice().sort(),
  ].join('|');
}

/**
 * How many times in a row this exact result has now been seen (1 = first).
 *
 * `prev` is whatever was stored on the platform_state row last time, which on
 * a first run — or on a row written before this column existed — is null.
 * A null/absent previous fingerprint must count as a change, never as a
 * match, otherwise a brand-new platform's first critical would be born
 * already-suppressed.
 */
export function nextRepeat(prevFingerprint, prevRepeat, fingerprint) {
  if (!fingerprint || !prevFingerprint || prevFingerprint !== fingerprint) return 1;
  const n = Number(prevRepeat);
  return Number.isFinite(n) && n > 0 ? n + 1 : 1;
}

/** True once this identical result has been announced its allotted times. */
export function isStaleRepeat(repeat) {
  const n = Number(repeat);
  // An unusable value means we do not KNOW it is a repeat — announce it.
  // Suppression is the dangerous default; announcing is merely noisy.
  return Number.isFinite(n) && n > ANNOUNCE_REPEATS;
}

/**
 * The level a Slack audit report should post at.
 *
 * Mirrors the mapping that used to be inline in slack-bridge.js's
 * /slack/report, with the repeat rule folded in. 'healthy' was already
 * digest-only; the change is that a stale critical/warning joins it there
 * instead of interrupting.
 */
export function auditSlackLevel(status, repeat) {
  if (status === 'healthy') return 'info';
  if (isStaleRepeat(repeat)) return 'info';
  return status === 'warning' ? 'warning' : 'critical';
}

/**
 * The level an audit notify() should raise — the channel that reaches his
 * phone. 'info' sits below PUSH_MIN_LEVEL (warn), so a stale repeat is
 * recorded in the inbox without buzzing anything.
 */
export function auditNotifyLevel(intendedLevel, repeat) {
  return isStaleRepeat(repeat) ? 'info' : intendedLevel;
}

/**
 * Suffix appended to a stale repeat's title so the inbox entry still explains
 * itself. Without this a demoted alert looks like a different, lesser event
 * rather than the same one being reported quietly for the Nth day.
 */
export function repeatSuffix(repeat) {
  return isStaleRepeat(repeat) ? ` — unchanged, day ${repeat} (quiet until it changes)` : '';
}

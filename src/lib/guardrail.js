/**
 * guardrail.js — parse a numeric limit from the environment so it can never
 * silently vanish.
 *
 * This is the 2026-07-17 lesson, generalised. systemd's EnvironmentFile does
 * NOT strip inline comments, so `SELF_HEAL_MAX_ATTEMPTS=6 # per day` arrives as
 * the string "6 # per day". Number() makes that NaN, and EVERY comparison
 * against NaN is false — so `attempts < MAX` never blocks. All four self-heal
 * gates disabled themselves at once and the box fired 117 repair dispatches in
 * a day against a cap of 6. Nothing errored. Nothing looked wrong.
 *
 * The failure mode is what makes this worth a shared module: a guardrail that
 * breaks LOUDLY is a bug, but a guardrail that breaks SILENTLY and open is an
 * incident. Any limit read from the environment should come through here.
 *
 * Note that `parseInt(x, 10) || fallback` and `Number(x) || fallback` are only
 * accidentally safe — they collapse a malformed value to the default, which
 * hides the operator's mistake instead of reporting it. A bare
 * `parseInt(x, 10)` with no `||` (what tts.js and tts-stream.js had) reproduces
 * the original NaN bug exactly.
 */

/**
 * @param {string} name      env var name
 * @param {number} fallback  used when unset, malformed, or non-positive
 * @param {object} [opts]
 * @param {string} [opts.source]      log tag, e.g. 'tts'
 * @param {boolean} [opts.allowZero]  accept 0 (e.g. "disabled"); default false
 * @returns {number} always finite
 */
export function guardrail(name, fallback, { source = 'guardrail', allowZero = false } = {}) {
  const raw = process.env[name];
  // Take the leading token: "6 # per day" → "6". Whitespace or a # ends it.
  const n = Number(String(raw ?? '').trim().split(/\s|#/)[0]);
  const ok = Number.isFinite(n) && (allowZero ? n >= 0 : n > 0);
  if (ok) return n;
  if (raw !== undefined && String(raw).trim() !== '') {
    console.error(`[${source}] BAD GUARDRAIL ${name}=${JSON.stringify(raw)} — using default ${fallback}`);
  }
  return fallback;
}

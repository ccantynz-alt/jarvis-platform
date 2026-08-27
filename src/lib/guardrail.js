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
/**
 * A row limit from an untrusted query param.
 *
 * Same family as guardrail() — a numeric bound that must not fail open — but the
 * input is a request rather than the environment, and the failure is sharper:
 * `Math.min(parseInt(raw, 10) || 50, 500)` clamps the TOP and not the bottom, so
 * `?limit=-1` yields -1, and **SQLite documents a negative LIMIT as "no upper
 * bound on the number of rows returned"**. One query param and a paged endpoint
 * dumps the whole table. That pattern was live on five endpoints across
 * memory-server and the orchestrator until 2026-07-30 (found by the code-health
 * spine, input-trust lens).
 *
 * @param {*} raw          req.query.limit, or anything
 * @param {number} dflt    used when absent or unparseable
 * @param {number} max     hard ceiling
 */
export function clampLimit(raw, dflt = 50, max = 500) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return dflt;
  return Math.min(n, max);
}

export function guardrail(name, fallback, { source = 'guardrail', allowZero = false } = {}) {
  const raw = process.env[name];
  // UNSET means "use the default", and it has to be decided BEFORE parsing
  // (found 2026-08-27 while adding quiet hours to the alert layer).
  //
  // `Number('')` is 0, not NaN — one of the few places JavaScript coerces
  // absence into a number rather than into NaN. So with allowZero:true, the
  // `n >= 0` check below accepted that phantom zero and an UNSET variable
  // returned 0 instead of its fallback: `guardrail('ALERT_QUIET_END', 7,
  // {allowZero:true})` gave 0, and quiet hours silently became empty. The
  // callers that ask for allowZero are exactly the ones where 0 means "off",
  // so the failure mode is always a disabled feature that reports no error —
  // this module's entire reason for existing, reproduced inside it.
  //
  // Every allowZero call site on the box today sets its variable explicitly, so
  // nothing in production was running on a phantom zero; it was waiting for the
  // next caller that relied on the default.
  if (raw === undefined || String(raw).trim() === '') return fallback;
  // Take the leading token: "6 # per day" → "6". Whitespace or a # ends it.
  const n = Number(String(raw).trim().split(/\s|#/)[0]);
  const ok = Number.isFinite(n) && (allowZero ? n >= 0 : n > 0);
  if (ok) return n;
  if (raw !== undefined && String(raw).trim() !== '') {
    console.error(`[${source}] BAD GUARDRAIL ${name}=${JSON.stringify(raw)} — using default ${fallback}`);
  }
  return fallback;
}

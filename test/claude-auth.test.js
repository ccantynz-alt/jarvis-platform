// classifyFailure — the pure classifier that decides how Jarvis reacts to a
// dead Claude turn. Getting the KIND wrong is expensive: a model rejection
// misread as 'other' makes brain-claude.js escalate to a tier the same stale
// binary also rejects, and Craig gets an outage-shaped alert for a
// CLI-version problem (2026-07-28 incident).

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../src/lib/claude-auth.js';

// Verbatim from `claude --model claude-bogus-9 --print hi` on claude 2.1.220.
const CLI_MODEL_REJECTION =
  "There's an issue with the selected model (claude-opus-5). It may not exist or you may not have access to it.";

test('model rejection is classified as model, not other', () => {
  const got = classifyFailure({ message: CLI_MODEL_REJECTION });
  assert.equal(got.kind, 'model');
});

test('model rejection carries the rejected model id for the alert', () => {
  assert.equal(classifyFailure({ message: CLI_MODEL_REJECTION }).model, 'claude-opus-5');
});

test('model rejection is detected on stderr as well as message', () => {
  assert.equal(classifyFailure({ stderr: CLI_MODEL_REJECTION, code: 1 }).kind, 'model');
});

test('other API-shaped model errors also classify as model', () => {
  for (const text of ['Unknown model: claude-fable-5', 'invalid model', 'model_not_found']) {
    assert.equal(classifyFailure({ message: text }).kind, 'model', text);
  }
});

// Guard the ordering in classifyFailure: the new MODEL_RE sits after the limit
// and auth checks, so those must still win on their own text.
test('usage limits still outrank the model check', () => {
  const got = classifyFailure({ message: 'Claude AI usage limit reached|1799999999' });
  assert.equal(got.kind, 'usage_limit');
});

test('auth failures still outrank the model check', () => {
  assert.equal(classifyFailure({ message: 'Invalid API key · Please run /login' }).kind, 'auth');
});

// Our own watchdogs (brain-claude.js runTurn). These MUST NOT classify as
// 'other': that branch escalates to a heavier tier, which is slower, so a
// latency failure would be answered with something more likely to time out.
// Observed live on the box 2026-07-28 20:33.
test('first-token watchdog is a timeout, not a generic failure', () => {
  assert.equal(classifyFailure({ message: 'claude brain: no first token in time' }).kind, 'timeout');
});

test('turn watchdog is a timeout', () => {
  assert.equal(classifyFailure({ message: 'claude brain: turn timed out' }).kind, 'timeout');
});

test('a usage limit reported during a slow turn is still a usage limit', () => {
  // Ordering guard: LIMIT_RE runs first, so a limit that also mentions a
  // timeout must not be downgraded to a same-tier retry.
  const got = classifyFailure({ message: 'usage limit reached — turn timed out' });
  assert.equal(got.kind, 'usage_limit');
});

test('unrelated failures stay other', () => {
  assert.equal(classifyFailure({ message: 'ECONNRESET socket hang up' }).kind, 'other');
  assert.equal(classifyFailure({}).kind, 'other');
});

// ── usageHold: the gate that keeps work instead of failing it ────────────────
// claude-auth has always told Craig out loud that "Claude-runtime work is held
// until the earliest reset". Nothing enforced it: the orchestrator ignored
// spawnClaude's limitHeld flag and marked the job FAILED, then started the next
// one into the same wall. Found by the code-health spine, 2026-07-30.

import { usageHold } from '../src/lib/claude-auth.js';

const T = 1_800_000_000_000;

test('no profiles at all is not a hold — there is nothing to wait for', () => {
  assert.equal(usageHold({ profiles: [], now: T, state: {} }).held, false);
});

test('one usable account means work continues', () => {
  const state = { default: T + 60_000 };   // exhausted; the other is fine
  assert.equal(usageHold({ profiles: ['default', 'second'], now: T, state }).held, false);
});

test('an expired cooldown counts as usable', () => {
  const state = { default: T - 1, second: T - 1 };
  assert.equal(usageHold({ profiles: ['default', 'second'], now: T, state }).held, false);
});

test('every account exhausted holds until the EARLIEST reset', () => {
  const state = { default: T + 90 * 60_000, second: T + 20 * 60_000 };
  const hold = usageHold({ profiles: ['default', 'second'], now: T, state });
  assert.equal(hold.held, true);
  assert.equal(hold.until, T + 20 * 60_000, 'work resumes when the FIRST account comes back, not the last');
  assert.equal(hold.at, new Date(T + 20 * 60_000).toISOString());
});

// ── The three-day blind spot (2026-08-16) ───────────────────────────────────
// Both claude.ai logins on the box expired. Every box-local spawn then failed
// in ~2s, and the eight autonomous timers did nothing for three days while all
// twelve services reported green. Three separate defects made that possible;
// one test each.

import { classifyFailure as classify2, utcDay } from '../src/lib/claude-auth.js';

// Verbatim from `claude --model claude-opus-5 --print hi` on the box, 2026-08-16.
const EXPIRED_OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';

test('the live expired-OAuth string classifies as auth, not other', () => {
  // If this ever regresses to 'other', spawn-agent silently burns the job and
  // brain-claude escalates to a heavier tier that fails identically.
  assert.equal(classify2({ stderr: EXPIRED_OAUTH, code: 1 }).kind, 'auth');
});

test('an auth failure outranks nothing it should not — limits still win', () => {
  // Ordering guard: LIMIT_RE is checked before AUTH_RE/AUTH_RE2, and a message
  // mentioning both must be treated as the recoverable one.
  const both = `${EXPIRED_OAUTH}\nClaude AI usage limit reached`;
  assert.equal(classify2({ message: both }).kind, 'usage_limit');
});

test('the auth alert is rate-limited by UTC DAY, not by process lifetime', () => {
  // The old limiter was an in-process `lastAuthAlert` timestamp. Every caller
  // is a systemd ONESHOT, so it reset on every run and gated nothing — and the
  // notify is level:'alert', which is exempt from push dedupe AND the hourly
  // cap. That combination is precisely the 235-buzz flood of 2026-08-10.
  const morning = Date.parse('2026-08-16T01:25:00Z');
  const evening = Date.parse('2026-08-16T23:59:59Z');
  const nextDay = Date.parse('2026-08-17T00:00:01Z');
  assert.equal(utcDay(morning), utcDay(evening), 'same UTC day must share one marker');
  assert.notEqual(utcDay(evening), utcDay(nextDay), 'a new day must be allowed to alert again');
  assert.equal(utcDay(morning), '2026-08-16');
});

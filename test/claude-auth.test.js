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

// ── 2026-08-17: the failover that flapped between two dead accounts ──────────
// From 2026-08-14 both claude.ai logins on the box were dead. This decision ran
// every 6-15 minutes and each time announced a switch to the other account,
// which was equally dead: 171 claude-auth notifications in seven days. The
// cause was `authBroken` living only in process memory while every autonomous
// caller is a systemd oneshot — the SAME defect this file's tests above record
// as fixed for the alert limiter on 2026-08-16, one layer further down.

import { authFailoverPlan, classifyFailure as classify3 } from '../src/lib/claude-auth.js';

// Verbatim from `claude --model claude-opus-5 --print hi` on box 158
// (claude 2.1.223), 2026-08-17.
const ORG_DISABLED =
  'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';

const NOW = Date.parse('2026-08-17T07:00:00Z');
const TODAY = '2026-08-17';

test('a profile whose login is DURABLY broken is not a failover target', () => {
  // The flap in one assertion: without the durable cooldown, `next` came back
  // as 'account-b' forever and every oneshot announced a fresh "recovery".
  const plan = authFailoverPlan({
    profiles: ['default', 'account-b'], name: 'default',
    authBroken: { 'account-b': NOW + 60_000 }, now: NOW,
  });
  assert.equal(plan.next, null);
  assert.equal(plan.announce, 'alert', 'no usable login is a total outage, not a switch');
});

test('an expired cooldown lets the other login be tried again', () => {
  // Short on purpose: `claude login` is a human action that can land any moment.
  const plan = authFailoverPlan({
    profiles: ['default', 'account-b'], name: 'default',
    authBroken: { 'account-b': NOW - 1 }, now: NOW,
  });
  assert.equal(plan.next, 'account-b');
});

test('a switch is announced once per UTC day, not once per oneshot', () => {
  const args = {
    profiles: ['default', 'account-b'], name: 'default',
    authBroken: {}, now: NOW,
  };
  assert.equal(authFailoverPlan({ ...args }).announce, 'warn', 'first switch of the day is worth saying');
  assert.equal(authFailoverPlan({ ...args, warnedDay: TODAY }).announce, null, 'the 90th is not');
  assert.equal(authFailoverPlan({ ...args, warnedDay: '2026-08-16' }).announce, 'warn', 'a new day speaks again');
});

test('the warn marker cannot suppress the far more important alert', () => {
  // Deliberately separate keys: a day that already carried a "switched to X"
  // warn must still be able to carry "every autonomous agent is stopped".
  const plan = authFailoverPlan({
    profiles: ['default', 'account-b'], name: 'default',
    authBroken: { 'account-b': NOW + 60_000 }, now: NOW,
    warnedDay: TODAY, alertedDay: null,
  });
  assert.equal(plan.announce, 'alert');
});

test('the total-outage alert is still once a day', () => {
  const plan = authFailoverPlan({
    profiles: ['default', 'account-b'], name: 'default',
    authBroken: { 'account-b': NOW + 60_000 }, now: NOW, alertedDay: TODAY,
  });
  assert.equal(plan.announce, null);
});

test('a usage-exhausted profile is not a login failover target either', () => {
  const plan = authFailoverPlan({
    profiles: ['default', 'account-b'], name: 'default',
    exhausted: { 'account-b': NOW + 60_000 }, now: NOW,
  });
  assert.equal(plan.next, null);
});

test('the org-disabled message classifies as auth, not other', () => {
  // It classified as 'other' until 2026-08-17, so spawn-agent.js broke straight
  // out of its auth branch: no failover, no alert, no authHeld — just a generic
  // "agent exited 1" for the one error that names its own fix.
  assert.equal(classify3({ stderr: ORG_DISABLED, code: 1 }).kind, 'auth');
  assert.equal(classify3({ stderr: ORG_DISABLED, code: 1 }).reason, 'org_disabled');
});

test('an ordinary expired session is still reason:session', () => {
  assert.equal(classify3({ stderr: EXPIRED_OAUTH, code: 1 }).reason, 'session');
});

test('org_disabled never fails over — every login under that org is refused', () => {
  // Trying the second account here is not a failover, it is a second identical
  // failure, and `claude login` cannot fix either one. Go straight to the alert
  // that tells Craig to re-enable Claude Code in his org settings.
  const plan = authFailoverPlan({
    profiles: ['default', 'account-b'], name: 'default',
    reason: 'org_disabled', authBroken: {}, now: NOW,
  });
  assert.equal(plan.next, null, 'a healthy-looking second account must NOT be tried');
  assert.equal(plan.announce, 'alert');
});

// ── authHold: the twin of usageHold, missing until 2026-08-19 ────────────────
//
// spawn-agent set `authHeld` from 2026-08-16 and nothing consumed it: the
// orchestrator marked auth-failed jobs FAILED (task lost), code-health recorded
// "review failed" and cooled the platform 20h unreviewed, the harvester wrote
// `distill_status='failed'` permanently. These pin the gate's shape to
// usageHold's so the two can never drift.
import { authHold } from '../src/lib/claude-auth.js';

test('authHold: no profiles is not a hold', () => {
  assert.equal(authHold({ profiles: [], now: T, state: {} }).held, false);
});

test('authHold: one login not marked broken means work continues', () => {
  const state = { default: T + 600_000 };
  assert.equal(authHold({ profiles: ['default', 'second'], now: T, state }).held, false);
});

test('authHold: an expired auth cooldown counts as usable (a login may have landed)', () => {
  const state = { default: T - 1, second: T + 600_000 };
  assert.equal(authHold({ profiles: ['default', 'second'], now: T, state }).held, false);
});

test('THE 2026-08-19 CASE: every login seen failing → held until the EARLIEST cooldown expiry', () => {
  const state = { default: T + 900_000, 'account-b': T + 300_000 };
  const h = authHold({ profiles: ['default', 'account-b'], now: T, state });
  assert.equal(h.held, true);
  assert.equal(h.until, T + 300_000);
  assert.equal(h.at, new Date(T + 300_000).toISOString());
});

test('authHold: a single-profile box holds on that one login', () => {
  assert.equal(authHold({ profiles: ['default'], now: T, state: { default: T + 1 } }).held, true);
});

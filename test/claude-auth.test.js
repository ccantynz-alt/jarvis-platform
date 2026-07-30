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

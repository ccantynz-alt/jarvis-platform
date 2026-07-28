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

test('unrelated failures stay other', () => {
  assert.equal(classifyFailure({ message: 'ECONNRESET socket hang up' }).kind, 'other');
  assert.equal(classifyFailure({}).kind, 'other');
});

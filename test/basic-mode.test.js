/**
 * Basic mode must be SAFE, not just dumb (2026-08-19).
 *
 * The keyword pipeline only runs when the reasoning brain is unavailable. Its
 * `passthrough` default staged a DISPATCH of whatever was said. From the KV
 * transcript during the 2026-08-16..19 auth outage:
 *
 *   user:      love you what
 *   assistant: [via basic pipeline …] Ready to dispatch to auto: love you what. Shall I proceed, sir?
 *   user:      I just got a message from you saying okay baby have a safe flight
 *   assistant: [via basic pipeline …] Ready to dispatch to auto: I just got a message from …
 *
 * Household speech, one "yes" away from a full-permission root agent. These
 * pin the rule: in basic mode, free speech stages NOTHING; a dispatch still
 * needs an action verb.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runIntent, detectIntent, handleBasicMode } from '../src/lib/conversation.js';

const freshGate = () => ({ turn: 1, pending: null, launched: null });

test('THE INCIDENT: "love you what" stages no dispatch and says basic mode', async () => {
  const gate = freshGate();
  const intent = detectIntent('love you what');
  assert.equal(intent.type, 'passthrough');
  const r = await runIntent(intent, 'love you what', () => {}, gate);
  assert.equal(gate.pending, null, 'nothing may be staged from free speech');
  assert.equal(r.basicMode, true);
  assert.match(r.speech, /basic mode/i);
  assert.doesNotMatch(r.speech, /Ready to dispatch/i);
});

test('THE INCIDENT: the "safe flight" line stages nothing either', async () => {
  const gate = freshGate();
  const text = 'I just got a message from you saying okay baby have a safe flight';
  const intent = detectIntent(text);
  assert.equal(intent.type, 'passthrough');
  await runIntent(intent, text, () => {}, gate);
  assert.equal(gate.pending, null);
});

test('an explicit action verb still previews a dispatch (basic mode is not deaf)', async () => {
  const gate = freshGate();
  const intent = detectIntent('fix the zoobicon dashboard');
  assert.equal(intent.type, 'dispatch');
  const r = await runIntent(intent, 'fix the zoobicon dashboard', () => {}, gate);
  assert.ok(gate.pending, 'a verbed request is staged for confirmation as before');
  assert.match(r.speech, /Ready to dispatch/);
});

test('handleBasicMode quotes what it heard, bounded, and never stages', () => {
  const long = 'x'.repeat(500);
  const r = handleBasicMode(long);
  assert.ok(r.speech.length < 400);
  assert.equal(r.basicMode, true);
  const empty = handleBasicMode('');
  assert.doesNotMatch(empty.speech, /didn't catch a command in/);
});

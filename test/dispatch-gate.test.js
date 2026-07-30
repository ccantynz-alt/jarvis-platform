// test/dispatch-gate.test.js — the confirmation gate, 2026-07-30.
//
// The incident these tests exist for: Craig staged a repair on the deck, was
// asked to confirm, answered "please" — and nothing launched. The old
// AFFIRM_RE knew "please do" but not "please", so the gate treated his
// confirmation as an unrelated command, silently deleted the staged job, and
// handed the text to the brain, which re-staged the identical job and told him
// "I've passed your yes through, sir". Nothing had launched, and nothing said so.
//
// The gate is the only thing standing between "Craig said go" and a
// full-permission agent pushing to a production branch, so its vocabulary and
// its state machine are tested directly rather than through a live orchestrator.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGateReply, previewDispatch, resolveDispatchGate, gateNote } from '../src/lib/conversation.js';

const newGate = () => ({ turn: 0, pending: null });

// A gate with a job staged on turn 1, ready to be confirmed from turn 2 on.
function staged(task = 'fix the voice echo loop', platform = 'jarvis') {
  const gate = newGate();
  gate.turn = 1;
  previewDispatch(gate, platform, task);
  gate.turn = 2;
  return gate;
}

// handleDispatch POSTs to the orchestrator; stub it so nothing real is spawned.
function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve(fn()).finally(() => { globalThis.fetch = real; });
}
const okDispatch = () => Promise.resolve({ json: () => Promise.resolve({ jobId: 'abc12345-dead-beef' }) });

// ── The vocabulary ───────────────────────────────────────────────────────────

test('"please" is a yes — the reply that cost a morning', () => {
  assert.equal(classifyGateReply('please'), 'yes');
});

test('Craig confirms in his own words, out loud', () => {
  for (const yes of [
    'yes', 'Yes.', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'aye', 'go on',
    'go on then', 'do it', 'do it please', 'yes please', 'yes, launch it',
    'launch it', 'send it', 'ship it', 'run it', 'fire away', 'crack on',
    'proceed', 'confirmed', 'approved', 'permission granted', 'absolutely',
    'yes mate', 'go ahead', 'ok do it', 'right, do it', 'jarvis yes', 'hey jarvis, launch it',
    'yes please sir', 'thanks, go ahead',
  ]) {
    assert.equal(classifyGateReply(yes), 'yes', `expected yes for "${yes}"`);
  }
});

test('a no is a no, and any negation vetoes the launch', () => {
  for (const no of [
    'no', 'nope', 'nah', 'cancel', 'cancel that', 'stop', "don't", 'do not',
    'abort', 'negative', 'forget it', 'leave it', 'no thanks', 'never mind',
    'no not that one',
  ]) {
    assert.equal(classifyGateReply(no), 'no', `expected no for "${no}"`);
  }
});

test('"hold on" defers instead of destroying the staged job', () => {
  for (const wait of ['hold on', 'wait', 'wait a sec', 'not yet', 'one moment', 'hang on', 'later']) {
    assert.equal(classifyGateReply(wait), 'defer', `expected defer for "${wait}"`);
  }
});

test('a real instruction is never mistaken for a confirmation', () => {
  for (const cmd of [
    'run the audit on vapron', 'go check the fleet', 'what did site medic find',
    'do the bookaride build', 'send me the briefing', 'launch a scan of gatetest',
    'how are we doing', 'why is universal ai operator flagged',
    'yes but check the logs first', 'ok what about the inbox',
    '', '   ',
  ]) {
    assert.notEqual(classifyGateReply(cmd), 'yes', `"${cmd}" must not read as a confirmation`);
  }
});

// ── The state machine ────────────────────────────────────────────────────────

test('a yes in a LATER turn launches, and records the launch for the brain', async () => {
  const gate = staged();
  const res = await withFetch(okDispatch, () => resolveDispatchGate(gate, 'please'));
  assert.equal(res.handled, true);
  assert.match(res.text, /Job started/);
  assert.equal(gate.pending, null);
  assert.equal(gate.launched.ok, true);
  assert.equal(gate.launched.platform, 'jarvis');
});

test('a yes in the SAME turn as the preview is refused — two turns, always', async () => {
  const gate = newGate();
  gate.turn = 1;
  previewDispatch(gate, 'jarvis', 'fix the voice echo loop');
  const res = await withFetch(() => { throw new Error('must not dispatch'); },
    () => resolveDispatchGate(gate, 'yes'));
  assert.equal(res.handled, false);
  assert.ok(gate.pending, 'the job stays staged, waiting for a later turn');
});

test('ordinary conversation no longer deletes the staged job — THE regression', async () => {
  const gate = staged();
  const res = await resolveDispatchGate(gate, 'what did the CFO agent say this morning');
  assert.equal(res.handled, false, 'a fresh command goes to the brain');
  assert.ok(gate.pending, 'and the staged job survives it');

  gate.turn = 3;
  const yes = await withFetch(okDispatch, () => resolveDispatchGate(gate, 'ok'));
  assert.equal(yes.handled, true, 'so he can still confirm it a turn later');
});

test('a staged job lapses after a few turns and says so instead of vanishing', async () => {
  const gate = staged();
  for (let t = 2; t <= 6; t++) {
    gate.turn = t;
    await resolveDispatchGate(gate, 'tell me about the roadmap');
  }
  assert.equal(gate.pending, null, 'it does not wait forever');
  assert.equal(gate.lapsed.reason, 'expired');
  assert.match(gateNote(gate), /lapsed/);
});

test('declining drops it and leaves a note', async () => {
  const gate = staged();
  const res = await resolveDispatchGate(gate, 'no, leave it');
  assert.equal(res.handled, true);
  assert.match(res.text, /leave jarvis be/);
  assert.equal(gate.pending, null);
  assert.match(gateNote(gate), /declined/);
});

test('deferring holds the job and extends its life', async () => {
  const gate = staged();
  const res = await resolveDispatchGate(gate, 'hold on');
  assert.equal(res.handled, true);
  assert.match(res.text, /still staged/);
  assert.ok(gate.pending);
  assert.ok(gate.pending.expiresTurn > 2);
});

test('re-staging the same job does not push the confirmation turn forward', async () => {
  const gate = staged();
  // The brain re-calls dispatch_job whenever it thinks a yes went missing.
  // Re-stamping the turn was what made every "yes" permanently one turn early.
  const again = previewDispatch(gate, 'jarvis', 'fix the voice echo loop');
  assert.equal(again.alreadyStaged, true);
  assert.equal(gate.pending.turn, 1, 'still stamped with the ORIGINAL turn');

  const res = await withFetch(okDispatch, () => resolveDispatchGate(gate, 'yes'));
  assert.equal(res.handled, true);
});

test('a different job supersedes the staged one', () => {
  const gate = staged();
  previewDispatch(gate, 'vapron', 'restart the ops agent');
  assert.equal(gate.pending.platform, 'vapron');
  assert.equal(gate.pending.turn, 2, 'and starts its own two-turn clock');
});

test('an orchestrator refusal is reported, not dressed up as a launch', async () => {
  const gate = staged();
  const refuse = () => Promise.resolve({ json: () => Promise.resolve({ error: 'unknown platform' }) });
  const res = await withFetch(refuse, () => resolveDispatchGate(gate, 'yes'));
  assert.equal(res.handled, true);
  assert.match(res.text, /Dispatch failed/);
  assert.equal(gate.launched.ok, false);
  assert.match(gateNote(gate), /refused/);
});

// ── What the brain is told ───────────────────────────────────────────────────

test('gateNote tells the brain a job is still waiting, and is one-shot for events', async () => {
  const gate = staged();
  assert.match(gateNote(gate), /STILL STAGED/);

  await withFetch(okDispatch, () => resolveDispatchGate(gate, 'please'));
  const first = gateNote(gate);
  assert.match(first, /NOW RUNNING/);
  assert.equal(gateNote(gate), '', 'a launch is announced once, not every turn');
});

test('gateNote is silent with no gate and no pending', () => {
  assert.equal(gateNote(null), '');
  assert.equal(gateNote(newGate()), '');
});

// ── The overcorrection, found the same day (2026-07-30) ──────────────────────
// Widening the vocabulary this morning fixed "please" never firing and created
// the opposite hole: action verbs counted as standalone affirmations, and
// first-person pronouns and modals were treated as filler. So with a job staged
// in an earlier turn, the gate said YES to ordinary speech —
//
//   "i need to run"     "let me go"        "i can do that"
//   "you can send it"   "we need to go"    "i will run that"
//
// — every one of which would have launched a full-permission production agent.
// Found by the code-health spine, on code I had written hours earlier.
//
// The discriminator is grammatical: a confirmation is an IMPERATIVE. A sentence
// about what the speaker needs, can or will do is not one.

test('a sentence about the speaker is never a confirmation', () => {
  for (const s of [
    'i need to run', 'let me go', 'i can do that', 'you can send it', 'we need to go',
    'i will run that', 'i have to go', 'can you run that', 'i should go', 'we can ship it',
  ]) {
    assert.notEqual(classifyGateReply(s), 'yes', `"${s}" must not launch a production agent`);
  }
});

test('an action verb needs an object, or must be the whole reply', () => {
  // With an object, or alone: an imperative.
  for (const s of ['do it', 'go ahead', 'launch it', 'send it', 'ship it', 'run it', 'fire away', 'crack on', 'go']) {
    assert.equal(classifyGateReply(s), 'yes', `"${s}" is a confirmation`);
  }
  // Buried in a longer clause with no object: describing, not authorising.
  for (const s of ['just about to run', 'time to go now']) {
    assert.notEqual(classifyGateReply(s), 'yes', `"${s}" is not a confirmation`);
  }
});

test('explicit approvals still stand alone', () => {
  for (const s of ['yes', 'please', 'ok', 'sure', 'proceed', 'confirmed', 'approved', 'permission granted', 'absolutely']) {
    assert.equal(classifyGateReply(s), 'yes', s);
  }
});

// Model routing (2026-08-19, audit move 17). Cheap structured jobs on Haiku,
// role agents and the code finder on Sonnet, repairs on Opus, escalation on Fable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelFor, MODEL_IDS } from '../src/lib/model-routing.js';

test('cheap structured jobs route to Haiku', () => {
  for (const p of ['verify', 'recheck', 'distill', 'situation', 'review_verdict', 'canary']) {
    assert.equal(modelFor(p), MODEL_IDS.cheap, p);
  }
});

test('role agents and the code finder route to the standard tier', () => {
  assert.equal(modelFor('role'), MODEL_IDS.standard);
  assert.equal(modelFor('code_review'), MODEL_IDS.standard);
});

test('repairs route to the heavy everyday tier (Opus), not the escalation tier (Fable)', () => {
  assert.equal(modelFor('repair'), MODEL_IDS.heavy);
  assert.equal(modelFor('build'), MODEL_IDS.heavy);
  assert.notEqual(modelFor('repair'), MODEL_IDS.escalation);
});

test('an unknown purpose resolves to heavy, never the cheapest', () => {
  assert.equal(modelFor('something-new'), MODEL_IDS.heavy);
  assert.notEqual(modelFor('something-new'), MODEL_IDS.cheap);
});

test('the four tiers are distinct pinned ids', () => {
  const ids = new Set(Object.values(MODEL_IDS));
  assert.equal(ids.size, 4);
  for (const id of ids) assert.match(id, /^claude-/);
});

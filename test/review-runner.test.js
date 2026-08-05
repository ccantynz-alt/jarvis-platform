// test/review-runner.test.js — reading an officer's verdict.
//
// The parse is the whole trust boundary between a reviewing agent and a state
// change on a production proposal. Everything unreadable must resolve to
// ESCALATE: a verdict we could not parse is not consent, and the difference
// between a control and a rubber stamp is exactly this function's default.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../src/review-runner.js';

test('the three verdicts parse, with their reasoning', () => {
  assert.deepEqual(parseVerdict('VERDICT: approve — diff matches the rationale'),
    { verdict: 'approve', reason: 'diff matches the rationale' });
  assert.equal(parseVerdict('VERDICT: reject — touches 9 unrelated files').verdict, 'reject');
  assert.equal(parseVerdict('VERDICT: escalate — moves money').verdict, 'escalate');
});

test('case and separator variation is tolerated', () => {
  for (const s of [
    'verdict: APPROVE - scoped and tested',
    'VERDICT:approve: scoped',
    'VERDICT: Approve — scoped',
  ]) assert.equal(parseVerdict(s).verdict, 'approve', s);
});

test('a verdict at the end of a chatty reply is still found', () => {
  const chatty = 'I read the diff at src/lib/pr-merge.ts.\nIt is scoped.\n\nVERDICT: approve — one function, one test';
  const r = parseVerdict(chatty);
  assert.equal(r.verdict, 'approve');
  assert.match(r.reason, /one function/);
});

test('THE DEFAULT THAT MATTERS: anything unparseable escalates, never approves', () => {
  for (const s of [
    '', null, undefined, 'I think this is fine',
    'The change looks good to me.',
    'APPROVED',                       // not the required form
    'VERDICT: maybe — unsure',        // not one of the three
    '{"verdict":"approve"}',          // right idea, wrong contract
  ]) {
    const r = parseVerdict(s);
    assert.equal(r.verdict, 'escalate', JSON.stringify(s));
  }
});

test('an unparseable verdict says WHY, so the escalation is not mysterious', () => {
  assert.match(parseVerdict('nonsense').reason, /no parseable verdict/);
});

test('a verdict with no reasoning still parses, and says so', () => {
  const r = parseVerdict('VERDICT: reject');
  assert.equal(r.verdict, 'reject');
  assert.equal(r.reason, 'no reasoning given');
});

test('reasoning is bounded — a runaway reviewer cannot write an essay into the trail', () => {
  const r = parseVerdict('VERDICT: approve — ' + 'x'.repeat(2000));
  assert.ok(r.reason.length <= 400);
});

test('the word approve appearing in prose does not become an approval', () => {
  // The reviewer discussing approval is not the reviewer approving.
  const r = parseVerdict('I would not approve this. It touches unrelated files.');
  assert.equal(r.verdict, 'escalate');
});

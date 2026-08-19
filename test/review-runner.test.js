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

// ── The review-runner re-decided the same three proposals forever ───────────
// 2026-08-07 finding. memory-server returns proposals id DESC and dry-run
// transitions nothing, so `rows.slice(0, MAX_PER_TICK)` took the same newest
// three every 20 minutes. The journal caught it: ticks at 19:04, 19:25 and
// 19:46 each reviewed #11, #10, #9 with equivalent verdicts while #4-#8 were
// never reviewed at all — ~216 subscription turns a day, re-deciding three
// proposals. `withArtifact` was computed for the log line and never used.

import { pickForReview } from '../src/review-runner.js';

const P = (id, artifact = true) => ({ id, artifact_url: artifact ? `http://a/${id}` : null });
// As memory-server returns them: newest first.
const QUEUE = [P(11), P(10), P(9), P(8), P(7), P(6), P(5), P(4)];

test('the first tick takes the OLDEST proposals, not the newest', () => {
  assert.deepEqual(pickForReview(QUEUE, { cursor: 0, max: 3 }).map(p => p.id), [4, 5, 6]);
});

test('the next tick advances instead of re-reviewing the same three', () => {
  const first = pickForReview(QUEUE, { cursor: 0, max: 3 });
  const cursor = first[first.length - 1].id;
  assert.deepEqual(pickForReview(QUEUE, { cursor, max: 3 }).map(p => p.id), [7, 8, 9]);
});

test('the queue wraps once the tail is reached rather than stalling empty', () => {
  assert.deepEqual(pickForReview(QUEUE, { cursor: 11, max: 3 }).map(p => p.id), [4, 5, 6]);
});

test('a full pass reaches every proposal — none is starved', () => {
  const seen = new Set();
  let cursor = 0;
  for (let tick = 0; tick < 3; tick++) {
    const batch = pickForReview(QUEUE, { cursor, max: 3 });
    batch.forEach(p => seen.add(p.id));
    cursor = batch[batch.length - 1].id;
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [4, 5, 6, 7, 8, 9, 10, 11]);
});

test('proposals with no artifact are skipped — an agent that hit a STOP CONDITION leaves one forever', () => {
  const q = [P(9), P(8, false), P(7)];
  assert.deepEqual(pickForReview(q, { cursor: 0, max: 3 }).map(p => p.id), [7, 9]);
});

test('no eligible proposals returns an empty batch rather than throwing', () => {
  assert.deepEqual(pickForReview([], { cursor: 0, max: 3 }), []);
  assert.deepEqual(pickForReview([P(1, false)], { cursor: 0, max: 3 }), []);
});

test('a batch never contains the same proposal twice', () => {
  // The wrap concatenates two slices; if they overlapped, a tick would spend
  // two subscription turns on one proposal.
  const batch = pickForReview(QUEUE, { cursor: 7, max: 8 });
  assert.equal(new Set(batch.map(p => p.id)).size, batch.length);
  assert.equal(batch.length, 8);
});

// ── needsReview: dry-run decides each artifact ONCE (2026-08-19) ─────────────
//
// pickForReview's rotation still wrapped around the same `proposed` rows forever
// in dry-run (nothing transitions), so 16 proposals cost up to 216 ten-minute
// subscription turns a day restating verdicts. A durable verdict keyed to the
// artifact it judged ends that; a moved artifact is reviewed again.
import { needsReview } from '../src/review-runner.js';

test('needsReview: no artifact → nothing to review (the agent must attach one first)', () => {
  assert.equal(needsReview({ id: 1, artifact_url: '' }, null), false);
  assert.equal(needsReview({ id: 1 }, { artifact: 'x', verdict: 'approve' }), false);
});

test('needsReview: never reviewed → review', () => {
  assert.equal(needsReview({ id: 1, artifact_url: 'jarvis/fix-1@abc' }, null), true);
});

test('THE BURN: same artifact already judged → do NOT spend another turn', () => {
  assert.equal(needsReview({ id: 1, artifact_url: 'jarvis/fix-1@abc' }, { artifact: 'jarvis/fix-1@abc', verdict: 'reject' }), false);
});

test('needsReview: the artifact moved → review again', () => {
  assert.equal(needsReview({ id: 1, artifact_url: 'jarvis/fix-1@def' }, { artifact: 'jarvis/fix-1@abc', verdict: 'reject' }), true);
});

test('needsReview: a corrupt prior (no artifact recorded) is treated as stale, not trusted', () => {
  assert.equal(needsReview({ id: 1, artifact_url: 'jarvis/fix-1@abc' }, { verdict: 'approve' }), true);
});

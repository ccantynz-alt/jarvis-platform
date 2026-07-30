// test/findings.test.js — the code-health spine's decision-making, 2026-07-30.
//
// This is the part that must be right before any of it is trusted: what counts
// as a finding, what is the SAME finding as yesterday, which findings are worth
// spending an adversarial verifier on, and what gets looked at next. Every one of
// those is a pure function precisely so it can be tested without spending a
// subscription turn on a review agent.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprint, normalizeFinding, parseFindings, needsVerification,
  pickTarget, lensFor, severityRank, LENSES,
} from '../src/lib/findings.js';

// ── Identity: the thing that stops a nightly sweep becoming a firehose ───────

test('the same defect fingerprints the same, whatever the wording', () => {
  const a = fingerprint('vapron', 'src/worker.js', 'Unbounded retry loop in the worker');
  const b = fingerprint('vapron', 'src/worker.js', 'The worker retry loop is unbounded');
  assert.equal(a, b, 'two agents never phrase a defect identically — the key must not care');
});

test('different files, platforms, or defects fingerprint differently', () => {
  const base = fingerprint('vapron', 'src/worker.js', 'Unbounded retry loop in the worker');
  assert.notEqual(base, fingerprint('vapron', 'src/queue.js', 'Unbounded retry loop in the worker'));
  assert.notEqual(base, fingerprint('zoobicon', 'src/worker.js', 'Unbounded retry loop in the worker'));
  assert.notEqual(base, fingerprint('vapron', 'src/worker.js', 'Missing timeout on the upstream fetch'));
});

test('path spelling differences do not split one finding in two', () => {
  assert.equal(
    fingerprint('jarvis', './src/lib/push.js', 'Header injection via alert title'),
    fingerprint('jarvis', 'src\\lib\\push.js', 'Header injection via alert title'),
  );
});

test('a missing file path still yields a stable key', () => {
  const a = fingerprint('jarvis', null, 'Secrets written to the build log');
  assert.equal(a, fingerprint('jarvis', undefined, 'Secrets written to the build log'));
  assert.match(a, /^[0-9a-f]{16}$/);
});

// ── Normalisation: model output is untrusted input ───────────────────────────

test('a well-formed finding is kept, with its fingerprint attached', () => {
  const f = normalizeFinding({
    title: 'Retry loop has no upper bound',
    severity: 'high', kind: 'reliability',
    file: 'src/worker.js', line: '42',
    evidence: 'sendJob() recurses on failure with no attempt counter',
    suggested_fix: 'cap attempts and back off',
  }, { platform: 'vapron', lens: 'failure-paths', jobId: 'job-1' });

  assert.equal(f.platform, 'vapron');
  assert.equal(f.severity, 'high');
  assert.equal(f.line, 42, 'a numeric string is still a line number');
  assert.equal(f.lens, 'failure-paths');
  assert.equal(f.job_id, 'job-1');
  assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
});

test('junk is rejected rather than filed', () => {
  for (const bad of [null, undefined, 'a string', 42, {}, { title: 'too short' }, { title: '   ' }]) {
    assert.equal(normalizeFinding(bad, { platform: 'jarvis' }), null, JSON.stringify(bad));
  }
  assert.equal(normalizeFinding({ title: 'A perfectly good title here' }, {}), null,
    'without a platform there is nowhere to file it');
});

test('unknown severities and kinds fall back instead of reaching the database', () => {
  const f = normalizeFinding({ title: 'Something is wrong here', severity: 'catastrophic', kind: 'vibes' },
    { platform: 'jarvis' });
  assert.equal(f.severity, 'medium');
  assert.equal(f.kind, 'correctness');
});

test('every field is size-capped at the boundary', () => {
  const f = normalizeFinding({
    title: 'x'.repeat(500), evidence: 'y'.repeat(5000), suggested_fix: 'z'.repeat(5000),
    file: 'f'.repeat(900), line: -3,
  }, { platform: 'jarvis' });
  assert.equal(f.title.length, 160);
  assert.equal(f.evidence.length, 1200);
  assert.equal(f.suggested_fix.length, 800);
  assert.equal(f.file_path.length, 300);
  assert.equal(f.line, null, 'a negative line number is not a line number');
});

test('the alternative field names models actually emit are accepted', () => {
  const f = normalizeFinding({ title: 'Unvalidated redirect target', why: 'because', fix: 'validate it', file_path: 'a.js' },
    { platform: 'jarvis' });
  assert.equal(f.evidence, 'because');
  assert.equal(f.suggested_fix, 'validate it');
  assert.equal(f.file_path, 'a.js');
});

// ── Parsing whatever the agent actually printed ──────────────────────────────

test('a bare JSON array parses', () => {
  assert.equal(parseFindings('[{"title":"a"},{"title":"b"}]').findings.length, 2);
});

test('a fenced block parses', () => {
  const out = parseFindings('Here you go:\n```json\n[{"title":"a"}]\n```\nHope that helps.');
  assert.equal(out.findings.length, 1);
});

test('prose either side of an array parses', () => {
  assert.equal(parseFindings('I reviewed it. [{"title":"a"}] Done.').findings.length, 1);
});

test('an object wrapper parses', () => {
  assert.equal(parseFindings('{"findings":[{"title":"a"}]}').findings.length, 1);
});

test('a clean review — an empty array — is not an error', () => {
  const out = parseFindings('[]');
  assert.deepEqual(out.findings, []);
  assert.equal(out.error, undefined, 'finding nothing must not look like a failure');
});

test('unparseable output reports a reason instead of throwing', () => {
  const out = parseFindings('I could not complete the review.');
  assert.deepEqual(out.findings, []);
  assert.match(out.error, /no JSON/);
});

// ── Where the verification budget goes ──────────────────────────────────────

test('verification is spent where a false positive would cost something', () => {
  assert.equal(needsVerification({ severity: 'critical', kind: 'correctness' }), true);
  assert.equal(needsVerification({ severity: 'high', kind: 'performance' }), true);
  // A model under-rating a data-loss or security bug is exactly the case we
  // cannot afford to skip, whatever severity it claimed.
  assert.equal(needsVerification({ severity: 'low', kind: 'data-loss' }), true);
  assert.equal(needsVerification({ severity: 'medium', kind: 'security' }), true);
  assert.equal(needsVerification({ severity: 'medium', kind: 'maintainability' }), false);
  assert.equal(needsVerification(null), false);
});

test('severity sorts worst-first', () => {
  const order = ['low', 'critical', 'medium', 'high'].sort((a, b) => severityRank(a) - severityRank(b));
  assert.deepEqual(order, ['critical', 'high', 'medium', 'low']);
  assert.ok(severityRank('nonsense') >= severityRank('low'), 'an unknown severity sorts last, not first');
});

// ── What gets looked at next ────────────────────────────────────────────────

test('the least-recently-swept platform goes next, and never-swept goes first', () => {
  const now = 1_000_000_000;
  const t = pickTarget(['a', 'b', 'c'], { a: { lastSweep: now - 1000 }, b: { lastSweep: now - 5000 } }, { now });
  assert.equal(t.platform, 'c', 'a platform nobody has ever reviewed is the most urgent');

  const t2 = pickTarget(['a', 'b'], { a: { lastSweep: now - 1000 }, b: { lastSweep: now - 5000 } }, { now });
  assert.equal(t2.platform, 'b');
});

test('a platform inside its cooldown is skipped, and all-in-cooldown yields nothing', () => {
  const now = 1_000_000_000;
  const state = { a: { lastSweep: now - 1000 }, b: { lastSweep: now - 2000 } };
  assert.equal(pickTarget(['a', 'b'], state, { now, cooldownMs: 60_000 }), null);
  assert.equal(pickTarget(['a', 'b'], state, { now, cooldownMs: 1500 }).platform, 'b');
});

test('the lens rotates so depth accumulates instead of repeating', () => {
  const now = 1_000_000_000;
  const first = pickTarget(['a'], { a: { lastSweep: 0, lensIndex: 0 } }, { now });
  const later = pickTarget(['a'], { a: { lastSweep: 0, lensIndex: 1 } }, { now });
  assert.notEqual(first.lens.key, later.lens.key);
  assert.equal(lensFor(LENSES.length).key, LENSES[0].key, 'the rotation wraps');
  assert.equal(lensFor(-3).key, LENSES[3 % LENSES.length].key, 'a negative index does not crash');
  assert.equal(lensFor(NaN).key, LENSES[0].key);
});

test('every lens has a usable brief', () => {
  for (const l of LENSES) {
    assert.ok(l.key && /^[a-z-]+$/.test(l.key), l.key);
    assert.ok(l.brief.length > 40, `${l.key} needs a brief specific enough to steer a review`);
  }
});

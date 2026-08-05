// test/audit-noise.test.js — an unchanged audit stops shouting, 2026-08-05.
//
// vapron (50/100) and screenshot-to-code (47/100) can never be auto-fixed by
// design, so they produced a byte-identical `critical` audit every day since
// 30 July — each one a `critical` Slack post (bypasses quiet hours and mute)
// plus a `warn` notify() (buzzes his phone via ntfy). NotifyCenter's 30-minute
// per-key dedupe cannot see a 24-hour repeat.
//
// Both directions matter and both are tested here: a repeat must go quiet, and
// a CHANGE must stay loud even when the platform was already critical.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOUNCE_REPEATS,
  auditFingerprint,
  nextRepeat,
  isStaleRepeat,
  auditSlackLevel,
  auditNotifyLevel,
  repeatSuffix,
} from '../src/lib/audit-noise.js';

// The real vapron report, from /opt/jarvis/reports on the box.
const vapron = {
  status: 'critical',
  health_score: 50,
  errors: ['HTTP: https://vapron.ai — status 000'],
};

// ── fingerprint ─────────────────────────────────────────────────────────────

test('identical reports fingerprint identically', () => {
  assert.equal(auditFingerprint(vapron), auditFingerprint({ ...vapron }));
});

test('error ORDER is not a change — the checks emit in run order', () => {
  const a = { status: 'critical', health_score: 20, errors: ['HTTP: a', 'SCREENSHOT: b'] };
  const b = { status: 'critical', health_score: 20, errors: ['SCREENSHOT: b', 'HTTP: a'] };
  assert.equal(auditFingerprint(a), auditFingerprint(b));
});

test('a NEW error changes the fingerprint even at the same score and status', () => {
  const worse = { ...vapron, errors: [...vapron.errors, 'SCREENSHOT: https://vapron.ai — capture failed'] };
  assert.notEqual(auditFingerprint(vapron), auditFingerprint(worse));
});

test('a score change changes the fingerprint', () => {
  assert.notEqual(auditFingerprint(vapron), auditFingerprint({ ...vapron, health_score: 30 }));
});

test('a status change changes the fingerprint', () => {
  assert.notEqual(auditFingerprint(vapron), auditFingerprint({ ...vapron, status: 'warning' }));
});

test('errors sharing a prefix do not collide', () => {
  const a = { status: 'critical', health_score: 0, errors: ['HTTP: https://x.ai — status 500'] };
  const b = { status: 'critical', health_score: 0, errors: ['HTTP: https://x.ai — status 502'] };
  assert.notEqual(auditFingerprint(a), auditFingerprint(b));
});

test('a missing errors array does not throw', () => {
  assert.equal(typeof auditFingerprint({ status: 'healthy', health_score: 100 }), 'string');
  assert.equal(typeof auditFingerprint(), 'string');
});

// ── repeat counting ─────────────────────────────────────────────────────────

test('first sighting counts as 1', () => {
  assert.equal(nextRepeat(null, null, 'fp'), 1);
});

test('a row written before the column existed counts as 1, not as a repeat', () => {
  assert.equal(nextRepeat(undefined, undefined, 'fp'), 1);
  assert.equal(nextRepeat('', 0, 'fp'), 1);
});

test('the same fingerprint accumulates', () => {
  assert.equal(nextRepeat('fp', 1, 'fp'), 2);
  assert.equal(nextRepeat('fp', 6, 'fp'), 7);
});

test('a different fingerprint resets to 1', () => {
  assert.equal(nextRepeat('fp', 9, 'other'), 1);
});

test('a corrupt stored count restarts rather than propagating NaN', () => {
  assert.equal(nextRepeat('fp', 'not a number', 'fp'), 1);
  assert.equal(nextRepeat('fp', -3, 'fp'), 1);
});

// ── staleness ───────────────────────────────────────────────────────────────

test(`the first ${ANNOUNCE_REPEATS} sightings are not stale`, () => {
  for (let i = 1; i <= ANNOUNCE_REPEATS; i++) assert.equal(isStaleRepeat(i), false, `repeat ${i}`);
  assert.equal(isStaleRepeat(ANNOUNCE_REPEATS + 1), true);
});

test('an unusable repeat value announces rather than suppresses', () => {
  // Suppression is the dangerous default; being noisy is merely annoying.
  assert.equal(isStaleRepeat(undefined), false);
  assert.equal(isStaleRepeat(null), false);
  assert.equal(isStaleRepeat(NaN), false);
  assert.equal(isStaleRepeat('lots'), false);
});

// ── Slack level ─────────────────────────────────────────────────────────────

test('a fresh critical still posts as critical', () => {
  assert.equal(auditSlackLevel('critical', 1), 'critical');
  assert.equal(auditSlackLevel('critical', ANNOUNCE_REPEATS), 'critical');
});

test('THE BUG: vapron on day 3 folds into the digest instead of posting critical', () => {
  assert.equal(auditSlackLevel('critical', 3), 'info');
  assert.equal(auditSlackLevel('critical', 30), 'info');
});

test('a repeating warning also goes quiet', () => {
  assert.equal(auditSlackLevel('warning', 1), 'warning');
  assert.equal(auditSlackLevel('warning', 5), 'info');
});

test('healthy was always digest-only and still is', () => {
  assert.equal(auditSlackLevel('healthy', 1), 'info');
  assert.equal(auditSlackLevel('healthy', 99), 'info');
});

test('a platform breaking in a NEW way is loud again on the very next run', () => {
  // Day 30 of an unchanged critical: quiet.
  const stale = nextRepeat('fp-old', 29, 'fp-old');
  assert.equal(auditSlackLevel('critical', stale), 'info');
  // Same day, a new error appears → fingerprint changes → repeat resets → loud.
  const changed = nextRepeat('fp-old', 29, 'fp-new');
  assert.equal(changed, 1);
  assert.equal(auditSlackLevel('critical', changed), 'critical');
});

// ── notify() level (the channel that reaches his phone) ─────────────────────

test('a fresh audit notify keeps its intended level', () => {
  assert.equal(auditNotifyLevel('warn', 1), 'warn');
  assert.equal(auditNotifyLevel('alert', 2), 'alert');
});

test('a stale repeat drops below PUSH_MIN_LEVEL so nothing buzzes', () => {
  assert.equal(auditNotifyLevel('warn', 3), 'info');
  assert.equal(auditNotifyLevel('alert', 3), 'info');
});

test('the escalation alert also stops repeating forever', () => {
  // The AUTO_FIX_MAX_ATTEMPTS branch raised level 'alert', which lib/push.js
  // exempts from BOTH dedupe and the hourly cap — the loudest repeat of all.
  assert.equal(auditNotifyLevel('alert', 10), 'info');
});

// ── the demoted entry still explains itself ─────────────────────────────────

test('a stale repeat is labelled so the inbox entry is not mysterious', () => {
  assert.equal(repeatSuffix(1), '');
  assert.equal(repeatSuffix(ANNOUNCE_REPEATS), '');
  assert.match(repeatSuffix(4), /unchanged, day 4/);
});

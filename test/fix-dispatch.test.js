// test/fix-dispatch.test.js — what a full-permission agent may repair unattended.
//
// 2026-08-05: code-health went from "fixes nothing, ever" to auto-dispatching
// repairs. Every gate here is the difference between a bug being fixed and an
// agent editing the wrong repo with no one watching, so both directions are
// tested: the eligible case must actually launch, and each refusal must hold.
//
// The fixtures are the real 2026-08-05 findings, because the distribution
// mattered — 9 of 25 criticals were in a repo with no .git, 4 were flagged
// duplicates, and 10 were never adversarially confirmed.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DENIED_PLATFORMS, fixEligibility, selectForDispatch, buildFixTask,
} from '../src/lib/fix-dispatch.js';

const PUSHABLE = new Set(['gluecron', 'gatetest', 'bookaride', 'voxlen']);
const ctx = { canPush: (p) => PUSHABLE.has(p) };

const f = (over = {}) => ({
  id: 188, platform: 'gluecron', severity: 'critical', status: 'confirmed',
  kind: 'security', title: 'Unauthenticated POST /api/setup creates accounts',
  file_path: 'src/routes/api.ts', line: 182, verdict: 'confirmed by verifier',
  evidence: 'api.post("/setup") sits behind no auth gate', fix_job_id: null,
  first_seen: '2026-08-01T00:00:00Z', commit_sha: 'ae2a071', ...over,
});

// ── the gauntlet ────────────────────────────────────────────────────────────

test('a confirmed critical in a pushable repo is eligible', () => {
  const r = fixEligibility(f(), ctx);
  assert.equal(r.eligible, true);
});

test('an UNVERIFIED finding is never auto-fixed', () => {
  // 10 of the 25 real criticals were 'open' — one agent's opinion, unrefuted.
  const r = fixEligibility(f({ status: 'open' }), ctx);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /adversarially confirmed/);
});

test('a dismissed finding stays dismissed', () => {
  assert.equal(fixEligibility(f({ status: 'dismissed' }), ctx).eligible, false);
});

test('THE 9-OF-25 CASE: no checkout with a remote means nowhere to push', () => {
  const r = fixEligibility(f({ platform: 'universal-ai-operator' }), ctx);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /nowhere to push/);
});

test('a likely-duplicate is left for a human to reconcile', () => {
  const r = fixEligibility(f({ verdict: 'confirmed\n\nLIKELY DUPLICATE: #106 is already open' }), ctx);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /duplicate/);
});

test('a finding already being fixed is not dispatched twice', () => {
  const r = fixEligibility(f({ fix_job_id: 'job-abc' }), ctx);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /already dispatched/);
});

test('THE ZOOBICON CASE: a checkout behind its remote is not a safe base', () => {
  // The real Zoobicon checkout was 194 commits behind origin/main. An agent
  // there re-fixes bugs already fixed upstream and commits onto a base
  // guaranteed to conflict.
  const r = fixEligibility(f({ platform: 'zoobicon' }), {
    canPush: () => true, behindCount: () => 194,
  });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /194 commits behind/);
});

test('an up-to-date checkout passes the staleness gate', () => {
  assert.equal(fixEligibility(f(), { ...ctx, behindCount: () => 0 }).eligible, true);
});

test('an unknown behind-count does not silently block every fix', () => {
  // Default is 0: if we cannot measure it, fall back to the other gates rather
  // than disabling auto-fixing fleet-wide the first time git is unavailable.
  assert.equal(fixEligibility(f(), ctx).eligible, true);
});

test('THE DRY-RUN CATCH: status says confirmed, the verdict prose says otherwise', () => {
  // gluecron #31, real row, 2026-08-05: stored status 'confirmed', while its
  // verifier wrote "PARTIALLY re-verified and NOT confirmed at origin/main —
  // treat with care". It was picked by the first dry-run tick. When the enum
  // and the prose disagree, the prose wins.
  const r = fixEligibility(f({
    verdict: 'PARTIALLY re-verified and NOT confirmed at origin/main b4e86b2 — treat with care.',
  }), ctx);
  assert.equal(r.eligible, false);
  assert.match(r.reason, /hedged/);
});

test('every hedging phrase a verifier actually used is caught', () => {
  for (const v of [
    'verifier produced no usable verdict — left unproven',
    'could not verify the defect is real',
    'unable to confirm against current code',
    'may already be fixed upstream',
    'Verify against lib/pr-merge.ts at origin/main before acting on this one',
  ]) {
    assert.equal(fixEligibility(f({ verdict: v }), ctx).eligible, false, v);
  }
});

test('a plainly confirmed verdict is NOT caught by the caution filter', () => {
  // The filter must not swallow the ordinary case — that would silently
  // disable auto-fixing altogether, which is the worse failure.
  for (const v of [
    'confirmed by verifier',
    'Verified end to end with no mitigating guard',
    'RE-VERIFIED at origin/main d557bad, code identical, still line 372',
    'Confirmed: route.ts:71 fires the workflow in an unawaited async IIFE',
  ]) {
    assert.equal(fixEligibility(f({ verdict: v }), ctx).eligible, true, v);
  }
});

test('the three denied platforms are refused with their real reason', () => {
  for (const p of Object.keys(DENIED_PLATFORMS)) {
    const r = fixEligibility(f({ platform: p }), { canPush: () => true });
    assert.equal(r.eligible, false, p);
    assert.equal(r.reason, DENIED_PLATFORMS[p]);
  }
});

test('alecrae is refused even though it has a checkout and a remote', () => {
  // It does push — it is denied for being a LIVE co-tenant, not for plumbing.
  const r = fixEligibility(f({ platform: 'alecrae' }), { canPush: () => true });
  assert.equal(r.eligible, false);
  assert.match(r.reason, /co-tenant/);
});

test('severity floor holds, and an unknown severity is not treated as urgent', () => {
  assert.equal(fixEligibility(f({ severity: 'high' }), ctx).eligible, false);
  assert.equal(fixEligibility(f({ severity: 'high' }), { ...ctx, minSeverity: 'high' }).eligible, true);
  assert.equal(fixEligibility(f({ severity: 'spicy' }), { ...ctx, minSeverity: 'low' }).eligible, false);
});

test('a malformed row is refused rather than throwing', () => {
  assert.equal(fixEligibility(null, ctx).eligible, false);
  assert.equal(fixEligibility({}, ctx).eligible, false);
});

// ── selection ───────────────────────────────────────────────────────────────

const limits = { maxConcurrent: 2, attemptsToday: 0, maxPerDay: 6 };

test('one platform gets at most one agent per tick', () => {
  const rows = [f({ id: 1 }), f({ id: 2 }), f({ id: 3 })]; // all gluecron
  const { picked, skipped } = selectForDispatch(rows, ctx, limits);
  assert.equal(picked.length, 1);
  assert.match(skipped[0].reason, /another finding for this platform/);
});

test('a platform with a job already running is skipped entirely', () => {
  const rows = [f({ id: 1 }), f({ id: 2, platform: 'gatetest' })];
  const { picked } = selectForDispatch(rows, ctx, { ...limits, busy: new Set(['gluecron']) });
  assert.deepEqual(picked.map(p => p.platform), ['gatetest']);
});

test('worst-first, then longest-standing', () => {
  const rows = [
    f({ id: 1, platform: 'gatetest', severity: 'high', first_seen: '2026-07-01T00:00:00Z' }),
    f({ id: 2, platform: 'gluecron', severity: 'critical', first_seen: '2026-08-02T00:00:00Z' }),
    f({ id: 3, platform: 'bookaride', severity: 'critical', first_seen: '2026-07-15T00:00:00Z' }),
  ];
  const { picked } = selectForDispatch(rows, { ...ctx, minSeverity: 'high' }, { ...limits, maxConcurrent: 3 });
  assert.deepEqual(picked.map(p => p.id), [3, 2, 1]);
});

test('the concurrency cap bounds one tick', () => {
  const rows = [f({ id: 1 }), f({ id: 2, platform: 'gatetest' }), f({ id: 3, platform: 'bookaride' })];
  const { picked } = selectForDispatch(rows, ctx, { ...limits, maxConcurrent: 2 });
  assert.equal(picked.length, 2);
});

test('THE 117-DISPATCH LESSON: the daily cap actually bounds the day', () => {
  // 2026-07-17: self-heal made 117 dispatches against a cap of 6 because the
  // guardrail existed but did not bound anything.
  const rows = [f({ id: 1 }), f({ id: 2, platform: 'gatetest' }), f({ id: 3, platform: 'bookaride' })];
  const { picked, skipped } = selectForDispatch(rows, ctx, { ...limits, attemptsToday: 6, maxPerDay: 6 });
  assert.equal(picked.length, 0);
  assert.ok(skipped.every(s => /cap|budget/.test(s.reason)));
});

test('a partly-spent day dispatches only the remainder', () => {
  const rows = [f({ id: 1 }), f({ id: 2, platform: 'gatetest' }), f({ id: 3, platform: 'bookaride' })];
  const { picked } = selectForDispatch(rows, ctx, { maxConcurrent: 3, attemptsToday: 5, maxPerDay: 6 });
  assert.equal(picked.length, 1);
});

test('nothing eligible means nothing picked, and it does not throw', () => {
  assert.deepEqual(selectForDispatch([], ctx, limits).picked, []);
  assert.deepEqual(selectForDispatch(undefined, ctx, limits).picked, []);
});

// ── the prompt ──────────────────────────────────────────────────────────────

test('the task names one finding and forbids collateral work', () => {
  const t = buildFixTask(f());
  assert.match(t, /Fix ONE confirmed critical defect in gluecron/);
  assert.match(t, /src\/routes\/api\.ts:182/);
  assert.match(t, /No refactors/);
});

test('the task tells the agent to stop rather than invent a fix', () => {
  const t = buildFixTask(f());
  assert.match(t, /make NO change and say so plainly/);
  assert.match(t, /already fixed upstream and STOP/);  // the stale-checkout case
  assert.match(t, /ae2a071/);
});

test('a finding with no file or evidence still produces a usable task', () => {
  const t = buildFixTask({ id: 9, platform: 'gatetest', severity: 'critical', title: 'x', kind: 'security' });
  assert.match(t, /see evidence/);
  assert.match(t, /\(none recorded\)/);
});

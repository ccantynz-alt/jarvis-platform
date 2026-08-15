/**
 * Regression tests for deploy-gate's scan classification.
 *
 * THE INCIDENT (2026-08-15, found by a full-repo bug audit): `blocked` was a
 * bare `exitCode !== 0`, and deploy-gate forces exitCode = 1 on a scan timeout.
 * A scan that merely ran out of time therefore took the same branch as a scan
 * that found a critical defect — and that branch dispatches a full-permission
 * repair agent, as root, into the platform's own checkout, told to commit and
 * push. No proposal, no officer review, no branch restriction, no CAUTION_RE,
 * no denied-platform list; the path predates lib/fix-dispatch.js entirely.
 *
 * The trigger needs no defect, only slowness: fleet-check.sh records vapron.ai
 * returning 000 on 13% of probes from slowness alone, and alecrae — a live
 * co-tenant of this box that fix-dispatch.js denies by standing rule — is
 * reachable through this path.
 *
 * The invariant these tests pin: ONLY a completed scan that returned a non-zero
 * exit code may dispatch anything. Everything else is inconclusive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyScan } from '../src/lib/gate-outcome.js';

test('THE INCIDENT: a timed-out scan never dispatches', () => {
  const v = classifyScan({ timedOut: true, code: null });
  assert.equal(v.outcome, 'inconclusive');
  assert.equal(v.dispatchable, false, 'a slow site must not trigger a root agent');
  assert.equal(v.criticalCount, 0, 'no measurement means no invented count');
});

test('a timeout stays inconclusive even if the killed run left a report behind', () => {
  // A report written by a run that was killed mid-flight is partial by
  // definition. Trusting it is how a timeout becomes a "defect" all over again.
  const partial = { summary: { checks: { errors: 4 } } };
  const v = classifyScan({ timedOut: true, code: 1 }, partial);
  assert.equal(v.outcome, 'inconclusive');
  assert.equal(v.dispatchable, false);
  assert.equal(v.criticalCount, 0);
});

test('a process that never returned a numeric code is inconclusive, not blocked', () => {
  // Previously this fell through to `exitCode = 1` — i.e. straight to blocked,
  // and straight to a dispatch. Killed by a signal, or spawn failure.
  //
  // NaN is in this list deliberately. It is a `number`, and NaN !== 0, so the
  // original `typeof code === 'number'` guard classified it as BLOCKED and would
  // have dispatched a root agent. A NaN that does not gate is this box's oldest
  // lesson (the 117-dispatch day); this test caught it reaching the most
  // dangerous branch in the service.
  for (const code of [null, undefined, NaN, '0', 1.5]) {
    const v = classifyScan({ timedOut: false, code });
    assert.equal(v.outcome, 'inconclusive', `code=${code} must not dispatch`);
    assert.equal(v.dispatchable, false);
  }
});

test('a clean scan passes and dispatches nothing', () => {
  const v = classifyScan({ timedOut: false, code: 0 });
  assert.equal(v.outcome, 'passed');
  assert.equal(v.dispatchable, false);
  assert.equal(v.criticalCount, 0);
});

test('a completed scan with findings still blocks — the gate must keep working', () => {
  // The fix must not defang the gate: this is the case it exists for.
  const report = { summary: { checks: { errors: 3 } } };
  const v = classifyScan({ timedOut: false, code: 1 }, report);
  assert.equal(v.outcome, 'blocked');
  assert.equal(v.dispatchable, true);
  assert.equal(v.criticalCount, 3, 'the real count comes from the report');
});

test('a non-zero exit with no readable report still blocks, counting one', () => {
  const v = classifyScan({ timedOut: false, code: 2 }, null);
  assert.equal(v.outcome, 'blocked');
  assert.equal(v.dispatchable, true);
  assert.equal(v.criticalCount, 1);
});

test('only the blocked outcome is ever dispatchable', () => {
  // The invariant, stated once: if this ever fails, a non-finding can spawn a
  // root agent again.
  const cases = [
    [{ timedOut: true, code: 1 }, null],
    [{ timedOut: true, code: 0 }, { summary: { checks: { errors: 9 } } }],
    [{ timedOut: false, code: null }, null],
    [{ timedOut: false, code: 0 }, null],
    [{ timedOut: false, code: 1 }, null],
  ];
  for (const [res, report] of cases) {
    const v = classifyScan(res, report);
    assert.equal(
      v.dispatchable, v.outcome === 'blocked',
      `${JSON.stringify(res)} — dispatchable must track 'blocked' and nothing else`,
    );
  }
});

test('an empty/garbage result is inconclusive rather than actionable', () => {
  assert.equal(classifyScan().outcome, 'inconclusive');
  assert.equal(classifyScan({}).outcome, 'inconclusive');
  assert.equal(classifyScan({}, {}).dispatchable, false);
});

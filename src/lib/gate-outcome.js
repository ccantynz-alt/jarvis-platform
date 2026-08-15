/**
 * Pure classification of a GateTest scan result — src/lib/gate-outcome.js
 *
 * Extracted from deploy-gate.js on 2026-08-15 because the decision it makes is
 * the most consequential one in that service and it was untestable inside a
 * function that spawns a process.
 *
 * THE INCIDENT: `blocked` was a bare `exitCode !== 0`, and deploy-gate forces
 * exitCode = 1 when the scan times out. So "the scan did not finish" and "the
 * scan found a critical defect" were the same branch — and that branch calls
 * dispatchAutoFix(), which POSTs to /dispatch and spawns
 * `claude --dangerously-skip-permissions` as root in the platform's own
 * checkout, with a prompt ending "then commit and push as usual".
 *
 * None of the governance machinery guards that path: no proposal, no officer
 * review, no jarvis/fix-<id> branch restriction, no CAUTION_RE, no denied-
 * platform list. It predates lib/fix-dispatch.js and was never brought under it.
 * And the trigger requires no defect at all — only slowness. fleet-check.sh
 * records vapron.ai returning 000 on 13% of probes from slowness alone, and
 * alecrae, which fix-dispatch.js denies by standing rule as a live co-tenant of
 * this box, is reachable here.
 *
 * THREE OUTCOMES, deliberately, because two is what caused the incident:
 *   passed        — the scan ran and found nothing.
 *   blocked       — the scan ran and found something. Only this may dispatch.
 *   inconclusive  — the scan did not produce a verdict. Tell a human; change
 *                   nothing; invent no health score.
 *
 * "We don't know" is a real answer and must never be rounded to "it's broken" —
 * the same principle dnsState() applies by separating `nxdomain` (their domain
 * is gone) from `unresolvable` (our resolver hiccuped).
 */

/**
 * @param {object} res              result of the scan process
 * @param {boolean} res.timedOut    the process tree was killed at the deadline
 * @param {number|null} res.code    exit code, or null/undefined if it never exited cleanly
 * @param {object|null} report      parsed gatetest-report-latest.json, if one was written
 * @returns {{outcome: 'passed'|'blocked'|'inconclusive', criticalCount: number, dispatchable: boolean}}
 */
export function classifyScan({ timedOut = false, code = null } = {}, report = null) {
  if (timedOut) {
    // No verdict. Note we do NOT consult the report here: a report written by a
    // run that was killed mid-flight is partial by definition, and treating a
    // partial report as findings is how a timeout becomes a "defect" again.
    return { outcome: 'inconclusive', criticalCount: 0, dispatchable: false };
  }

  // A process that never returned a real exit code did not complete either. It
  // is inconclusive for the same reason a timeout is — previously this fell
  // through to `exitCode = 1`, i.e. straight to "blocked", and dispatched.
  //
  // Number.isInteger, not `typeof === 'number'`: NaN is a number, and NaN !== 0,
  // so a NaN exit code would classify as BLOCKED and dispatch a root agent. That
  // is this box's oldest lesson (a NaN gate does not gate — the 117-dispatch
  // day) arriving at the most dangerous branch in the service. Caught by
  // test/gate-outcome.test.js before it ever ran.
  if (!Number.isInteger(code)) {
    return { outcome: 'inconclusive', criticalCount: 0, dispatchable: false };
  }

  if (code === 0) {
    return { outcome: 'passed', criticalCount: 0, dispatchable: false };
  }

  const reported = report?.summary?.checks?.errors;
  return {
    outcome: 'blocked',
    criticalCount: typeof reported === 'number' ? reported : 1,
    dispatchable: true,
  };
}

/**
 * health-status.js — who is allowed to change a platform's `status`, and when.
 *
 * `platform_state.status` has TWO writers that mean different things by it:
 *
 *   scripts/fleet-check.sh   every 10 min — 'error' means the PUBLIC URL stopped
 *                            answering. This is the signal self-heal.js acts on.
 *   src/audit-runner.js      daily — 'healthy' means a BUILD and its TESTS pass.
 *
 * Last writer wins, which makes the collision silent and one direction of it
 * dangerous: an audit landing while a site is down writes 'healthy' over
 * fleet-check's 'error', and self-heal only ever repairs platforms whose status
 * is 'error'. The outage stays, the signal is gone, and nothing is logged.
 *
 * The rule below is deliberately asymmetric, because the evidence is:
 *   - a passing build says NOTHING about whether the site is reachable;
 *   - a real HTTP probe does.
 * So only a probe may clear an outage. Screenshots explicitly do not count —
 * Chromium photographs a 500 error page perfectly happily, which is the exact
 * bug that made the url-only audit score a dead site 100/100 (2026-07-30).
 *
 * Extracted from audit-runner.js so this decision is unit-testable: it gates
 * whether an outage gets repaired, and audit-runner opens SQLite at import time,
 * which makes it untestable off the box.
 */

/**
 * @param {object} args
 * @param {string|null} args.existingStatus  what the row says now (fleet-check's view)
 * @param {string} args.reportStatus         what this audit concluded
 * @param {Array<{ok: boolean}>|null} args.http  real HTTP probe results, if any
 * @returns {{status: string, preserved: boolean, reason: string}}
 */
export function resolveAuditStatus({ existingStatus, reportStatus, http }) {
  const probed = Array.isArray(http) ? http : null;
  const provedUp = !!probed && probed.length > 0 && probed.every(c => c && c.ok);

  if (reportStatus !== 'healthy' || existingStatus !== 'error') {
    return { status: reportStatus, preserved: false, reason: 'no conflict to resolve' };
  }
  if (provedUp) {
    return { status: 'healthy', preserved: false, reason: 'HTTP probe proved the site is up, so the outage flag is cleared' };
  }
  return {
    status: 'error',
    preserved: true,
    reason: probed
      ? 'build/tests pass but the HTTP probe did not confirm the site is up — the outage flag stays so self-heal can act'
      : 'build/tests pass but this audit never probed HTTP — a passing build is not evidence the site is reachable',
  };
}

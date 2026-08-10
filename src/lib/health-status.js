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
 * The THIRD writer: orchestrator's per-job outcome (2026-08-10).
 *
 * A job finishing writes 'healthy'/'error' for its platform, which is only
 * meaningful when the job was actually working ON that platform. Two kinds of
 * job are not:
 *
 *   - role-agent jobs (`agent` set) — a social-media draft succeeding says
 *     nothing about whether the platform is up. Guarded since the agent-org
 *     shipped.
 *   - typed PC ACTIONS (`runtime: 'action'`) — "list the services", "fetch a
 *     transcript". Whether a verb succeeds is not whether the machine is alive,
 *     and conflating them cost 235 alert-level phone pushes in 48 hours: the
 *     harvester's hourly `harvest.list` hit a PC worker running older code, was
 *     refused as an unknown verb, and each refusal wrote craig-pc
 *     `status:'error'` — which self-heal then alerted on every 5 minutes, about
 *     a machine that was fine the whole time.
 *
 * Liveness for the PC has its own honest signal (`/pc/status`, from the
 * worker's heartbeat). This predicate keeps a failed verb from impersonating it.
 *
 * @param {{agent?: string|null, runtime?: string|null}} row  the job row
 * @returns {boolean} may this job's outcome write platform_state.status?
 */
export function jobWritesPlatformHealth(row) {
  if (!row) return false;
  if (row.agent) return false;
  if (row.runtime === 'action') return false;
  return true;
}

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

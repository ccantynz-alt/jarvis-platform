/**
 * Jarvis — src/lib/service-verdict.js
 *
 * "This port is not answering" is not one situation, it is four, and they deserve
 * different reactions. systemd already knows which one it is; the self-watch just
 * wasn't asking.
 *
 * Written 2026-07-30 from production evidence. The watcher shipped that morning
 * fired a device ALERT at 09:03:21 for jarvis-browser — and the journal shows a
 * clean `Stopping / Deactivated successfully / Stopped` at 09:02:32 followed by
 * `Started` at 09:03:22. That was a deploy restart of mine, not a fault. The
 * threshold is 2 consecutive checks at 30s, whose comment claims it "rides out a
 * restart", but checks land on fixed boundaries so a 50-second gap covers two of
 * them. Every slow deploy would push an alert to Craig's phone, which is the
 * alert-fatigue pattern that gets a channel muted.
 *
 * The reverse case matters just as much: when systemd has already given up on a
 * unit (ActiveState=failed), waiting another 60 seconds to "confirm" is time spent
 * proving something already known.
 *
 * So: quieter for restarts, FASTER for real failures.
 */

/**
 * @param {object} o
 * @param {boolean} o.portDown  the port probe failed
 * @param {string} [o.active]   systemd ActiveState (active|activating|deactivating|inactive|failed)
 * @param {string} [o.sub]      systemd SubState (running|auto-restart|start-pre|dead|…)
 * @returns {'ok'|'restarting'|'failed'|'stopped'|'notlistening'}
 */
export function serviceVerdict({ portDown, active = '', sub = '' }) {
  if (!portDown) return 'ok';

  const a = String(active).trim().toLowerCase();
  const s = String(sub).trim().toLowerCase();

  // Mid-transition: systemd is bringing it up or taking it down right now. This is
  // the deploy case, and it is not news.
  if (a === 'activating' || a === 'deactivating' || s === 'auto-restart' || s === 'start-pre' || s === 'start-post') {
    return 'restarting';
  }

  // systemd has given up. Do not wait for a streak to confirm what it already
  // concluded. Deliberately keyed on ActiveState and NOT on Result: Result holds
  // the LAST outcome even for a unit that is running again, so a service that
  // OOM'd hours ago and recovered would otherwise be reported as failed forever.
  if (a === 'failed') return 'failed';

  // Someone stopped it on purpose (Restart=always means it would not sit inactive
  // on its own). Worth saying, not worth waking him for.
  if (a === 'inactive') return 'stopped';

  // systemd believes it is running, and the port disagrees. This is the ambiguous
  // and genuinely dangerous case — a live process that has stopped serving — so it
  // keeps the streak requirement rather than firing on one missed probe.
  return 'notlistening';
}

/**
 * How loudly each verdict deserves to be reported, and how many consecutive failed
 * probes it takes. `minChecks` rather than a boolean, because the right patience
 * differs per verdict and the numbers are the whole point:
 *
 *   failed       1  — systemd has given up. Waiting to confirm wastes outage time.
 *   notlistening 2  — ~60s. A live process that stopped serving; one missed probe
 *                     on an otherwise-healthy unit is not enough to go on.
 *   stopped      4  — ~2 minutes, and this number is the actual fix for the 09:03
 *                     alert. That was NOT a `systemctl restart` (which completes in
 *                     under a second and never gets sampled); the journal shows a
 *                     stop at 09:02:32 and a separate start at 09:03:22, so systemd
 *                     read `inactive/dead` for fifty seconds — verdict `stopped`,
 *                     not `restarting`. Classifying it correctly was not enough on
 *                     its own: `warn` is at PUSH_MIN_LEVEL, so his phone would still
 *                     have buzzed. A deploy gap of under two minutes now passes in
 *                     silence, while a service left stopped and forgotten still
 *                     reports itself.
 */
export const VERDICT_POLICY = {
  ok:           { alert: false, minChecks: 0 },
  restarting:   { alert: false, minChecks: 0 },   // no strike accumulated at all
  failed:       { alert: true, level: 'alert', minChecks: 1 },
  notlistening: { alert: true, level: 'alert', minChecks: 2 },
  stopped:      { alert: true, level: 'warn',  minChecks: 4 },
};

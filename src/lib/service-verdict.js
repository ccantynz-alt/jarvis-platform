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

/** How loudly each verdict deserves to be reported, and whether a streak is needed. */
export const VERDICT_POLICY = {
  ok:           { alert: false },
  restarting:   { alert: false },                      // no strike, no noise
  failed:       { alert: true, level: 'alert', immediate: true },
  stopped:      { alert: true, level: 'warn',  immediate: true },
  notlistening: { alert: true, level: 'alert', immediate: false },  // needs the streak
};

/**
 * experience.js — pure logic for the experience self-check (2026-08-11).
 *
 * Craig: "how do we keep improving." The honest answer from the week that
 * prompted it: every fault that actually reached him was found by HIM, not by
 * the box. The open mic answering his household, 235 phone alerts about a
 * healthy PC, the voice silently dropping to the browser fallback, production
 * sitting on an agent's branch while deploys quietly no-op'd — twelve services
 * were green through all of it.
 *
 * The fleet watches ITSELF well. Nothing watched the EXPERIENCE. So every check
 * here is a thing Craig had to notice once, turned into something the box
 * notices instead. A check that does not cite a real incident does not belong
 * here — this is not a place to add plausible-sounding monitoring.
 *
 * The failure mode being defended against is SILENT DEGRADATION, which is
 * exactly what those incidents had in common: nothing errored, things just
 * quietly became wrong. So a check "passes" only on positive evidence, never on
 * the absence of an error.
 *
 * NOISE DISCIPLINE IS PART OF THE DESIGN, not a garnish. A checker that shouts
 * every hour would be the 2026-08-10 flood wearing a nicer coat — 235 pushes
 * about a machine that was fine. So: announce when the SET of failures CHANGES,
 * once a day while unchanged, and once on recovery. Never per tick.
 */

import { createHash } from 'crypto';

export const SEVERITIES = ['critical', 'warn', 'info'];

/**
 * One check's outcome. `ok:false` needs `detail` — a failure nobody can act on
 * is a failure nobody will act on.
 */
export function result(id, ok, { detail = '', severity = 'warn', incident = '' } = {}) {
  return {
    id,
    ok: !!ok,
    severity: SEVERITIES.includes(severity) ? severity : 'warn',
    detail: String(detail || '').slice(0, 300),
    incident: String(incident || '').slice(0, 120),
  };
}

/**
 * The identity of a RESULT SET — used to decide whether anything actually
 * changed since the last run. Deliberately covers the failing ids AND their
 * severities, but NOT the detail text: a detail that carries a count ("3 in the
 * last hour") would change every tick and make every run look new, which is
 * precisely how NotifyCenter's per-key dedupe failed to catch the daily audit
 * repeat (docs/LESSONS.md).
 */
export function fingerprint(results) {
  const failing = results.filter(r => !r.ok)
    .map(r => `${r.id}:${r.severity}`)
    .sort();
  if (!failing.length) return 'clean';
  return createHash('sha256').update(failing.join('|')).digest('hex').slice(0, 16);
}

export const worstSeverity = (results) => {
  const failing = results.filter(r => !r.ok);
  if (!failing.length) return null;
  return SEVERITIES.find(s => failing.some(r => r.severity === s)) || 'warn';
};

/**
 * Should this run say anything out loud, and at what level?
 *
 * @param {object} prev   last run's stored state { fingerprint, day, announcedDay }
 * @param {Array}  results
 * @param {string} today  YYYY-MM-DD
 * @returns {{announce: boolean, kind: 'changed'|'daily'|'recovered'|null, level: string}}
 *
 * `recovered` fires only when the PREVIOUS run was actually dirty — a first
 * run on a clean box must not announce that nothing is wrong, which would be a
 * notification whose entire content is "no news".
 */
export function announcement(prev, results, today) {
  const fp = fingerprint(results);
  const wasDirty = !!prev?.fingerprint && prev.fingerprint !== 'clean';

  if (fp === 'clean') {
    return wasDirty
      ? { announce: true, kind: 'recovered', level: 'info' }
      : { announce: false, kind: null, level: 'info' };
  }

  const worst = worstSeverity(results);
  // critical maps to warn, NOT alert: lib/push.js exempts `alert` from both
  // dedupe and the hourly cap, and this runs on a timer. Nothing on a timer
  // should be able to reach that exemption (the 2026-08-10 lesson).
  const level = worst === 'critical' ? 'warn' : 'info';

  if (fp !== prev?.fingerprint) return { announce: true, kind: 'changed', level };
  if (prev?.announcedDay !== today) return { announce: true, kind: 'daily', level };
  return { announce: false, kind: null, level };
}

/** One line per failure, worst first — what Craig actually reads. */
export function summarize(results, kind) {
  const failing = results.filter(r => !r.ok)
    .sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  if (!failing.length) {
    return 'Everything Craig would notice is behaving: voice, alerts, deploys and the brain all check out.';
  }
  const head = kind === 'daily'
    ? `${failing.length} thing(s) still not right (unchanged since yesterday):`
    : `${failing.length} thing(s) Craig would notice:`;
  return [head, ...failing.map(r =>
    `• [${r.severity}] ${r.detail}${r.incident ? `  (last seen: ${r.incident})` : ''}`)].join('\n');
}

/** The spoken line: short, and it never reads out a list. */
export function speech(results) {
  const failing = results.filter(r => !r.ok);
  if (!failing.length) return null;               // never speak good news on a timer
  const worst = worstSeverity(results);
  if (worst === 'critical') {
    return `Sir, something you would notice has broken — ${failing[0].detail.slice(0, 90)}`;
  }
  return `Sir, ${failing.length} small thing${failing.length === 1 ? '' : 's'} worth a look when convenient.`;
}

// ── individual check predicates (pure; the probes live in the service) ───────

/**
 * Deploy drift. Production ran for two days on `jarvis/fix-pc-harvest-dispatch`
 * while `git pull` reported "Already up to date" and every deploy silently
 * no-op'd (2026-08-11). Nothing noticed; a rename failing to appear did.
 */
export function checkDeploy({ branch, localSha, originSha }) {
  if (!branch || !localSha) {
    return result('deploy', false, { severity: 'warn', detail: 'could not read the box\'s git state', incident: '2026-08-11' });
  }
  if (branch !== 'main') {
    return result('deploy', false, {
      severity: 'critical', incident: '2026-08-11',
      detail: `production is on branch "${branch}", not main — deploys to main will silently do nothing`,
    });
  }
  if (originSha && localSha !== originSha) {
    return result('deploy', false, {
      severity: 'warn', incident: '2026-08-11',
      detail: `box is at ${localSha} but origin/main is ${originSha} — a deploy did not land`,
    });
  }
  return result('deploy', true, { detail: `on main at ${localSha}` });
}

/**
 * Health honesty. /health reported `tts: true` for over a day while every
 * synthesis 503'd on an exhausted ElevenLabs quota (2026-08-10). A health
 * signal that lies is worse than none, because it is checked instead of the
 * thing itself.
 */
export function checkVoice({ healthSaysTts, ttsStatus, ttsDisabled }) {
  if (ttsDisabled) {
    return healthSaysTts
      ? result('voice', false, { severity: 'warn', incident: '2026-08-10', detail: 'TTS is disabled but /health still advertises it' })
      : result('voice', true, { detail: 'custom voice off by choice; browser voice in use' });
  }
  if (healthSaysTts && ttsStatus !== 200) {
    return result('voice', false, {
      severity: 'critical', incident: '2026-08-10',
      detail: `/health says the custom voice is on, but synthesis returns ${ttsStatus} — he is silently on the backup voice`,
    });
  }
  return result('voice', true, { detail: 'voice synthesis answering' });
}

/**
 * The brain must be on a SUBSCRIPTION provider. On 2026-07-25 a total outage
 * failed over to metered `anthropic`, persisted that choice to KV, and billed
 * per-token with no ongoing signal.
 */
export const SUBSCRIPTION_PROVIDERS = ['claude'];
export function checkBrain({ provider, degraded }) {
  if (!provider) return result('brain', false, { severity: 'warn', detail: 'could not read the brain provider', incident: '2026-07-25' });
  if (!SUBSCRIPTION_PROVIDERS.includes(provider)) {
    return result('brain', false, {
      severity: 'critical', incident: '2026-07-25',
      detail: `the brain is on "${provider}" — a metered provider, not the subscription`,
    });
  }
  if (degraded) {
    return result('brain', false, { severity: 'warn', incident: '2026-07-28', detail: 'the brain is flagged degraded — replies are falling back to keyword intent' });
  }
  return result('brain', true, { detail: `on ${provider}` });
}

/**
 * Alert volume. 235 alert-level pushes in 48 hours about a healthy PC
 * (2026-08-10). The threshold is per hour and deliberately generous — this
 * catches a FLOOD, not a busy afternoon.
 */
export function checkAlertRate({ lastHour, threshold = 12 }) {
  const n = Number(lastHour) || 0;
  if (n > threshold) {
    return result('alerts', false, {
      severity: 'critical', incident: '2026-08-10',
      detail: `${n} notifications in the last hour (threshold ${threshold}) — something is flooding him`,
    });
  }
  return result('alerts', true, { detail: `${n} notification(s) in the last hour` });
}

/**
 * The PC worker. Craig, 2026-08-11: "we could ask marco to look up my computer
 * specs before, now we cant." It had been dead 26 HOURS — his machine sat at
 * 96% memory and the worker was squeezed out — and the watchdog that exists to
 * revive it turned out never to have been installed, because that half of
 * install-pc-worker.ps1 only runs elevated and the elevated run never happened.
 * So the documented safety net was itself dead, silently, and he found out by
 * asking Marco a question it could no longer answer.
 *
 * Deliberately generous: his PC legitimately sleeps overnight, and a sleeping
 * machine is not a fault. This catches "gone for hours while he is using it",
 * not "not right this second".
 */
export function checkPcWorker({ secondsSinceSeen, staleAfter = 4 * 3600 }) {
  if (secondsSinceSeen == null) {
    return result('pc_worker', false, { severity: 'warn', incident: '2026-08-11', detail: 'the PC worker has never checked in' });
  }
  if (secondsSinceSeen > staleAfter) {
    const hours = Math.round(secondsSinceSeen / 3600);
    return result('pc_worker', false, {
      severity: 'warn', incident: '2026-08-11',
      detail: `the PC worker has not checked in for ${hours}h — anything Marco does on the PC (specs, services, transcripts) is unavailable`,
    });
  }
  return result('pc_worker', true, { detail: `PC worker seen ${Math.round(secondsSinceSeen / 60)}m ago` });
}

/**
 * Can the box still SPAWN an agent at all?
 *
 * 2026-08-16, and the sharpest example yet of the thing this file exists for.
 * Both claude.ai logins on the box expired. Every box-local spawn then failed
 * in about two seconds — code-health, fix-runner, self-heal, review-runner,
 * harvester distillation, the 44 role agents — for THREE DAYS. All twelve
 * services stayed green the entire time, because every one of them reports its
 * own port and none of them reports "the thing I exist to launch cannot start".
 * The only visible symptom was an absence: no new code findings. Craig asked
 * how to run a bigger bug search; the honest answer was that the finder had
 * been dead since the 13th.
 *
 * The signal is a heartbeat written by spawn-agent.js on every spawn that
 * authenticates (KV `claude-last-spawn-ok`), so this measures the real thing —
 * an agent actually ran — rather than a config file's opinion of it.
 *
 * Generous by default: the busiest gap between scheduled sweeps is code-health
 * at 3h, so 6h means at least two cadences produced nothing. `warn`, never
 * `alert`, per this file's standing rule.
 */
export function checkAgentSpawns({ secondsSinceOk, staleAfter = 6 * 3600 }) {
  if (secondsSinceOk == null) {
    return result('agent_spawns', false, {
      severity: 'warn', incident: '2026-08-16',
      detail: 'no agent spawn has ever authenticated — every autonomous timer is doing nothing',
    });
  }
  if (secondsSinceOk > staleAfter) {
    const hours = Math.round(secondsSinceOk / 3600);
    return result('agent_spawns', false, {
      severity: 'warn', incident: '2026-08-16',
      detail: `no agent has spawned successfully in ${hours}h — code-health, fix-runner, self-heal and the role agents are all stopped; check the Claude login on the box`,
    });
  }
  return result('agent_spawns', true, { detail: `last successful agent spawn ${Math.round(secondsSinceOk / 60)}m ago` });
}

/**
 * show_me depends on the guarded render path; a dead browser service kills it
 * silently — and so does a live one whose Chrome cannot launch (2026-08-30:
 * for weeks every render 502'd while this check reported "capture path
 * healthy", because it trusted a static health 200 that never touched Chrome).
 * Passes only on positive evidence: the deep probe launched Chrome and said so.
 */
export function checkShowMe({ browserOk, chromeOk = null, chromeError = null }) {
  if (!browserOk) {
    return result('show_me', false, { severity: 'warn', incident: '2026-08-11', detail: 'the browser service is down — "show me" cannot capture anything' });
  }
  if (chromeOk !== true) {
    return result('show_me', false, {
      severity: 'warn', incident: '2026-08-30',
      detail: `the browser service is up but Chrome failed its launch probe${chromeError ? ` (${chromeError})` : ''} — every "show me" and render fails while the port stays green`,
    });
  }
  return result('show_me', true, { detail: 'capture path healthy — Chrome launch verified' });
}

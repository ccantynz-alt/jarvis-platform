// The experience self-check (src/lib/experience.js), 2026-08-11.
//
// Craig: "how do we keep improving." Built because for a week every fault that
// reached him was found by HIM while twelve services stayed green. Each check
// below is one of those incidents turned around — so the tests are, quite
// literally, the week that prompted it.
//
// The most important tests here are NOT the checks. They are the noise
// discipline: a checker that shouts every hour would be the 2026-08-10 alert
// flood wearing a nicer coat.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDeploy, checkVoice, checkBrain, checkAlertRate, checkShowMe, checkPcWorker,
  fingerprint, announcement, summarize, speech, worstSeverity, result,
} from '../src/lib/experience.js';

const ok = (id) => result(id, true, { detail: 'fine' });
const bad = (id, severity = 'warn') => result(id, false, { severity, detail: `${id} broken` });

// ── the checks, each against its real incident ──────────────────────────────

test('deploy: production on an agent branch is CRITICAL (2026-08-11)', () => {
  const r = checkDeploy({ branch: 'jarvis/fix-pc-harvest-dispatch', localSha: 'a48b2a5', originSha: 'd56a0f9' });
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'critical');
  assert.match(r.detail, /not main/);
});

test('deploy: on main but behind origin is a landed-nothing warning', () => {
  const r = checkDeploy({ branch: 'main', localSha: 'aaa1111', originSha: 'bbb2222' });
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'warn');
  assert.equal(checkDeploy({ branch: 'main', localSha: 'aaa1111', originSha: 'aaa1111' }).ok, true);
});

test('deploy: an unreachable origin is not a failure — drift is merely unknown', () => {
  assert.equal(checkDeploy({ branch: 'main', localSha: 'aaa1111', originSha: null }).ok, true);
});

test('voice: /health saying tts:true while synthesis 503s is CRITICAL (2026-08-10)', () => {
  const r = checkVoice({ healthSaysTts: true, ttsStatus: 503, ttsDisabled: false });
  assert.equal(r.ok, false);
  assert.equal(r.severity, 'critical');
  assert.match(r.detail, /backup voice/);
});

test('voice: deliberately disabled is FINE — that is a choice, not a fault', () => {
  assert.equal(checkVoice({ healthSaysTts: false, ttsStatus: 503, ttsDisabled: true }).ok, true);
  // ...but the flag must not still advertise a voice that is off
  assert.equal(checkVoice({ healthSaysTts: true, ttsStatus: 503, ttsDisabled: true }).ok, false);
});

test('brain: a metered provider is CRITICAL (2026-07-25 silent billing)', () => {
  assert.equal(checkBrain({ provider: 'anthropic' }).severity, 'critical');
  assert.equal(checkBrain({ provider: 'gemini' }).ok, false);
  assert.equal(checkBrain({ provider: 'claude' }).ok, true);
  assert.equal(checkBrain({ provider: 'claude', degraded: true }).ok, false);
});

test('alerts: a flood is caught, a busy afternoon is not (2026-08-10)', () => {
  assert.equal(checkAlertRate({ lastHour: 60 }).ok, false);   // the 235-in-48h shape
  assert.equal(checkAlertRate({ lastHour: 12 }).ok, true);    // at the threshold, not over
  assert.equal(checkAlertRate({ lastHour: 0 }).ok, true);
});

test('pc worker: the 26-hour silence Craig found by asking (2026-08-11)', () => {
  const r = checkPcWorker({ secondsSinceSeen: 95876 });   // the real number that day
  assert.equal(r.ok, false);
  assert.match(r.detail, /27h|26h/);
  assert.match(r.detail, /specs|services|transcripts/, 'must say what he LOSES, not just that a process died');
});

test('pc worker: a sleeping PC is not a fault, a never-seen one is', () => {
  assert.equal(checkPcWorker({ secondsSinceSeen: 120 }).ok, true);
  assert.equal(checkPcWorker({ secondsSinceSeen: 3 * 3600 }).ok, true, 'overnight sleep must not page him');
  assert.equal(checkPcWorker({ secondsSinceSeen: null }).ok, false);
});

test('show_me: a dead browser service is caught', () => {
  assert.equal(checkShowMe({ browserOk: false }).ok, false);
  assert.equal(checkShowMe({ browserOk: true }).ok, true);
});

// ── noise discipline: the part that stops this becoming the problem ─────────

test('a clean run on a previously-clean box says NOTHING', () => {
  const clean = [ok('deploy'), ok('voice')];
  const a = announcement({ fingerprint: 'clean', announcedDay: '2026-08-11' }, clean, '2026-08-11');
  assert.equal(a.announce, false, 'a notification whose content is "no news" is noise');
  // and on the very first run ever, with no stored state at all
  assert.equal(announcement({}, clean, '2026-08-11').announce, false);
});

test('the same failure does NOT re-announce within a day — the flood guard', () => {
  const results = [bad('voice', 'critical'), ok('deploy')];
  const fp = fingerprint(results);
  const state = { fingerprint: fp, announcedDay: '2026-08-11' };
  assert.equal(announcement(state, results, '2026-08-11').announce, false,
    'hourly re-announcement of an unchanged fault is exactly the 2026-08-10 flood');
});

test('...but it does re-announce once the next day, and immediately on CHANGE', () => {
  const results = [bad('voice', 'critical')];
  const fp = fingerprint(results);
  assert.equal(announcement({ fingerprint: fp, announcedDay: '2026-08-10' }, results, '2026-08-11').kind, 'daily');
  const worse = [bad('voice', 'critical'), bad('deploy', 'critical')];
  assert.equal(announcement({ fingerprint: fp, announcedDay: '2026-08-11' }, worse, '2026-08-11').kind, 'changed');
});

test('recovery is announced once, and only from a genuinely dirty state', () => {
  const clean = [ok('voice')];
  assert.equal(announcement({ fingerprint: 'abc123', announcedDay: '2026-08-11' }, clean, '2026-08-11').kind, 'recovered');
  assert.equal(announcement({ fingerprint: 'clean', announcedDay: '2026-08-11' }, clean, '2026-08-11').announce, false);
});

test('NOTHING here can reach `alert` level — push.js exempts alert from every cap', () => {
  for (const sev of ['critical', 'warn', 'info']) {
    const a = announcement({}, [bad('x', sev)], '2026-08-11');
    assert.notEqual(a.level, 'alert',
      'a timer that can emit `alert` can bypass dedupe AND the hourly cap — that is the flood');
    assert.ok(['warn', 'info'].includes(a.level));
  }
});

test('the fingerprint ignores detail text, so a changing count is not "new"', () => {
  // NotifyCenter's dedupe failed exactly here: a key that changes every tick
  // makes every repeat look brand new (docs/LESSONS.md).
  const a = [result('alerts', false, { severity: 'critical', detail: '31 notifications in the last hour' })];
  const b = [result('alerts', false, { severity: 'critical', detail: '47 notifications in the last hour' })];
  assert.equal(fingerprint(a), fingerprint(b));
  // but a genuinely different failure IS new
  assert.notEqual(fingerprint(a), fingerprint([bad('voice', 'critical')]));
});

test('summaries and speech: worst first, and good news is never spoken', () => {
  const results = [bad('voice', 'warn'), bad('deploy', 'critical'), ok('brain')];
  assert.equal(worstSeverity(results), 'critical');
  const s = summarize(results, 'changed');
  assert.ok(s.indexOf('deploy broken') < s.indexOf('voice broken'), 'critical must lead');
  assert.equal(speech([ok('voice')]), null, 'a timer must never speak good news at him');
  assert.match(speech(results), /^Sir,/);
});

// ── The finder was dead and nothing said so (2026-08-16) ────────────────────
// Craig asked how to run a bigger bug search. The honest answer was that
// jarvis-code-health had filed nothing since the 13th, because both claude.ai
// logins had expired and every box-local spawn was failing in two seconds.
// Twelve services stayed green throughout: each reports its own port, none
// reports "the thing I exist to launch cannot start".

import { checkAgentSpawns } from '../src/lib/experience.js';

test('a fresh spawn heartbeat passes', () => {
  const r = checkAgentSpawns({ secondsSinceOk: 20 * 60 });
  assert.equal(r.ok, true);
});

test('no successful spawn for hours is caught — the actual 2026-08-16 outage', () => {
  const r = checkAgentSpawns({ secondsSinceOk: 3 * 24 * 3600 });
  assert.equal(r.ok, false);
  assert.equal(r.incident, '2026-08-16');
  assert.match(r.detail, /72h/, 'the detail must state how long the fleet has been stopped');
});

test('a heartbeat that has NEVER been written is a failure, not a pass', () => {
  // The trap: treating a missing KV key as "fine" would have made this check
  // green on exactly the box it was written for, since the key does not exist
  // until the first successful spawn writes it.
  const r = checkAgentSpawns({ secondsSinceOk: null });
  assert.equal(r.ok, false);
  assert.match(r.detail, /has ever authenticated/i);
});

test('the spawn check never reaches alert level', () => {
  // Standing rule for this file: a timer that can hit push.js's alert
  // exemption IS the flood. Every failure here must stay at warn.
  for (const s of [null, 6 * 3600 + 1, 30 * 24 * 3600]) {
    assert.equal(checkAgentSpawns({ secondsSinceOk: s }).severity, 'warn');
  }
});

test('the window is generous enough to survive one quiet code-health cadence', () => {
  // code-health is the busiest spawner at 3h. A single missed sweep must not
  // announce anything; two must.
  assert.equal(checkAgentSpawns({ secondsSinceOk: 3.5 * 3600 }).ok, true);
  assert.equal(checkAgentSpawns({ secondsSinceOk: 6.5 * 3600 }).ok, false);
});

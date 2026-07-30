// test/self-heal-rollover.test.js — the daily cap must be daily, 2026-07-30.
//
// Found by the code-health spine (jarvis / data-integrity lens). self-heal's
// recovered-platform loop runs every tick for every platform that is NOT down —
// normally all of them, every 5 minutes — and it stamped `day: today()` while
// carrying the old `attemptsToday` forward. The only reset lived in the down-path
// (`if (s.day !== today())`), so it could never fire: by the time a platform went
// down again, s.day already equalled today.
//
// Consequence: a platform that spent all 6 attempts on one bad day hit "daily cap
// hit — escalate" on EVERY future outage, forever. Autonomous repair for it was
// permanently and silently off. Same shape as the 2026-07-17 incident, in the
// opposite direction: there a guardrail stopped guarding, here it never stopped.
//
// It was not theoretical. On the box at the time of the fix: bookaride claimed
// "1 attempt today" for an attempt made on 2026-07-12, gluecron on the 14th,
// zoobicon on the 13th — and gatetest was at 5 of a cap of 6, one attempt away
// from never being auto-repaired again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rollDay } from '../src/self-heal.js';

const at = (iso) => new Date(iso).getTime();

test('a new day resets the attempt count', () => {
  const s = rollDay({ day: '2026-07-29', attemptsToday: 6, lastAttempt: at('2026-07-29T10:00:00Z'), firstDown: null }, '2026-07-30');
  assert.equal(s.day, '2026-07-30');
  assert.equal(s.attemptsToday, 0, 'this is the whole point — the cap is per day');
});

test('attempts made TODAY are kept', () => {
  const s = rollDay({ day: '2026-07-30', attemptsToday: 4, lastAttempt: at('2026-07-30T01:00:00Z') }, '2026-07-30');
  assert.equal(s.attemptsToday, 4, 'a platform cannot earn a fresh budget by recovering mid-day');
});

test('a count stamped today for an attempt made weeks ago is repaired — the live corruption', () => {
  // Exactly bookaride's real state: day says today, the attempt was 2026-07-12.
  const s = rollDay({ day: '2026-07-30', attemptsToday: 1, lastAttempt: at('2026-07-12T04:27:17Z'), firstDown: null }, '2026-07-30');
  assert.equal(s.attemptsToday, 0, 'the stored day is not evidence; the attempt timestamp is');
  assert.equal(s.lastAttempt, at('2026-07-12T04:27:17Z'), 'the cooldown clock itself is untouched');
});

test('gatetest at 5 of 6 is not silently held over to tomorrow', () => {
  const today = rollDay({ day: '2026-07-30', attemptsToday: 5, lastAttempt: at('2026-07-30T02:08:08Z') }, '2026-07-30');
  assert.equal(today.attemptsToday, 5, 'today it really has spent 5');
  const tomorrow = rollDay(today, '2026-07-31');
  assert.equal(tomorrow.attemptsToday, 0, 'tomorrow it starts again — otherwise repair is off forever');
});

test('day and attemptsToday can never move apart', () => {
  let s = { day: '2026-07-29', attemptsToday: 6, lastAttempt: at('2026-07-29T10:00:00Z'), firstDown: null };
  for (const day of ['2026-07-29', '2026-07-30', '2026-07-31']) {
    s = rollDay(s, day);
    assert.equal(s.day, day);
    assert.equal(s.attemptsToday, day === '2026-07-29' ? 6 : 0,
      `on ${day} the count must move with the date`);
  }
});

test('a count with no attempt behind it is not trusted', () => {
  const s = rollDay({ day: '2026-07-30', attemptsToday: 3, lastAttempt: 0 }, '2026-07-30');
  assert.equal(s.attemptsToday, 0, 'you cannot have attempted without stamping lastAttempt');
});

test('a clean state is returned untouched', () => {
  const clean = { day: '2026-07-30', attemptsToday: 0, lastAttempt: 0, firstDown: null };
  assert.equal(rollDay(clean, '2026-07-30'), clean, 'same object — no needless write');
});

test('it is pure — the input is never mutated', () => {
  const input = { day: '2026-07-29', attemptsToday: 6, lastAttempt: at('2026-07-29T10:00:00Z') };
  rollDay(input, '2026-07-30');
  assert.equal(input.day, '2026-07-29');
  assert.equal(input.attemptsToday, 6);
});

test('a missing state object is handled rather than thrown on', () => {
  assert.equal(rollDay(null, '2026-07-30'), null);
  assert.equal(rollDay(undefined, '2026-07-30'), undefined);
});

// ── "is this even a server problem?" ────────────────────────────────────────
// gatetest.ai's domain entered .ai redemption on 2026-07-29. DNS went NXDOMAIN,
// and self-heal dispatched SIX full-permission repair agents in one day (twelve
// runs in total), each of which spent minutes concluding "registry-level, nothing
// to do here" while the server answered 200 on localhost the whole time.

import { hostOf, dnsState } from '../src/self-heal.js';

test('hostOf survives whatever is in the URL table', () => {
  assert.equal(hostOf('https://gatetest.ai'), 'gatetest.ai');
  assert.equal(hostOf('https://www.bookaride.co.nz/path?x=1'), 'www.bookaride.co.nz');
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf(undefined), null);
});

test('a name that does not exist is nxdomain, not a server fault', async () => {
  // .invalid is reserved by RFC 2606 precisely so this can never resolve.
  assert.equal(await dnsState('https://jarvis-self-heal-test.invalid'), 'nxdomain');
});

test('a resolvable name is ok', async () => {
  assert.equal(await dnsState('https://localhost'), 'ok');
});

test('no URL to check is not a DNS verdict', async () => {
  assert.equal(await dnsState(undefined), 'n/a');
  assert.equal(await dnsState('gibberish'), 'n/a');
});

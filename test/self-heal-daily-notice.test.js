/**
 * Regression tests for the once-a-day alert gate in self-heal.
 *
 * THE INCIDENT (2026-08-15, found by a full-repo bug audit): the daily-repair-cap
 * escalation called notify() at `alert` level on every 5-minute tick with no
 * daily marker, while the two sibling branches in the same function
 * (manualNoticeDay, dnsNoticeDay) both carried one — and both carried comments
 * explaining exactly why. A platform down past its attempt cap therefore pushed
 * at ntfy priority 5 every 5 minutes until UTC midnight, then re-capped and did
 * it again the next day: ~246 pushes/day, measured by replay.
 *
 * That is the same magnitude and the same mechanism as the 235-in-48h craig-pc
 * flood of 2026-08-10. `alert` is exempt from BOTH push dedupe and the hourly
 * cap (push.js), and jarvis-self-heal is Type=oneshot so push.js's in-process
 * `recent` map starts empty on every tick — nothing downstream can rescue a
 * missing marker at this layer.
 *
 * The fix was not to patch the third branch by hand — that is how the third
 * branch got missed in the first place. DAILY_NOTICE_KEYS is now the mechanism:
 * one list, stamped by claimDailyNotice and wiped by clearDailyNotices, so a
 * fourth human-must-act branch is one string away from being correct.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimDailyNotice, clearDailyNotices, DAILY_NOTICE_KEYS } from '../src/self-heal.js';

const DAY = '2026-08-15';
const NEXT = '2026-08-16';

test('the first notice of the day announces', () => {
  const { announce, state } = claimDailyNotice({ attemptsToday: 6 }, 'capNoticeDay', DAY);
  assert.equal(announce, true);
  assert.equal(state.capNoticeDay, DAY);
});

test('THE FLOOD: 288 ticks in a day produce exactly one alert', () => {
  // 24h at the real 5-minute cadence. Before the fix this was 288 max-priority
  // pushes; the replay that found it measured 246 from the cap point onward.
  let s = { attemptsToday: 6 };
  let announced = 0;
  for (let tick = 0; tick < 288; tick++) {
    const r = claimDailyNotice(s, 'capNoticeDay', DAY);
    s = r.state;
    if (r.announce) announced++;
  }
  assert.equal(announced, 1, 'a condition only a human can clear gets a human\'s rate limit');
});

test('it re-announces the next day, because the outage is still real', () => {
  let s = { attemptsToday: 6 };
  s = claimDailyNotice(s, 'capNoticeDay', DAY).state;
  const r = claimDailyNotice(s, 'capNoticeDay', NEXT);
  assert.equal(r.announce, true, 'still down tomorrow is still worth one push');
});

test('recovery clears every marker, so the NEXT outage is not silenced', () => {
  // The failure this prevents is the mirror image of the flood, and worse: a
  // marker left over from a previous outage suppressing the alert for a new one.
  let s = { attemptsToday: 6 };
  for (const k of DAILY_NOTICE_KEYS) s = claimDailyNotice(s, k, DAY).state;

  const recovered = clearDailyNotices({ ...s, firstDown: null });
  for (const k of DAILY_NOTICE_KEYS) {
    assert.equal(recovered[k], null, `${k} must clear on recovery`);
  }
  // Same day, brand new outage: it must speak up again.
  assert.equal(claimDailyNotice(recovered, 'capNoticeDay', DAY).announce, true);
});

test('clearDailyNotices preserves the fields it does not own', () => {
  // platform_state's INSERT OR REPLACE lesson, applied to the state file: a
  // writer touches only the columns it owns.
  const s = { firstDown: 123, lastAttempt: 456, day: DAY, attemptsToday: 6, capNoticeDay: DAY };
  const out = clearDailyNotices(s);
  assert.equal(out.lastAttempt, 456);
  assert.equal(out.attemptsToday, 6, 'the daily cap must survive a recovery reset');
  assert.equal(out.day, DAY);
});

test('the three branches do not share one marker', () => {
  // A single shared flag would mean a DNS notice suppressing a cap notice.
  let s = {};
  s = claimDailyNotice(s, 'dnsNoticeDay', DAY).state;
  assert.equal(claimDailyNotice(s, 'capNoticeDay', DAY).announce, true);
  assert.equal(claimDailyNotice(s, 'manualNoticeDay', DAY).announce, true);
});

test('every alert-bearing daily branch is registered in DAILY_NOTICE_KEYS', () => {
  // The guard that makes the mechanism self-enforcing: a new branch inventing
  // its own marker field fails loudly here instead of flooding Craig silently.
  assert.throws(() => claimDailyNotice({}, 'someNewNoticeDay', DAY), /unknown daily notice key/);
  assert.deepEqual(
    [...DAILY_NOTICE_KEYS].sort(),
    ['capNoticeDay', 'dnsNoticeDay', 'manualNoticeDay'],
  );
});

test('a null/empty state announces rather than crashing', () => {
  // stateOf() can return a fresh object with no markers at all.
  assert.equal(claimDailyNotice({}, 'capNoticeDay', DAY).announce, true);
  assert.equal(claimDailyNotice({ capNoticeDay: null }, 'capNoticeDay', DAY).announce, true);
});

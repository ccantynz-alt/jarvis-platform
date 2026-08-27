/**
 * alert-smart.test.js — every case here is an incident, not a hypothetical.
 *
 * The one that matters most is the first: quiet hours must NEVER hold an alert.
 * That rule is one `if` away from silencing the 3am fire the off-box watchdog
 * exists for, and a bug there would look exactly like a working system.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localHour, inQuietHours, deckView, collapseTopic, routeAlert, buildDigest, shouldFlush,
} from '../src/lib/alert-smart.js';

// A UTC instant that is a known NZ local hour. NZST is +12, NZDT +13 — August
// is standard time, so 14:00Z is 02:00 the next day in Auckland.
const nzAt = (utcISO) => new Date(utcISO);
const NIGHT = nzAt('2026-08-27T14:00:00Z');   // 02:00 NZST
const DAY   = nzAt('2026-08-27T02:00:00Z');   // 14:00 NZST

test('the clock is read in NZ, not UTC', () => {
  assert.equal(localHour(NIGHT), 2);
  assert.equal(localHour(DAY), 14);
});

test('quiet hours wrap midnight — the range comparison that is always false', () => {
  assert.equal(inQuietHours(NIGHT, { start: 22, end: 7 }), true, '02:00 is inside 22→07');
  assert.equal(inQuietHours(DAY, { start: 22, end: 7 }), false, '14:00 is not');
  // The naive `h >= start && h < end` form returns false for BOTH of these.
  assert.equal(inQuietHours(nzAt('2026-08-27T11:00:00Z'), { start: 22, end: 7 }), true, '23:00');
  assert.equal(inQuietHours(nzAt('2026-08-26T18:30:00Z'), { start: 22, end: 7 }), true, '06:30 is still inside');
  assert.equal(inQuietHours(nzAt('2026-08-26T19:30:00Z'), { start: 22, end: 7 }), false, '07:30 is out');
});

// The defaults are the configuration that actually runs — no ALERT_QUIET_*
// variable is set on the box, so if guardrail() hands back the wrong number
// here, quiet hours are silently empty and every test above still passes.
test('with nothing configured, quiet hours are 22:00–07:00 NZ', () => {
  assert.equal(inQuietHours(NIGHT), true, '02:00 must be quiet by default');
  assert.equal(inQuietHours(DAY), false, '14:00 must not be');
});

test('quiet hours can be switched off by making them empty', () => {
  assert.equal(inQuietHours(NIGHT, { start: 7, end: 7 }), false);
});

test('AN ALERT IS NEVER HELD — this is the line the watchdog depends on', () => {
  const r = routeAlert({ level: 'alert', source: 'fleet-check', title: 'box unreachable', now: NIGHT });
  assert.equal(r.deliver, true);
  assert.equal(r.hold, false);
  assert.equal(r.urgency, 'high', 'must wake a sleeping phone');
  assert.equal(r.ttl, 86400, 'still worth delivering when the phone comes back');
});

test('a warning at 2am is held, not dropped, and not delivered', () => {
  const r = routeAlert({ level: 'warn', source: 'code-health', title: '3 new findings', now: NIGHT });
  assert.equal(r.deliver, false);
  assert.equal(r.hold, true);
  assert.equal(r.reason, 'quiet-hours');
});

test('the same warning at 2pm goes straight through', () => {
  const r = routeAlert({ level: 'warn', source: 'code-health', title: '3 new findings', now: DAY });
  assert.equal(r.deliver, true);
  assert.equal(r.hold, false);
});

test('info never buzzes a phone, at any hour', () => {
  for (const now of [NIGHT, DAY]) {
    const r = routeAlert({ level: 'info', source: 'mail-watch', title: 'new mail', now });
    assert.equal(r.deliver, false);
    assert.equal(r.hold, false, 'and it is not queued for a digest either — it is inbox-only');
  }
});

test('every alert names the deck tab that answers it', () => {
  assert.equal(deckView('code-health', '3 new findings'), 'ops');
  assert.equal(deckView('fix-runner', 'proposal opened'), 'ops');
  assert.equal(deckView('mail-watch', 'new mail for Marco'), 'ops');
  assert.equal(deckView('fleet-check', 'davenroe is down'), 'plat');
  assert.equal(deckView('self-heal', 'repair dispatched'), 'plat');
  assert.equal(deckView('agent-scheduler', 'CFO escalated'), 'org');
  assert.equal(deckView('orchestrator', 'job 412 failed'), 'flow');
  assert.equal(deckView('something-new', 'who knows'), 'hud', 'unknown sources land on the HUD, honestly');
});

test('the collapse topic is stable per headline and legal as a header', () => {
  const a = collapseTopic('davenroe-api is down');
  assert.equal(a, collapseTopic('davenroe-api is down'));
  assert.notEqual(a, collapseTopic('alecrae is down'));
  assert.ok(a.length <= 24 && /^[A-Za-z0-9_-]+$/.test(a));
});

test('a digest says WHAT, not just how many', () => {
  const d = buildDigest([
    { source: 'fleet-check', title: 'gatetest.ai does not resolve', at: '2026-08-27T14:00:00Z' },
    { source: 'fleet-check', title: 'voxlen.com is parked', at: '2026-08-27T14:05:00Z' },
    { source: 'code-health', title: '2 new high findings', at: '2026-08-27T15:00:00Z' },
  ]);
  assert.equal(d.count, 3);
  assert.match(d.title, /^3 held overnight — 2 fleet-check, 1 code-health$/);
  assert.match(d.body, /gatetest\.ai does not resolve/);
  assert.match(d.body, /2 new high findings/);
});

test('one held item is reported as itself, not as "1 held overnight"', () => {
  const d = buildDigest([{ source: 'fleet-check', title: 'gatetest.ai does not resolve', at: '2026-08-27T14:00:00Z' }]);
  assert.equal(d.title, 'gatetest.ai does not resolve');
});

test('an empty queue produces no digest at all', () => {
  assert.equal(buildDigest([]), null);
  assert.equal(buildDigest([{ source: 'x' }]), null, 'a titleless row is not a notification');
});

test('a long queue is trimmed but says so', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ source: 's', title: `item ${i}`, at: '2026-08-27T14:00:00Z' }));
  const d = buildDigest(many, { max: 6 });
  assert.equal(d.count, 20);
  assert.match(d.body, /showing the last 6 of 20/);
  assert.equal(d.body.split('\n').length, 7);
});

test('the queue flushes when quiet hours end', () => {
  const held = [{ source: 's', title: 't', at: '2026-08-27T14:00:00Z' }];
  assert.equal(shouldFlush(held, { now: NIGHT }), false, 'still the middle of the night');
  assert.equal(shouldFlush(held, { now: DAY }), true, 'morning — deliver it');
  assert.equal(shouldFlush([], { now: DAY }), false, 'nothing to flush');
});

test('a queue held too long flushes anyway — a clock-only flush never fires if the clock is missed', () => {
  const stale = [{ source: 's', title: 't', at: '2026-08-26T14:00:00Z' }];  // 24h earlier
  assert.equal(shouldFlush(stale, { now: NIGHT, maxAgeMin: 600 }), true);
  const fresh = [{ source: 's', title: 't', at: '2026-08-27T13:50:00Z' }];
  assert.equal(shouldFlush(fresh, { now: NIGHT, maxAgeMin: 600 }), false);
});

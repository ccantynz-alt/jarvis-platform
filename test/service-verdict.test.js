/**
 * test/service-verdict.test.js — telling a deploy apart from a death.
 *
 * From production, not from imagination: the self-watch shipped on the morning of
 * 2026-07-30 pushed a device ALERT at 09:03:21 for jarvis-browser, and the journal
 * shows a clean `Stopping / Deactivated successfully / Stopped` at 09:02:32 with
 * `Started` at 09:03:22 — a deploy restart of mine. The threshold is 2 checks at
 * 30s and its comment claims that "rides out a restart"; checks land on fixed
 * boundaries, so a 50-second gap covers two of them. Every slow deploy would have
 * buzzed his phone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { serviceVerdict, VERDICT_POLICY } from '../src/lib/service-verdict.js';

test('a healthy port is ok whatever systemd says', () => {
  assert.equal(serviceVerdict({ portDown: false, active: 'failed', sub: 'dead' }), 'ok');
});

test('a restart in progress is not a fault — the 09:03 case', () => {
  assert.equal(serviceVerdict({ portDown: true, active: 'activating', sub: 'start' }), 'restarting');
  assert.equal(serviceVerdict({ portDown: true, active: 'deactivating', sub: 'stop' }), 'restarting');
  assert.equal(serviceVerdict({ portDown: true, active: 'activating', sub: 'auto-restart' }), 'restarting');
  for (const v of ['restarting']) assert.equal(VERDICT_POLICY[v].alert, false, 'and it must not alert');
});

test('a failed unit alerts immediately, without waiting out a streak', () => {
  assert.equal(serviceVerdict({ portDown: true, active: 'failed', sub: 'failed' }), 'failed');
  assert.equal(VERDICT_POLICY.failed.alert, true);
  assert.equal(VERDICT_POLICY.failed.immediate, true, 'systemd has already given up — waiting 60s proves nothing');
  assert.equal(VERDICT_POLICY.failed.level, 'alert');
});

test('a deliberately stopped unit is a warning, not an emergency', () => {
  assert.equal(serviceVerdict({ portDown: true, active: 'inactive', sub: 'dead' }), 'stopped');
  assert.equal(VERDICT_POLICY.stopped.level, 'warn', 'someone stopped it on purpose; do not wake him for it');
  assert.equal(VERDICT_POLICY.stopped.alert, true, 'but do not be silent either');
});

test('running-but-not-serving is the dangerous case, and still needs the streak', () => {
  // A live process that has stopped answering. Ambiguous enough that one missed
  // probe should not fire, which is exactly what the streak is for.
  assert.equal(serviceVerdict({ portDown: true, active: 'active', sub: 'running' }), 'notlistening');
  assert.equal(VERDICT_POLICY.notlistening.immediate, false);
  assert.equal(VERDICT_POLICY.notlistening.level, 'alert');
});

test('an unreadable systemd answer falls through to the cautious case', () => {
  // safeExec returns '' when systemctl is unavailable or the unit is unknown.
  // Falling through to 'notlistening' keeps the old streak-based behaviour rather
  // than silently deciding everything is fine.
  assert.equal(serviceVerdict({ portDown: true }), 'notlistening');
  assert.equal(serviceVerdict({ portDown: true, active: '', sub: '' }), 'notlistening');
  assert.equal(serviceVerdict({ portDown: true, active: 'nonsense' }), 'notlistening');
});

test('systemd values are matched case-insensitively and trimmed', () => {
  // `systemctl show` output is parsed with a regex; a stray \r or capital must not
  // turn a restart into a page.
  assert.equal(serviceVerdict({ portDown: true, active: 'Activating\r', sub: '' }), 'restarting');
  assert.equal(serviceVerdict({ portDown: true, active: ' FAILED ', sub: '' }), 'failed');
});

test('every verdict has a policy, so an unknown key can never be undefined', () => {
  for (const v of ['ok', 'restarting', 'failed', 'stopped', 'notlistening']) {
    assert.ok(VERDICT_POLICY[v], `${v} needs a policy`);
  }
});

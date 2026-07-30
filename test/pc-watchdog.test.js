// test/pc-watchdog.test.js — the PC worker's off-box watchdog, 2026-07-30.
//
// Craig's PC already talks to the gateway every 10 seconds from outside the
// fleet, which makes it the lowest-latency box-death detector available. It is
// needed because the GitHub Actions watchdog asks for every 5 minutes and
// measurably gets about once an hour.
//
// The risk is not missing an outage, it is crying wolf: a failed claim usually
// means his wifi dropped or tailscale restarted, not that the box died. Blaming
// the box for his own network would be the alert that teaches him to ignore
// alerts, so the three-way classification is what actually matters here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutage } from '../src/pc-worker.js';

test('nothing wrong when the gateway answers', () => {
  assert.equal(classifyOutage({ gatewayOk: true, publicOk: false, internetOk: false }), 'ok',
    'a working gateway settles it — the other probes do not matter');
});

test('no internet from this PC blames nothing — it is our end', () => {
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: false, internetOk: false }), 'local');
});

test('internet fine, public port dead = the box really is down', () => {
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: false, internetOk: true }), 'box-down');
});

test('public port answers but the gateway does not = tailnet or service, box alive', () => {
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: true, internetOk: true }), 'tailnet');
});

test('a dead public port with no internet is still LOCAL, never box-down', () => {
  // The dangerous misread: both probes fail because the PC is offline, and we
  // announce a box death that never happened.
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: false, internetOk: false }), 'local');
});

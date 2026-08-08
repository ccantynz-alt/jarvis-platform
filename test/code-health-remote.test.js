// Remote sweeps (2026-08-08): vapron's code lives on box 158 and is reviewed
// THERE over tailnet SSH — no product source on the master (governance), no
// Jarvis service on 158 (estate doctrine). These tests pin the routing logic:
// which platforms sweep remotely, and that the source check still gates them
// ("a path is a claim", on any machine — the zoobicon lesson, remoted).

import test from 'node:test';
import assert from 'node:assert/strict';
import { remoteFor, eligiblePlatforms } from '../src/code-health.js';

const OWN = '66.42.121.161';

test('remoteFor routes an allowlisted off-box platform to its server', () => {
  const allow = new Set(['vapron']);
  assert.equal(remoteFor('vapron', { server: '100.89.227.39' }, { ownIp: OWN, allow }), '100.89.227.39');
});

test('remoteFor refuses everything the allowlist does not name', () => {
  const allow = new Set(['vapron']);
  // off-box but not allowlisted — a full-permission spawn on the wrong machine
  assert.equal(remoteFor('mystery', { server: '100.89.227.39' }, { ownIp: OWN, allow }), null);
});

test('remoteFor refuses non-IP servers and the local box', () => {
  const allow = new Set(['vapron', 'marcoreid', 'jarvis']);
  assert.equal(remoteFor('marcoreid', { server: 'vercel' }, { ownIp: OWN, allow }), null);
  assert.equal(remoteFor('jarvis', { server: OWN }, { ownIp: OWN, allow }), null);
  assert.equal(remoteFor('vapron', {}, { ownIp: OWN, allow }), null);
});

test('a remote platform is eligible only when its remote path holds source', () => {
  const registry = {
    vapron: { status: 'active', server: '100.89.227.39', path: '/opt/vapron' },
    jarvis: { status: 'active', server: OWN, path: '/opt/jarvis' },
  };
  const opts = {
    ownIp: OWN,
    skip: new Set(),
    allowRemote: new Set(['vapron']),
    exists: () => true,
    source: () => true,
    remoteSource: () => true,
  };
  assert.deepEqual(eligiblePlatforms(registry, opts), ['jarvis', 'vapron']);
  // remote box unreachable or path empty → vapron drops out, never silently swept
  assert.deepEqual(eligiblePlatforms(registry, { ...opts, remoteSource: () => false }), ['jarvis']);
});

test('a remote platform must still be allowlisted to be eligible at all', () => {
  const registry = { vapron: { status: 'active', server: '100.89.227.39', path: '/opt/vapron' } };
  const opts = {
    ownIp: OWN, skip: new Set(), allowRemote: new Set(),
    exists: () => true, source: () => true,
    remoteSource: () => { throw new Error('must not even be probed'); },
  };
  assert.deepEqual(eligiblePlatforms(registry, opts), []);
});

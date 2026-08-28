// Which platforms the fleet actually watches (src/lib/fleet-targets.js),
// 2026-08-28.
//
// fleet-check.sh is the only thing that notices a platform is down, and
// self-heal only ever acts on the status it writes. A platform missing from
// its list is not monitored at all — and says nothing, because an absence
// cannot alarm. So the regression tests here are the three drifts that were
// live in the hardcoded list on the day it was replaced.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { fleetTargets, formatTargets, isWatched } from '../src/lib/fleet-targets.js';

const registry = JSON.parse(readFileSync(new URL('../config/platforms.json', import.meta.url), 'utf8'));
const names = (reg) => fleetTargets(reg).map(t => t.name);
const urlFor = (reg, n) => fleetTargets(reg).find(t => t.name === n)?.url;

// ── the drifts that were live on 2026-08-28 ─────────────────────────────────

test('marco-demo is watched — it was registered at birth and never once probed', () => {
  // Born 2026-08-25 with a site_url; platform_state still read
  // `unknown / health 0 / 2026-08-25T13:41` three days later.
  assert.ok(names(registry).includes('marco-demo'));
  assert.equal(urlFor(registry, 'marco-demo'), 'https://marco-demo.vapron.app');
});

test('every probe row traces to a registry key — no more phantom gatetest-mcp', () => {
  const keys = new Set(Object.keys(registry.platforms));
  for (const t of fleetTargets(registry)) {
    assert.ok(keys.has(t.platform), `${t.name} came from unregistered ${t.platform}`);
  }
});

test('gatetest-mcp survives the move, as a probe gatetest DECLARES', () => {
  // Preserved deliberately: dropping a live probe silently is how monitoring
  // disappears. Now one registry line owns it instead of a line in a script.
  const mcp = fleetTargets(registry).find(t => t.name === 'gatetest-mcp');
  assert.ok(mcp, 'gatetest-mcp probe lost in the migration');
  assert.equal(mcp.platform, 'gatetest');
  assert.ok(names(registry).includes('gatetest'), 'declaring probes must not drop the site itself');
});

test('davenroe is probed at the URL the registry declares, not a second spelling', () => {
  assert.equal(urlFor(registry, 'davenroe'), registry.platforms.davenroe.site_url);
});

// ── the public-presence rule ────────────────────────────────────────────────

test('site_url wins over health_url — the fleet number is what a customer sees', () => {
  // vapron carries both. Preferring its tailnet health endpoint would make
  // the headline "vapron healthy" true of something no customer can reach.
  assert.equal(urlFor(registry, 'vapron'), 'https://vapron.ai');
  assert.ok(registry.platforms.vapron.health_url, 'vapron still declares a health_url');
});

test('health_url is the fallback for a platform with no public face', () => {
  assert.equal(urlFor(registry, 'jarvis'), 'http://127.0.0.1:9206/health');
});

// ── who is excluded, and why that is not a silent drop ──────────────────────

test('monitor:false opts a non-product out; craig-pc and sourceless entries never enter', () => {
  assert.equal(isWatched({ status: 'active', monitor: false }), false);
  assert.equal(isWatched({ status: 'retired' }), false);
  assert.equal(isWatched({ status: 'active' }), true);
  const n = names(registry);
  for (const skip of ['screenshot-to-code', 'universal-ai-operator', 'craig-pc']) {
    assert.ok(!n.includes(skip), `${skip} is not a fleet product`);
  }
});

test('a platform with no probeable URL is skipped, not probed as ""', () => {
  const reg = { platforms: { ghost: { status: 'active' }, real: { status: 'active', site_url: 'https://x.test' } } };
  assert.deepEqual(names(reg), ['real']);
  assert.deepEqual(names({ platforms: { bad: { status: 'active', site_url: 'not-a-url' } } }), []);
});

// ── invariants the shell script depends on ──────────────────────────────────

test('one row is written at most once per tick', () => {
  // Two conflicting writes to one platform_state row in a single tick is the
  // last-writer-wins trap; the second declaration is dropped, not merged.
  const reg = {
    platforms: {
      a: { status: 'active', probes: { dup: 'https://one.test' } },
      b: { status: 'active', probes: { dup: 'https://two.test' } },
    },
  };
  assert.deepEqual(fleetTargets(reg).map(t => t.url), ['https://one.test']);
});

test('formatTargets emits the name|url lines fleet-check.sh parses', () => {
  const line = formatTargets(fleetTargets(registry)).split('\n');
  assert.ok(line.length >= 10, 'the real registry should yield the whole fleet');
  for (const l of line) assert.match(l, /^[a-z0-9-]+\|https?:\/\/\S+$/);
});

test('an unreadable or empty registry yields nothing — the caller must shout', () => {
  assert.deepEqual(fleetTargets(null), []);
  assert.deepEqual(fleetTargets({}), []);
  assert.deepEqual(fleetTargets({ platforms: {} }), []);
});

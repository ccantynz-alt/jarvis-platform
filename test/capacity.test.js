import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSlots, ceilingFor } from '../src/lib/capacity.js';

const idle = { load1: 0.5, cores: 4, freeMemGB: 4.0 };
const busy = { load1: 3.2, cores: 4, freeMemGB: 1.2 };

test('ceiling: base 4, extends to 6 only when clearly idle, floors at 1 under pressure', () => {
  assert.equal(ceilingFor({ load1: 2.0, cores: 4, freeMemGB: 2.0 }), 4);   // normal
  assert.equal(ceilingFor(idle), 6);                                        // load/core<0.4 && >3GB
  assert.equal(ceilingFor(busy), 1);                                        // load/core>0.7 || <1.5GB
});

test('slots scale with backlog under the ceiling', () => {
  assert.equal(computeSlots({ queued: 0, running: 0, ...idle }), 0);        // nothing to do
  assert.equal(computeSlots({ queued: 2, running: 0, ...idle }), 1);        // ceil(2/2)=1
  assert.equal(computeSlots({ queued: 20, running: 0, ...idle }), 6);       // capped at ceiling
  assert.equal(computeSlots({ queued: 20, running: 6, ...idle }), 0);       // ceiling full
});

test('pressure only stops NEW slots — running jobs are never negative-counted', () => {
  assert.equal(computeSlots({ queued: 20, running: 3, ...busy }), 0);       // ceiling 1 < running 3 → 0, not -2
});

test('fixed env override bypasses adaptation entirely', () => {
  assert.equal(computeSlots({ queued: 20, running: 1, ...busy, fixed: 3 }), 2);
});

// The registry and roadmap are load-bearing config read by every service and
// every session. A trailing comma or a drifted twin is a silent estate-wide
// fault — pin the invariants that the 2026-08-08 registry-truth pass fixed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

test('platforms.json parses and carries the corrected registry truth', () => {
  const pf = read('../config/platforms.json');
  assert.equal(pf.platforms.gatetest.path, '/opt/gatetest');       // was /root/gatetest
  assert.match(pf.platforms.gatetest.repo, /crclabs-hq\/GateTest/); // was ccantynz-alt/gatetest
  assert.ok(pf.platforms.vapron.health_url, 'vapron needs a health_url (roadmap move 16 residual)');
});

test('roadmap.json parses and its ESTATE phase is complete', () => {
  const rm = read('../config/roadmap.json');
  assert.ok(Array.isArray(rm.phases));
  const estate = rm.phases.find(p => p.name === 'ESTATE');
  assert.ok(estate, 'ESTATE phase missing');
  assert.equal(estate.moves.length, 6);
  // every move has the fields the deck's roadmap checklist reads
  for (const p of rm.phases) for (const m of p.moves) {
    assert.equal(typeof m.id, 'number');
    assert.ok(m.title && m.status);
  }
});

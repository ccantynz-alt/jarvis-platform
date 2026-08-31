import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, capVerdict, parseMarcoEnv, OUTCOMES } from '../src/lib/marco.js';

test('normalizeEvent accepts a minimal valid event and fills defaults', () => {
  const r = normalizeEvent({ agent: 'self-heal', platform: 'vapron', action: 'restarted unit', outcome: 'fixed' });
  assert.equal(r.ok, true);
  assert.equal(r.event.host, 'vultr');           // default host
  assert.equal(r.event.detail, '');
  assert.equal(r.event.tags, '');
});

test('normalizeEvent rejects missing agent/action and bad outcome', () => {
  assert.equal(normalizeEvent({ platform: 'x', action: 'y', outcome: 'ok' }).ok, false);
  assert.equal(normalizeEvent({ agent: 'a', platform: 'x', outcome: 'ok' }).ok, false);
  assert.equal(normalizeEvent({ agent: 'a', platform: 'x', action: 'y', outcome: 'great' }).ok, false);
  assert.ok(OUTCOMES.includes('blocked'));
});

test('normalizeEvent clamps detail to 2048 chars and redacts secrets', () => {
  const r = normalizeEvent({ agent: 'a', platform: 'box', action: 'x', outcome: 'ok',
    detail: 'key sk-ant-abcdefghijk1234567890 ' + 'z'.repeat(3000) });
  assert.equal(r.event.detail.length <= 2048, true);
  assert.equal(r.event.detail.includes('sk-ant-abcdefghijk'), false);
});

test('normalizeEvent normalizes tags: lowercase, trimmed, deduped, comma-joined', () => {
  const r = normalizeEvent({ agent: 'a', platform: 'box', action: 'x', outcome: 'ok',
    tags: ['Deploy', ' deploy ', 'SSH'] });
  assert.equal(r.event.tags, 'deploy,ssh');
});

test('capVerdict: allowed under cap, warns exactly at cap, silent-drops past cap', () => {
  assert.deepEqual(capVerdict(10, 200), { allowed: true, warn: false });
  assert.deepEqual(capVerdict(200, 200), { allowed: false, warn: true });
  assert.deepEqual(capVerdict(201, 200), { allowed: false, warn: false });
});

test('parseMarcoEnv: defaults, valid values, junk falls back safe', () => {
  assert.deepEqual(parseMarcoEnv(''), { mode: 'off', janitor: 'report', eventCap: 200 });
  const t = 'MARCO_MODE=observe\nJANITOR_MODE=clean\nMARCO_EVENT_CAP=500\n';
  assert.deepEqual(parseMarcoEnv(t), { mode: 'observe', janitor: 'clean', eventCap: 500 });
  // inline comment poisons the value (systemd lesson) -> falls back, not NaN
  assert.equal(parseMarcoEnv('MARCO_EVENT_CAP=500 # cap').eventCap, 200);
  assert.equal(parseMarcoEnv('MARCO_MODE=banana').mode, 'off');
});

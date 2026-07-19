import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotifyCenter, parseDuration } from '../src/notify-center.js';

// Noon NZ (not quiet) and midnight NZ (quiet) as fixed instants, winter (UTC+12)
const NOON_NZ = Date.parse('2026-07-12T00:00:00Z');
const MIDNIGHT_NZ = Date.parse('2026-07-12T12:00:00Z');

function makeCenter(overrides = {}) {
  const sent = [];
  let t = overrides.startAt ?? NOON_NZ;
  const center = new NotifyCenter({
    send: async (text) => { sent.push(text); },
    now: () => t,
    statePath: null,
    digestIntervalMs: 30 * 60 * 1000,
    dedupeCooldownMs: 30 * 60 * 1000,
    maxImmediatePerHour: 3,
    quietHours: { start: 22, end: 7 },
    timeZone: 'Pacific/Auckland',
    ...overrides.opts,
  });
  return { center, sent, tick: (ms) => { t += ms; }, setTime: (ts) => { t = ts; } };
}

test('info never posts immediately, lands in the digest', async () => {
  const { center, sent } = makeCenter();
  const r = await center.notify({ text: 'zoobicon audit clean', level: 'info' });
  assert.equal(r.action, 'queued');
  assert.equal(sent.length, 0);
  await center.flushDigest({ force: true });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Jarvis digest — 1 update/);
  assert.match(sent[0], /zoobicon audit clean/);
});

test('warning posts immediately, repeat within cooldown is deduped', async () => {
  const { center, sent, tick } = makeCenter();
  assert.equal((await center.notify({ text: 'vapron slow', level: 'warning', key: 'k1' })).action, 'sent');
  tick(5 * 60 * 1000);
  assert.equal((await center.notify({ text: 'vapron slow', level: 'warning', key: 'k1' })).action, 'queued');
  assert.equal(sent.length, 1);
  // After the cooldown it may post again
  tick(31 * 60 * 1000);
  assert.equal((await center.notify({ text: 'vapron slow', level: 'warning', key: 'k1' })).action, 'sent');
});

test('rate limit demotes to digest and warns exactly once', async () => {
  const { center, sent } = makeCenter();
  for (let i = 0; i < 3; i++) {
    await center.notify({ text: `alert ${i}`, level: 'warning', key: `k${i}` });
  }
  assert.equal(sent.length, 3);
  const r = await center.notify({ text: 'alert 3', level: 'warning', key: 'k3' });
  assert.equal(r.action, 'queued');
  assert.equal(r.reason, 'rate-limit');
  // exactly one rate-limit notice was posted
  assert.equal(sent.filter(s => s.includes('rate limit')).length, 1);
  await center.notify({ text: 'alert 4', level: 'warning', key: 'k4' });
  assert.equal(sent.filter(s => s.includes('rate limit')).length, 1);
});

test('mute holds warnings but critical still gets through', async () => {
  const { center, sent } = makeCenter();
  center.mute(null);
  assert.equal((await center.notify({ text: 'warn', level: 'warning' })).action, 'queued');
  assert.equal((await center.notify({ text: 'boom', level: 'critical', key: 'c1' })).action, 'sent');
  assert.deepEqual(sent, ['boom']);
});

test('mute all holds critical too', async () => {
  const { center, sent } = makeCenter();
  center.mute(null, { all: true });
  assert.equal((await center.notify({ text: 'boom', level: 'critical' })).action, 'queued');
  assert.equal(sent.length, 0);
});

test('timed mute expires', async () => {
  const { center, tick } = makeCenter();
  center.mute(10 * 60 * 1000);
  assert.equal(center.isMuted(), true);
  tick(11 * 60 * 1000);
  assert.equal(center.isMuted(), false);
});

test('quiet hours hold warnings, digest does not flush at night', async () => {
  const { center, sent, tick } = makeCenter({ startAt: MIDNIGHT_NZ });
  const r = await center.notify({ text: 'nocturnal warn', level: 'warning' });
  assert.equal(r.action, 'queued');
  assert.equal(r.reason, 'quiet-hours');
  tick(31 * 60 * 1000);
  assert.equal(center.digestDue(), false); // still night in NZ
  assert.equal(sent.length, 0);
});

test('critical bypasses quiet hours', async () => {
  const { center, sent } = makeCenter({ startAt: MIDNIGHT_NZ });
  assert.equal((await center.notify({ text: 'site down', level: 'critical' })).action, 'sent');
  assert.equal(sent.length, 1);
});

test('digest counts repeats', async () => {
  const { center, sent } = makeCenter();
  for (let i = 0; i < 3; i++) await center.notify({ text: 'same thing', level: 'info', key: 'dup' });
  await center.flushDigest({ force: true });
  assert.match(sent[0], /×3/);
});

test('state persists across restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-test-'));
  const statePath = join(dir, 'state.json');
  try {
    const a = new NotifyCenter({ send: async () => {}, now: () => NOON_NZ, statePath });
    a.mute(null);
    await a.notify({ text: 'queued while muted', level: 'warning' });

    const b = new NotifyCenter({ send: async () => {}, now: () => NOON_NZ, statePath });
    assert.equal(b.isMuted(), true);
    assert.equal(b.digestQueue.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseDuration', () => {
  assert.equal(parseDuration('mute 2h'), 2 * 60 * 60 * 1000);
  assert.equal(parseDuration('mute for 30 min'), 30 * 60 * 1000);
  assert.equal(parseDuration('mute 1 day'), 24 * 60 * 60 * 1000);
  assert.equal(parseDuration('mute'), null);
});

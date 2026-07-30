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

// ── A failed digest must not be lost (2026-07-30) ────────────────────────────
// flushDigest used to splice the whole queue out and persist the emptied state
// BEFORE attempting the send, so a Slack outage discarded up to 200 batched
// notifications from memory and from disk. The only caller is a 60s timer whose
// handler is `.catch(console.error)`, so nothing downstream noticed either.

test('a digest whose send fails is kept and retried, not discarded', async () => {
  let fail = true;
  const sent = [];
  const center = new NotifyCenter({
    send: async (text) => { if (fail) throw new Error('slack is down'); sent.push(text); },
    now: () => NOON_NZ,
    statePath: null,
    digestIntervalMs: 30 * 60 * 1000,
  });

  await center.notify({ level: 'info', text: 'audit finished on zoobicon' });
  await center.notify({ level: 'info', text: 'audit finished on vapron' });

  await assert.rejects(() => center.flushDigest({ force: true }), /slack is down/);
  assert.equal(center.digestQueue.length, 2, 'the items are still queued after a failed send');

  fail = false;
  await center.flushDigest({ force: true });
  assert.equal(center.digestQueue.length, 0, 'and they go out on the retry');
  assert.match(sent[0], /zoobicon/);
  assert.match(sent[0], /vapron/);
});

test('anything queued while the send is in flight survives the flush', async () => {
  const sent = [];
  let center;
  center = new NotifyCenter({
    // Arrives DURING the await, exactly like a real notify landing mid-post.
    send: async (text) => { await center.notify({ level: 'info', text: 'arrived late' }); sent.push(text); },
    now: () => NOON_NZ,
    statePath: null,
    digestIntervalMs: 30 * 60 * 1000,
  });

  await center.notify({ level: 'info', text: 'first' });
  await center.flushDigest({ force: true });

  assert.match(sent[0], /first/);
  assert.equal(center.digestQueue.length, 1, 'the late arrival is still queued for the next digest');
  assert.match(center.digestQueue[0].text, /arrived late/);
});

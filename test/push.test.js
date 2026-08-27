// test/push.test.js — device push, 2026-07-30.
//
// This is the only notification path that works when nothing of Craig's is open,
// so its failure modes matter more than most: a channel that silently delivers
// nothing (the off-box watchdog's whole history) and a channel that buzzes so
// often he mutes it (the Slack firehose) are both total failures. Both are
// tested here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pushAlert, hasPush, _reset, _setKv } from '../src/lib/push.js';

const ENV = ['NTFY_TOPIC', 'NTFY_SERVER', 'NTFY_TOKEN', 'PUSH_MIN_LEVEL', 'PUSH_DISABLED',
  'PUSH_CLICK_URL', 'PUSH_MAX_PER_HOUR', 'PUSH_DEDUPE_MINUTES', 'PUSH_ALERT_DEDUPE_HOURS',
  'ALERT_QUIET_START', 'ALERT_QUIET_END', 'ALERT_HOLD_MAX_MINUTES'];

test.beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  // Quiet hours OFF for the cases below (2026-08-27). They existed before the
  // smart layer and assert on delivery, so leaving quiet hours at their real
  // default would make every warn-level test in this file pass or fail
  // depending on WHAT TIME OF DAY it ran — the worst kind of flake, because it
  // is green all afternoon. The hold behaviour has its own tests further down,
  // which turn it on deliberately.
  process.env.ALERT_QUIET_START = '0';
  process.env.ALERT_QUIET_END = '0';
  _reset();
});
test.afterEach(() => { for (const k of ENV) delete process.env[k]; });

// Capture what would go over the wire.
function capture(status = 200) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), ...opts });
    return Promise.resolve({ ok: status < 400, status });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const quiet = async (fn) => {
  const real = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = real; }
};

test('with no topic configured it does nothing and says so', async () => {
  const f = capture();
  try {
    assert.equal(hasPush(), false);
    const r = await quiet(() => pushAlert({ level: 'alert', title: 'box is down' }));
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-topic');
    assert.equal(f.calls.length, 0, 'and never pretends by posting somewhere');
  } finally { f.restore(); }
});

test('a warning reaches the topic with a high priority', async () => {
  process.env.NTFY_TOPIC = 'jarvis-secret-topic';
  const f = capture();
  try {
    const r = await pushAlert({ level: 'warn', title: 'vapron down', body: 'two checks missed', source: 'fleet-check' });
    assert.equal(r.sent, true);
    assert.equal(f.calls.length, 1);
    const c = f.calls[0];
    assert.equal(c.url, 'https://ntfy.sh/jarvis-secret-topic');
    assert.equal(c.method, 'POST');
    assert.equal(c.headers.Title, 'vapron down');
    assert.equal(c.headers.Priority, '4');
    assert.match(c.body, /two checks missed/);
    assert.match(c.body, /fleet-check/, 'the body names the subsystem that raised it');
  } finally { f.restore(); }
});

test('an alert goes out at max priority', async () => {
  process.env.NTFY_TOPIC = 't';
  const f = capture();
  try {
    await pushAlert({ level: 'alert', title: 'brain outage' });
    assert.equal(f.calls[0].headers.Priority, '5');
    assert.equal(f.calls[0].headers.Tags, 'rotating_light');
  } finally { f.restore(); }
});

test('info is held back by default — a phone that buzzes for chatter gets muted', async () => {
  process.env.NTFY_TOPIC = 't';
  const f = capture();
  try {
    const r = await pushAlert({ level: 'info', title: 'audit finished' });
    assert.equal(r.reason, 'below-min-level');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('PUSH_MIN_LEVEL=info opts into everything', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.PUSH_MIN_LEVEL = 'info';
  const f = capture();
  try {
    assert.equal((await pushAlert({ level: 'info', title: 'audit finished' })).sent, true);
    assert.equal(f.calls[0].headers.Priority, '2');
  } finally { f.restore(); }
});

test('a repeated headline is deduped, but a real alert always gets through', async () => {
  process.env.NTFY_TOPIC = 't';
  const f = capture();
  try {
    assert.equal((await pushAlert({ level: 'warn', title: 'same thing' })).sent, true);
    assert.equal((await pushAlert({ level: 'warn', title: 'same thing' })).reason, 'deduped');
    assert.equal((await pushAlert({ level: 'warn', title: 'other thing' })).sent, true);
    assert.equal((await pushAlert({ level: 'alert', title: 'same thing' })).sent, true,
      'an emergency repeating IS the signal');
  } finally { f.restore(); }
});

test('the hourly cap sheds warnings but never alerts', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.PUSH_MAX_PER_HOUR = '2';
  const f = capture();
  try {
    assert.equal((await pushAlert({ level: 'warn', title: 'one' })).sent, true);
    assert.equal((await pushAlert({ level: 'warn', title: 'two' })).sent, true);
    // 'rate-capped-held' since 2026-08-27: overflow is queued for the digest
    // rather than dropped. The cap itself is unchanged — nothing extra is SENT.
    assert.equal((await pushAlert({ level: 'warn', title: 'three' })).reason, 'rate-capped-held');
    assert.equal((await pushAlert({ level: 'alert', title: 'the box is on fire' })).sent, true);
  } finally { f.restore(); }
});

test('a malformed cap does not remove the cap (the 2026-07-17 lesson)', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.PUSH_MAX_PER_HOUR = '2 # per hour';   // systemd keeps the comment
  const f = capture();
  try {
    await quiet(async () => {
      assert.equal((await pushAlert({ level: 'warn', title: 'one' })).sent, true);
      assert.equal((await pushAlert({ level: 'warn', title: 'two' })).sent, true);
      assert.equal((await pushAlert({ level: 'warn', title: 'three' })).reason, 'rate-capped-held');
    });
  } finally { f.restore(); }
});

test('PUSH_DISABLED=1 is a complete kill switch', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.PUSH_DISABLED = '1';
  const f = capture();
  try {
    assert.equal(hasPush(), false);
    assert.equal((await pushAlert({ level: 'alert', title: 'x' })).reason, 'disabled');
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('a self-hosted server and token are honoured', async () => {
  process.env.NTFY_TOPIC = 'topic';
  process.env.NTFY_SERVER = 'https://push.example.com/';
  process.env.NTFY_TOKEN = 'tk_abc';
  process.env.PUSH_CLICK_URL = 'https://jarvis.example/deck';
  const f = capture();
  try {
    await pushAlert({ level: 'warn', title: 'x' });
    assert.equal(f.calls[0].url, 'https://push.example.com/topic', 'no double slash');
    assert.equal(f.calls[0].headers.Authorization, 'Bearer tk_abc');
    // The Click now carries the deck tab that answers the alert (move 32):
    // a notification with nowhere to tap is one he has to navigate at 3am.
    assert.equal(f.calls[0].headers.Click, 'https://jarvis.example/deck?view=hud');
  } finally { f.restore(); }
});

test('an emoji in the title cannot take out the channel', async () => {
  process.env.NTFY_TOPIC = 't';
  const f = capture();
  try {
    // HTTP headers are latin-1; undici throws ERR_INVALID_CHAR on an emoji, so a
    // decorative character in a title would kill the alert instead of sending it.
    const r = await pushAlert({ level: 'alert', title: '🔴 vapron is down' });
    assert.equal(r.sent, true);
    // The control characters are the point: an ntfy Title header must be
    // latin-1, and this asserts nothing outside \x00-\xFF survived. An emoji here
    // makes Node throw ERR_INVALID_CHAR, which is why asciiHeader() exists.
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(f.calls[0].headers.Title, /[^\x00-\xFF]/);
    assert.match(f.calls[0].headers.Title, /vapron is down/);
  } finally { f.restore(); }
});

test('a dead relay is reported, not thrown', async () => {
  process.env.NTFY_TOPIC = 't';
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error('ENOTFOUND'));
  try {
    const r = await quiet(() => pushAlert({ level: 'alert', title: 'x' }));
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'error');
  } finally { globalThis.fetch = real; }
});

test('an HTTP refusal is reported with its status', async () => {
  process.env.NTFY_TOPIC = 't';
  const f = capture(403);
  try {
    const r = await quiet(() => pushAlert({ level: 'alert', title: 'x' }));
    assert.equal(r.sent, false);
    assert.equal(r.status, 403);
  } finally { f.restore(); }
});

// ── Level contract ───────────────────────────────────────────────────────────
// Found by the code-health spine's first sweep: orchestrator.js and
// agent-scheduler.js raise level:'error', which is not in notify()'s contract.
// The old coercion sent it to 'info' — below the default threshold — so "job
// failed" was precisely the alert that never reached a device.

test('an off-contract level resolves UP to warn, not down into silence', async () => {
  process.env.NTFY_TOPIC = 't';
  const f = capture();
  try {
    const r = await quiet(() => pushAlert({ level: 'error', title: 'job failed on vapron' }));
    assert.equal(r.sent, true, "'error' must not vanish below the min level");
    assert.equal(f.calls[0].headers.Priority, '4');
  } finally { f.restore(); }
});

test('notify normalises the synonyms callers actually use', async () => {
  const { normalizeLevel } = await import('../src/lib/notify.js');
  assert.equal(normalizeLevel('error'), 'alert');
  assert.equal(normalizeLevel('critical'), 'alert');
  assert.equal(normalizeLevel('warning'), 'warn');
  assert.equal(normalizeLevel('INFO'), 'info');
  assert.equal(await quiet(() => normalizeLevel('spicy')), 'warn', 'an invented level is heard, not dropped');
  assert.equal(await quiet(() => normalizeLevel(undefined)), 'warn');
});

// ── A persistent problem should REMIND, not repeat (2026-07-30) ──────────────
// 'alert' used to be exempt from dedupe entirely. That reasoning held for
// self-heal, which caps its own retries, and not for the agent org, which re-runs
// on cron and re-escalates anything still unfixed. social-media-voxlen escalated
// the identical "voxlen.com is a parked for-sale page" at alert level on 19, 20,
// 21, 22 and 23 July — five identical max-priority pushes, and it would have kept
// going for the eleven days the issue has now lasted. Priority 5 bypasses Do Not
// Disturb by design, so that is precisely what makes someone mute the one channel
// that works.

test('an identical alert does not repeat every time an agent re-runs', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.PUSH_ALERT_DEDUPE_HOURS = '6';
  const f = capture();
  try {
    const title = 'voxlen.com redirects to a GoDaddy for-sale page';
    assert.equal((await pushAlert({ level: 'alert', title })).sent, true, 'the first one must arrive');
    assert.equal((await pushAlert({ level: 'alert', title })).reason, 'deduped',
      "tomorrow's identical re-escalation must not buzz again inside the window");
    assert.equal(f.calls.length, 1, 'exactly one push left the box');
  } finally { f.restore(); delete process.env.PUSH_ALERT_DEDUPE_HOURS; }
});

test('distinct alerts are never suppressed by another alert', async () => {
  // Dedupe is per-headline, so an unfolding incident still arrives in full.
  process.env.NTFY_TOPIC = 't';
  const f = capture();
  try {
    assert.equal((await pushAlert({ level: 'alert', title: 'memory is not listening' })).sent, true);
    assert.equal((await pushAlert({ level: 'alert', title: 'orchestrator is not listening' })).sent, true);
    assert.equal((await pushAlert({ level: 'alert', title: 'the disk is full' })).sent, true);
    assert.equal(f.calls.length, 3);
  } finally { f.restore(); }
});

test('an escalation from warn to alert is new information and gets through', async () => {
  // The severity change IS the news, so dedupe keys on level as well as headline.
  process.env.NTFY_TOPIC = 't';
  const f = capture();
  try {
    const title = 'gatetest is unreachable';
    assert.equal((await pushAlert({ level: 'warn', title })).sent, true);
    assert.equal((await pushAlert({ level: 'warn', title })).reason, 'deduped');
    assert.equal((await pushAlert({ level: 'alert', title })).sent, true, 'it got worse — say so');
    assert.equal((await pushAlert({ level: 'alert', title })).reason, 'deduped', 'but only once');
  } finally { f.restore(); }
});

// ── Durable caps across processes (2026-08-19, audit move 7) ────────────────
// The dedupe window and hourly cap used to be per-process, so a oneshot timer
// (a fresh process every tick) hit neither. With a shared KV store, a SECOND
// process sees the FIRST process's push and dedupes it.
test('a repeat from a different process is deduped via shared KV', async () => {
  const store = new Map();
  const shared = { get: async (k) => (store.has(k) ? store.get(k) : null), set: async (k, v) => { store.set(k, v); } };
  const a = capture();
  process.env.NTFY_TOPIC = 'topic';
  _setKv(shared);
  await quiet(() => pushAlert({ level: 'warn', title: 'vapron down', body: 'x' }));
  a.restore();
  assert.equal(a.calls.length, 1, 'first process sends');

  // Simulate a fresh oneshot process: clear in-process state, keep the KV store.
  _reset();
  _setKv(shared);
  const b = capture();
  process.env.NTFY_TOPIC = 'topic';
  const r = await quiet(() => pushAlert({ level: 'warn', title: 'vapron down', body: 'x' }));
  b.restore();
  assert.equal(r.reason, 'deduped');
  assert.equal(b.calls.length, 0, 'second process is capped by the first process\'s push');
});

test('an escalation from another process still breaks through the shared dedupe', async () => {
  const store = new Map();
  const shared = { get: async (k) => (store.has(k) ? store.get(k) : null), set: async (k, v) => { store.set(k, v); } };
  process.env.NTFY_TOPIC = 'topic';
  _setKv(shared);
  await quiet(() => pushAlert({ level: 'warn', title: 'disk', body: 'x' }));
  _reset(); _setKv(shared); process.env.NTFY_TOPIC = 'topic';
  const c = capture();
  const r = await quiet(() => pushAlert({ level: 'alert', title: 'disk', body: 'x' }));
  c.restore();
  assert.equal(r.sent, true, 'same headline at a higher level is new information');
});

// ── Two transports, one set of gates (2026-08-27) ───────────────────────────
//
// Web Push to the deck PWA was added beside ntfy so that Craig's iPhone and
// iPad can be reached without a second app. The risk in adding a transport is
// that it becomes a SECOND pipeline with its own rules — so these cases assert
// the opposite: the same dedupe, the same cap, the same levels, and neither leg
// able to take the other down.

import { flushHeld, heldCount, pushStatus } from '../src/lib/push.js';
import { addDevice, listDevices } from '../src/lib/push-subs.js';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

/** A device the way the browser's Push API describes one. */
function fakeDevice(label) {
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = kp.publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return {
    endpoint: `https://web.push.apple.com/${label}`,
    keys: { p256dh: b64u(raw), auth: b64u(randomBytes(16)) },
  };
}

/** Register devices into the in-memory store _reset() installed. */
async function withDevices(...labels) {
  for (const l of labels) await addDevice(fakeDevice(l), { label: l });
}

test('an alert reaches the phone even when ntfy is not configured at all', async () => {
  await withDevices('iPhone');
  const f = capture(201);
  try {
    const r = await pushAlert({ level: 'alert', title: 'davenroe-api is down', source: 'fleet-check' });
    assert.equal(r.sent, true, 'the ntfy leg being absent must not disable the device leg');
    assert.equal(r.devices, 1);
    assert.equal(r.ntfy, 'no-topic');
    const call = f.calls.find(c => c.url.includes('web.push.apple.com'));
    assert.ok(call, 'nothing was sent to the push service');
    assert.equal(call.headers['Content-Encoding'], 'aes128gcm');
    assert.match(call.headers.Authorization, /^vapid t=/);
    assert.equal(call.headers.Urgency, 'high', 'an alert must wake a sleeping phone');
  } finally { f.restore(); }
});

test('both transports fire for one alert, and one failing does not stop the other', async () => {
  process.env.NTFY_TOPIC = 't';
  await withDevices('iPhone', 'iPad');
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (url) => {
    seen.push(String(url));
    // ntfy is refusing; the phones are fine.
    if (String(url).includes('ntfy.sh')) return Promise.resolve({ ok: false, status: 500 });
    return Promise.resolve({ ok: true, status: 201 });
  };
  try {
    const r = await quiet(() => pushAlert({ level: 'alert', title: 'the box is on fire' }));
    assert.equal(r.sent, true, 'two phones got it — that is a delivery');
    assert.equal(r.devices, 2);
    assert.equal(r.of, 2);
    assert.equal(seen.filter(u => u.includes('web.push.apple.com')).length, 2);
  } finally { globalThis.fetch = real; }
});

test('the dedupe applies to the device leg too — one gate, not one per transport', async () => {
  await withDevices('iPhone');
  const f = capture(201);
  try {
    assert.equal((await pushAlert({ level: 'warn', title: 'same thing' })).sent, true);
    const second = await pushAlert({ level: 'warn', title: 'same thing' });
    assert.equal(second.reason, 'deduped');
    assert.equal(f.calls.filter(c => c.url.includes('web.push.apple.com')).length, 1);
  } finally { f.restore(); }
});

test('a dead subscription is pruned on the 410 that says so', async () => {
  await withDevices('iPhone', 'iPad');
  const real = globalThis.fetch;
  globalThis.fetch = (url) => Promise.resolve(
    String(url).includes('/iPhone') ? { ok: false, status: 410 } : { ok: true, status: 201 });
  try {
    const r = await pushAlert({ level: 'alert', title: 'x' });
    assert.equal(r.sent, true, 'the surviving device still counts as delivered');
    assert.equal(r.devices, 1);
    const left = await listDevices();
    assert.deepEqual(left.map(d => d.label), ['iPad'], 'the dead one is gone, the live one stays');
  } finally { globalThis.fetch = real; }
});

test('an offline device is NOT pruned — only the push service can declare it dead', async () => {
  await withDevices('iPhone');
  const real = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 503 });
  try {
    await quiet(() => pushAlert({ level: 'alert', title: 'x' }));
    const left = await listDevices();
    assert.equal(left.length, 1);
    assert.equal(left[0].fails, 1, 'counted, not dropped');
  } finally { globalThis.fetch = real; }
});

test('the ledger does not advance on a delivery that never happened', async () => {
  process.env.NTFY_TOPIC = 't';
  // Nothing was delivered, so the retry a minute later must NOT be deduped —
  // suppressing the retry of an alert nobody received is the quiet failure
  // this module exists to prevent.
  const f = capture(500);
  await quiet(() => pushAlert({ level: 'alert', title: 'the box is on fire' }));
  f.restore();
  const g = capture(200);
  try {
    assert.equal((await pushAlert({ level: 'alert', title: 'the box is on fire' })).sent, true);
  } finally { g.restore(); }
});

// ── Quiet hours and the digest ──────────────────────────────────────────────

test('at 3am a warning is held and an alert is not', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.ALERT_QUIET_START = '0';
  process.env.ALERT_QUIET_END = '23';       // all but one hour is "night", deterministically
  const f = capture();
  try {
    const w = await pushAlert({ level: 'warn', title: 'a finding needs review' });
    assert.equal(w.sent, false);
    assert.equal(w.held, true);
    assert.equal(w.reason, 'quiet-hours');
    assert.equal(f.calls.length, 0, 'nothing left the box');

    const a = await pushAlert({ level: 'alert', title: 'the box is unreachable' });
    assert.equal(a.sent, true, 'THE 3AM CASE — an alert is never held');
    assert.equal(await heldCount(), 1);
  } finally { f.restore(); }
});

test('held warnings arrive as ONE digest, naming what they were', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.ALERT_QUIET_START = '0';
  process.env.ALERT_QUIET_END = '23';
  const f = capture();
  try {
    await pushAlert({ level: 'warn', title: 'gatetest.ai does not resolve', source: 'fleet-check' });
    await pushAlert({ level: 'warn', title: '2 new high findings', source: 'code-health' });
    assert.equal(await heldCount(), 2);
    assert.equal(f.calls.length, 0);

    const out = await flushHeld({ force: true });
    assert.equal(out.flushed, 2);
    assert.equal(f.calls.length, 1, 'one message, not two');
    assert.match(f.calls[0].headers.Title, /2 held overnight/);
    assert.match(f.calls[0].body, /gatetest\.ai does not resolve/);
    assert.match(f.calls[0].body, /2 new high findings/);
    assert.equal(await heldCount(), 0, 'and the queue is emptied');
  } finally { f.restore(); }
});

test('the same headline held repeatedly is one digest line, not eleven', async () => {
  process.env.ALERT_QUIET_START = '0';
  process.env.ALERT_QUIET_END = '23';
  const f = capture();
  try {
    for (let i = 0; i < 11; i++) {
      await pushAlert({ level: 'warn', title: 'voxlen.com is parked', source: 'agent-org' });
    }
    assert.equal(await heldCount(), 1, 'a digest that is one message repeated is the flood, delayed');
  } finally { f.restore(); }
});

test('nothing to flush is not an error, and does not send an empty digest', async () => {
  const f = capture();
  try {
    assert.deepEqual(await flushHeld({ force: true }), { flushed: 0 });
    assert.equal(f.calls.length, 0);
  } finally { f.restore(); }
});

test('pushStatus reports both legs honestly', async () => {
  const before = await pushStatus();
  assert.equal(before.ntfy, false);
  assert.equal(before.devices, 0);
  assert.equal(before.any, false, 'no transport at all must not read as "configured"');

  await withDevices('iPhone');
  process.env.NTFY_TOPIC = 't';
  const after = await pushStatus();
  assert.equal(after.ntfy, true);
  assert.equal(after.devices, 1);
  assert.deepEqual(after.deviceLabels, ['iPhone']);
  assert.equal(after.any, true);
});

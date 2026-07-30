// test/push.test.js — device push, 2026-07-30.
//
// This is the only notification path that works when nothing of Craig's is open,
// so its failure modes matter more than most: a channel that silently delivers
// nothing (the off-box watchdog's whole history) and a channel that buzzes so
// often he mutes it (the Slack firehose) are both total failures. Both are
// tested here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pushAlert, hasPush, _reset } from '../src/lib/push.js';

const ENV = ['NTFY_TOPIC', 'NTFY_SERVER', 'NTFY_TOKEN', 'PUSH_MIN_LEVEL', 'PUSH_DISABLED',
  'PUSH_CLICK_URL', 'PUSH_MAX_PER_HOUR', 'PUSH_DEDUPE_MINUTES', 'PUSH_ALERT_DEDUPE_HOURS'];

test.beforeEach(() => {
  for (const k of ENV) delete process.env[k];
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
    assert.equal((await pushAlert({ level: 'warn', title: 'three' })).reason, 'rate-capped');
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
      assert.equal((await pushAlert({ level: 'warn', title: 'three' })).reason, 'rate-capped');
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
    assert.equal(f.calls[0].headers.Click, 'https://jarvis.example/deck');
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

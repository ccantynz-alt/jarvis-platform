// lib/transcript.js — the one durable conversation shared by the deck and the
// gateway. The gateway kept a per-connection array until 2026-07-28, so a page
// reload lost the conversation; these pin the behaviour that replaced it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTranscript, saveTranscript, recordFallbackTurn, retryLoadIfUnread, _reset } from '../src/lib/transcript.js';

const realFetch = global.fetch;

/** Stand in for memory-server's KV. Returns the call log for assertions. */
function stubMemory({ store = {}, failWrites = false } = {}) {
  const calls = { reads: [], writes: [] };
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (opts?.method === 'POST') {
      const body = JSON.parse(opts.body);
      calls.writes.push(body);
      if (failWrites) return { ok: false, status: 503 };
      store[body.key] = body.value;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    const key = u.split('/memory/kv/')[1];
    calls.reads.push(key);
    if (!(key in store)) return { ok: false, status: 404 };
    return { ok: true, status: 200, json: async () => ({ key, value: store[key] }) };
  };
  return calls;
}

test.afterEach(() => { global.fetch = realFetch; _reset(); });

test('loads the shared conversation from KV', async () => {
  stubMemory({ store: { 'jarvis-conversation': JSON.stringify([{ role: 'user', content: 'hello' }]) } });
  const t = await loadTranscript();
  assert.equal(t.length, 1);
  assert.equal(t[0].content, 'hello');
});

test('migrates the deck\'s old conversation when the new key is empty', async () => {
  const calls = stubMemory({ store: { 'deck-conversation': JSON.stringify([{ role: 'user', content: 'from the deck' }]) } });
  const t = await loadTranscript();
  assert.equal(t[0].content, 'from the deck');
  assert.deepEqual(calls.reads, ['jarvis-conversation', 'deck-conversation']);
});

test('a missing conversation starts empty rather than throwing', async () => {
  stubMemory();
  assert.deepEqual(await loadTranscript(), []);
});

test('memory-server being down does not break the turn', async () => {
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    assert.deepEqual(await loadTranscript(), []);
  } finally { console.error = realError; }
  assert.match(errors.at(-1) || '', /memory unreachable/);
});

// ── The boot race ───────────────────────────────────────────────────────────
// The units order deck/gateway After= jarvis-memory.service, but After= only
// means memory-server was STARTED, not that it has bound :9200. Losing this
// behaviour means every reboot can wipe the real conversation.

test('a read that fails then succeeds recovers the real conversation', async () => {
  const stored = JSON.stringify([{ role: 'user', content: 'the real history' }]);
  let attempts = 0;
  global.fetch = async (url) => {
    if (++attempts <= 2) throw new Error('ECONNREFUSED'); // memory still booting
    return { ok: true, status: 200, json: async () => ({ value: stored }) };
  };
  const t = await loadTranscript();
  assert.equal(t[0].content, 'the real history');
});

test('a scratch conversation is NEVER persisted over the stored one', async () => {
  const writes = [];
  const realError = console.error;
  console.error = () => {};
  try {
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') { writes.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
      throw new Error('ECONNREFUSED'); // every read fails — we never learned the truth
    };
    const t = await loadTranscript();
    t.push({ role: 'user', content: 'said while memory was down' });
    saveTranscript();
    await new Promise(r => setTimeout(r, 600));
  } finally { console.error = realError; }
  assert.equal(writes.length, 0, 'writing here would destroy the stored conversation');
});

test('once a read succeeds, saving resumes', async () => {
  let readOk = false;
  const writes = [];
  const realError = console.error;
  console.error = () => {};
  try {
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') { writes.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
      if (!readOk) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ value: '[]' }) };
    };
    await loadTranscript();          // fails — scratch mode
    readOk = true;
    assert.equal(await retryLoadIfUnread(), true);
    (await loadTranscript()).push({ role: 'user', content: 'now it is safe' });
    saveTranscript();
    await new Promise(r => setTimeout(r, 600));
  } finally { console.error = realError; }
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0].value)[0].content, 'now it is safe');
});

test('a 404 means genuinely empty, not unreachable — saving is allowed', async () => {
  const writes = [];
  global.fetch = async (url, opts) => {
    if (opts?.method === 'POST') { writes.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: false, status: 404 };
  };
  (await loadTranscript()).push({ role: 'user', content: 'first ever message' });
  saveTranscript();
  await new Promise(r => setTimeout(r, 600));
  assert.equal(writes.length, 1);
});

test('concurrent turns share ONE load, not two divergent arrays', async () => {
  const calls = stubMemory({ store: { 'jarvis-conversation': '[]' } });
  const [a, b] = await Promise.all([loadTranscript(), loadTranscript()]);
  assert.equal(a, b, 'both callers must get the same array instance');
  assert.equal(calls.reads.filter(k => k === 'jarvis-conversation').length, 1);
});

test('the deck and the gateway see the same conversation', async () => {
  stubMemory({ store: { 'jarvis-conversation': '[]' } });
  const deckView = await loadTranscript();
  deckView.push({ role: 'user', content: 'said on the deck' });
  const gatewayView = await loadTranscript();
  assert.equal(gatewayView.at(-1).content, 'said on the deck');
});

test('a failed-brain turn is still recorded so continuity survives', async () => {
  stubMemory({ store: { 'jarvis-conversation': '[]' } });
  await recordFallbackTurn('what were we organising', 'Acknowledged, sir.');
  const t = await loadTranscript();
  assert.equal(t.length, 2);
  assert.equal(t[0].content, 'what were we organising');
  assert.match(t[1].content, /basic pipeline/);
});

test('the conversation stays bounded at 24 messages', async () => {
  stubMemory({ store: { 'jarvis-conversation': '[]' } });
  for (let i = 0; i < 20; i++) await recordFallbackTurn(`msg ${i}`, 'ok');
  const t = await loadTranscript();
  assert.equal(t.length, 24);
  assert.equal(t.at(-2).content, 'msg 19', 'the newest turn must survive the trim');
});

test('saves are debounced and land on the shared key', async () => {
  const calls = stubMemory({ store: { 'jarvis-conversation': '[]' } });
  const t = await loadTranscript();
  t.push({ role: 'user', content: 'x' });
  saveTranscript(); saveTranscript(); saveTranscript();
  await new Promise(r => setTimeout(r, 600));
  assert.equal(calls.writes.length, 1, 'three touches in one turn = one write');
  assert.equal(calls.writes[0].key, 'jarvis-conversation');
  assert.equal(JSON.parse(calls.writes[0].value)[0].content, 'x');
});

test('a rejected write is surfaced, not swallowed', async () => {
  stubMemory({ store: { 'jarvis-conversation': '[]' }, failWrites: true });
  const errors = [];
  const realError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    const t = await loadTranscript();
    t.push({ role: 'user', content: 'x' });
    saveTranscript();
    await new Promise(r => setTimeout(r, 600));
  } finally { console.error = realError; }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not persist conversation/);
});

// ── Cross-surface merge (2026-07-30) ────────────────────────────────────────
// Found by the code-health spine and, independently, by the 2026-07-26 audit.
// saveTranscript wrote the whole local array as the new value, from a cache
// loadTranscript never refreshes — and the deck (:9210) and gateway (:9208) are
// separate processes with separate caches, both of which save. A long
// conversation on the deck plus one sentence to the gateway meant the gateway
// wrote its stale array over the top and the deck's turns were gone. "One
// conversation, all surfaces" was the feature; using two surfaces broke it.

import { mergeTail } from '../src/lib/transcript.js';

const msg = (role, content) => ({ role, content });

test('a turn from another surface is not destroyed — THE bug', async () => {
  const store = { 'jarvis-conversation': JSON.stringify([msg('user', 'A')]) };
  const calls = stubMemory({ store });

  const t = await loadTranscript();          // this process caches [A]
  t.push(msg('user', 'B'));                  // our new turn

  // Meanwhile the OTHER surface records two turns and saves them.
  store['jarvis-conversation'] = JSON.stringify([msg('user', 'A'), msg('user', 'C'), msg('assistant', 'D')]);

  saveTranscript();
  await new Promise(r => setTimeout(r, 600));

  const written = JSON.parse(calls.writes.at(-1).value).map(m => m.content);
  assert.deepEqual(written, ['A', 'C', 'D', 'B'], 'the other surface survives and our turn is appended');
});

test('the merge lands in the SHARED array, not a replacement', async () => {
  const store = { 'jarvis-conversation': JSON.stringify([msg('user', 'A')]) };
  stubMemory({ store });
  const t = await loadTranscript();
  t.push(msg('user', 'B'));
  store['jarvis-conversation'] = JSON.stringify([msg('user', 'A'), msg('user', 'C')]);

  saveTranscript();
  await new Promise(r => setTimeout(r, 600));

  // runAgent and both servers hold this exact reference; reassigning would
  // silently orphan them mid-conversation.
  assert.equal(await loadTranscript(), t, 'same array object');
  assert.deepEqual(t.map(m => m.content), ['A', 'C', 'B']);
});

test('an unreadable store holds the turn instead of overwriting', async () => {
  const store = { 'jarvis-conversation': JSON.stringify([msg('user', 'A')]) };
  const calls = stubMemory({ store });
  const t = await loadTranscript();
  t.push(msg('user', 'B'));

  const realError = console.error;
  const errors = [];
  console.error = (m) => errors.push(String(m));
  global.fetch = async (url, opts) => {
    if (opts?.method === 'POST') { calls.writes.push(JSON.parse(opts.body)); return { ok: true, json: async () => ({}) }; }
    throw new Error('memory unreachable');
  };
  try {
    saveTranscript();
    await new Promise(r => setTimeout(r, 600));
  } finally { console.error = realError; }

  assert.equal(calls.writes.length, 0, 'nothing is written when we cannot see what is there');
  assert.match(errors.join(' '), /not overwriting/);
  assert.equal(t.length, 2, 'and the turn is still in memory for the next save');
});

test('a failed write does not advance the baseline, so the turn is retried', async () => {
  const store = { 'jarvis-conversation': JSON.stringify([msg('user', 'A')]) };
  const calls = stubMemory({ store, failWrites: true });
  const t = await loadTranscript();
  t.push(msg('user', 'B'));

  const realError = console.error;
  console.error = () => {};
  try {
    saveTranscript();
    await new Promise(r => setTimeout(r, 600));
    calls.writes.length = 0;
    global.fetch = async (url, opts) => {   // store recovers
      if (opts?.method === 'POST') { const b = JSON.parse(opts.body); calls.writes.push(b); store[b.key] = b.value; return { ok: true, json: async () => ({}) }; }
      const key = String(url).split('/memory/kv/')[1];
      return key in store ? { ok: true, json: async () => ({ key, value: store[key] }) } : { ok: false, status: 404 };
    };
    saveTranscript();
    await new Promise(r => setTimeout(r, 600));
  } finally { console.error = realError; }

  assert.deepEqual(JSON.parse(calls.writes.at(-1).value).map(m => m.content), ['A', 'B'],
    'B is still sent after the first attempt failed');
});

test('mergeTail skips a turn already at the stored tail', () => {
  const stored = [msg('user', 'A'), msg('assistant', 'B')];
  assert.deepEqual(mergeTail(stored, [msg('assistant', 'B')]).map(m => m.content), ['A', 'B'],
    'a partially applied save must not duplicate');
});

test('mergeTail keeps the conversation bounded', () => {
  const stored = Array.from({ length: 24 }, (_, i) => msg('user', `old${i}`));
  const merged = mergeTail(stored, [msg('user', 'new')]);
  assert.equal(merged.length, 24);
  assert.equal(merged.at(-1).content, 'new');
  assert.equal(merged[0].content, 'old1', 'the oldest turn is the one dropped');
});

// ── The regression the live run caught (2026-07-30) ──────────────────────────
// The first cut of the merge diffed by LENGTH. runAgent bounds the array to 24
// in place after pushing, so at the cap — where a real conversation always is —
// appending two turns leaves the length unchanged, "nothing new" is inferred, and
// every turn stops being persisted. The unit tests passed (short arrays, no
// trimming); the live deck-then-gateway run showed both markers vanishing.

import { newSince } from '../src/lib/transcript.js';

test('new turns are found even when the array was trimmed to the cap', () => {
  const base = Array.from({ length: 24 }, (_, i) => msg('user', `m${i}`));
  // What runAgent leaves behind: push two, then splice the two oldest away.
  const local = [...base.slice(2), msg('user', 'fresh-q'), msg('assistant', 'fresh-a')];
  assert.equal(local.length, base.length, 'the length is identical — this is the trap');
  assert.deepEqual(newSince(local, base).map(m => m.content), ['fresh-q', 'fresh-a']);
});

test('plain growth is found too', () => {
  const base = [msg('user', 'a')];
  const local = [msg('user', 'a'), msg('assistant', 'b')];
  assert.deepEqual(newSince(local, base).map(m => m.content), ['b']);
});

test('everything is new when the baseline is empty', () => {
  assert.deepEqual(newSince([msg('user', 'a')], []).map(m => m.content), ['a']);
});

test('a spliced-away turn (brain rollback) adds nothing', () => {
  const base = [msg('user', 'a'), msg('assistant', 'b')];
  assert.deepEqual(newSince([msg('user', 'a')], base), []);
});

test('an unrelated array adds nothing rather than guessing', () => {
  const base = [msg('user', 'a'), msg('assistant', 'b')];
  assert.deepEqual(newSince([msg('user', 'totally'), msg('user', 'different')], base), []);
});

test('a turn that lands DURING the read is not erased — second-pass race', async () => {
  // Found by the concurrency lens in this morning's own merge fix: `ourNew` was
  // computed before `await readKey`, so a push that happened while the read was
  // in flight was in neither the diff nor the stored array, and the splice
  // erased it. The diff now sits after the await.
  const store = { 'jarvis-conversation': JSON.stringify([msg('user', 'A')]) };
  const calls = { writes: [] };
  const real = global.fetch;
  const t = await (async () => {
    global.fetch = async (url, opts) => {
      if (opts?.method === 'POST') {
        calls.writes.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const key = String(url).split('/memory/kv/')[1];
      if (!(key in store)) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => ({ key, value: store[key] }) };
    };
    return loadTranscript();
  })();

  t.push(msg('user', 'B'));

  // Make the READ slow, and push a third turn while it is in flight.
  global.fetch = async (url, opts) => {
    if (opts?.method === 'POST') {
      calls.writes.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    t.push(msg('assistant', 'C-arrived-mid-read'));
    await new Promise(r => setTimeout(r, 20));
    const key = String(url).split('/memory/kv/')[1];
    return { ok: true, status: 200, json: async () => ({ key, value: store[key] }) };
  };

  try {
    saveTranscript();
    await new Promise(r => setTimeout(r, 700));
  } finally { global.fetch = real; }

  const written = JSON.parse(calls.writes.at(-1).value).map(m => m.content);
  assert.ok(written.includes('B'), 'the turn queued before the save survives');
  assert.ok(written.includes('C-arrived-mid-read'), 'and so does the one that landed during the read');
});

// lib/transcript.js — the one durable conversation shared by the deck and the
// gateway. The gateway kept a per-connection array until 2026-07-28, so a page
// reload lost the conversation; these pin the behaviour that replaced it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTranscript, saveTranscript, recordFallbackTurn, _reset } from '../src/lib/transcript.js';

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
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  assert.deepEqual(await loadTranscript(), []);
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

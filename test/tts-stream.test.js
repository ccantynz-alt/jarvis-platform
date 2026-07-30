/**
 * lib/tts-stream.js — the two ways a voice turn goes silent without failing.
 *
 * Found 2026-07-30 by the code-health spine's integrations lens. `new
 * WebSocket(url, {headers})` passed no handshakeTimeout, so a TLS-accepted-but-
 * never-upgraded socket emitted no 'open', no 'error' and no 'close'; and an
 * opened socket that rendered nothing was equally quiet. In both cases
 * openTtsStream resolved, the deck sent `audio_ctl start`, every sentence went
 * into the stream, `spokenAny` went true — and the turn had no voice, with the
 * client waiting for audio that was never coming.
 *
 * These run against a local ws server via ELEVENLABS_WS_BASE, because the bug
 * only exists in the gap between "connected" and "producing audio" and nothing
 * could stand that up before.
 */

import test from 'node:test';
import assert from 'node:assert';
import { createServer } from 'net';
import { createServer as httpServer } from 'http';

process.env.ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'test-key';
delete process.env.TTS_DISABLED;
process.env.TTS_HANDSHAKE_MS = '400';
process.env.TTS_FIRST_AUDIO_MS = '400';

// A budget stub, because the first version of this file talked to the LIVE
// memory-server on :9200 (2026-07-30, found by the code-health spine reviewing it
// hours after it shipped). openTtsStream reads the day's ElevenLabs spend before
// opening and writes charsSent back on close, so running `npm test` on the box
// charged the real daily character budget with these test phrases — and once that
// budget was genuinely spent, openTtsStream returned null and every test here
// failed for a reason unrelated to the code under test. The stub also lets the
// suite ASSERT that nothing was written, which is stronger than not noticing.
const budgetWrites = [];
const budgetStub = httpServer((req, res) => {
  if (req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { budgetWrites.push(raw); res.end('{"ok":true}'); });
    return;
  }
  res.end(JSON.stringify({ key: 'tts-budget', value: '0' }));
});
await new Promise((r) => budgetStub.listen(0, '127.0.0.1', r));
process.env.JARVIS_MEMORY_URL = `http://127.0.0.1:${budgetStub.address().port}`;
// unref, or a listening socket keeps the event loop alive after the last test and
// the run hangs instead of exiting — which is exactly what it did on the dev
// checkout, where every test in this file is skipped and nothing else was holding
// the process open. Same lesson as the fixture's terminate(): a test that hangs
// reports nothing at all.
budgetStub.unref();

// Unlike the rest of test/, this file needs the real `ws` package (both to drive
// tts-stream.js and to stand up a fake ElevenLabs). node_modules only exists on
// the box, so skip loudly rather than fail when running from a dev checkout —
// `npm test` on 66.42.121.161 is where these actually mean something.
let WebSocketServer, openTtsStream;
try {
  ({ WebSocketServer } = await import('ws'));
  ({ openTtsStream } = await import('../src/lib/tts-stream.js'));
} catch (e) {
  console.warn(`[tts-stream.test] skipped — dependencies unavailable here (${e.code || e.message})`);
}
const it = WebSocketServer && openTtsStream ? test : test.skip;

/**
 * A ws server that accepts, optionally answers, and reports what it received.
 *
 * close() TERMINATES live client sockets before closing the http server:
 * http.close() waits for open connections, and these tests deliberately leave a
 * connection open (that being the whole point), so a polite close never returns
 * and the run hangs with no failure — which is how the first version of this
 * file wedged `npm test` on the box.
 */
async function wsFixture(onText) {
  const http = httpServer();
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const wss = new WebSocketServer({ server: http });
  const live = new Set();
  wss.on('connection', (sock) => {
    live.add(sock);
    sock.on('close', () => live.delete(sock));
    sock.on('error', () => {});
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      onText?.(m, sock);
    });
  });
  const port = http.address().port;
  return {
    base: `ws://127.0.0.1:${port}`,
    close: async () => {
      for (const s of live) { try { s.terminate(); } catch {} }
      await new Promise((r) => wss.close(r));
      await new Promise((r) => http.close(r));
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 1200));

it('an opened stream that never renders audio reports an error instead of going quiet', { timeout: 20000 }, async () => {
  // Accepts the socket, takes the text, and renders nothing — a slow or wedged
  // ElevenLabs, not a dead one. This is the case that produced a silent turn.
  const fx = await wsFixture(() => { /* deliberately mute */ });
  process.env.ELEVENLABS_WS_BASE = fx.base;

  const errors = [];
  const stream = await openTtsStream({ onAudio: () => {}, onDone: () => {}, onError: (e) => errors.push(e) });
  assert.ok(stream, 'the stream still opens — the failure is downstream of opening');

  stream.sendText('Vapron is back up, sir.');
  await settle();

  assert.equal(errors.length, 1, 'the caller is told, so it can send audio_ctl fallback');
  assert.match(errors[0].message, /no audio from ElevenLabs/);
  assert.equal(stream.audioAny, false);

  stream.abort();
  delete process.env.ELEVENLABS_WS_BASE;
  await fx.close();
});

it('a stream that does render audio is left alone', { timeout: 20000 }, async () => {
  // The deadline must not fire on a working stream, and must not fire on a
  // stream that simply has not been given any text yet.
  const fx = await wsFixture((m, sock) => {
    if (m.text && m.text.trim()) {
      sock.send(JSON.stringify({ audio: Buffer.from('fake-mp3-bytes').toString('base64') }));
    }
  });
  process.env.ELEVENLABS_WS_BASE = fx.base;

  const errors = [];
  const chunks = [];
  const stream = await openTtsStream({
    onAudio: (b) => chunks.push(b), onDone: () => {}, onError: (e) => errors.push(e),
  });

  stream.sendText('All eleven services are green.');
  await settle();

  assert.equal(errors.length, 0, 'no false alarm on a healthy stream');
  assert.equal(chunks.length, 1);
  assert.equal(stream.audioAny, true, 'and audioAny distinguishes this from text merely being sent');

  stream.abort();
  delete process.env.ELEVENLABS_WS_BASE;
  await fx.close();
});

it('an idle stream with no text sent is not failed by the audio deadline', { timeout: 20000 }, async () => {
  const fx = await wsFixture(() => {});
  process.env.ELEVENLABS_WS_BASE = fx.base;

  const errors = [];
  const stream = await openTtsStream({ onAudio: () => {}, onDone: () => {}, onError: (e) => errors.push(e) });
  await settle();   // longer than the deadline, but nothing was ever spoken

  assert.equal(errors.length, 0, 'the deadline is armed by sending text, not by connecting');

  stream.abort();
  delete process.env.ELEVENLABS_WS_BASE;
  await fx.close();
});

it('a socket that accepts TCP and never completes the upgrade fails instead of hanging', { timeout: 20000 }, async () => {
  // The original finding: TLS/TCP completes, the HTTP upgrade never gets an
  // answer, and ws without handshakeTimeout waits forever in silence.
  const held = new Set();
  const tcp = createServer((s) => {   // accept and hold, answer nothing
    held.add(s);
    s.on('error', () => {});
    s.on('close', () => held.delete(s));
  });
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  process.env.ELEVENLABS_WS_BASE = `ws://127.0.0.1:${tcp.address().port}`;

  const errors = [];
  const started = Date.now();
  await openTtsStream({ onAudio: () => {}, onDone: () => {}, onError: (e) => errors.push(e) });
  await settle();

  assert.equal(errors.length, 1, 'handshakeTimeout turns the hang into a reportable failure');
  assert.ok(Date.now() - started < 3000, 'and it does so promptly');

  delete process.env.ELEVENLABS_WS_BASE;
  for (const s of held) s.destroy();   // same reason as wsFixture.close()
  await new Promise((r) => tcp.close(r));
});

it('the suite never charges the real ElevenLabs budget', { timeout: 20000 }, async () => {
  // Everything above ran against the local stub, so any spend recorded here went
  // to the stub and not to the box's live counter. What this asserts is that the
  // seam is actually in use: if JARVIS_MEMORY_URL were ignored, budgetAdd would
  // have gone to :9200 and this list would be empty while real money moved.
  assert.ok(budgetWrites.length > 0,
    'expected the stub to have received the budget writes — if it got none, tts.js is talking to :9200 instead');
  assert.match(budgetWrites.join(' '), /tts-budget-/);
  assert.equal(process.env.JARVIS_MEMORY_URL.includes('127.0.0.1:9200'), false,
    'the stub must not be the real memory server');
});

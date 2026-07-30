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

/** A ws server that accepts, optionally answers, and reports what it received. */
async function wsFixture(onText) {
  const http = httpServer();
  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const wss = new WebSocketServer({ server: http });
  wss.on('connection', (sock) => {
    sock.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      onText?.(m, sock);
    });
  });
  const port = http.address().port;
  return { base: `ws://127.0.0.1:${port}`, close: () => new Promise((r) => { wss.close(); http.close(r); }) };
}

const settle = () => new Promise((r) => setTimeout(r, 1200));

it('an opened stream that never renders audio reports an error instead of going quiet', async () => {
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

  delete process.env.ELEVENLABS_WS_BASE;
  await fx.close();
});

it('a stream that does render audio is left alone', async () => {
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

  delete process.env.ELEVENLABS_WS_BASE;
  await fx.close();
});

it('an idle stream with no text sent is not failed by the audio deadline', async () => {
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

it('a socket that accepts TCP and never completes the upgrade fails instead of hanging', async () => {
  // The original finding: TLS/TCP completes, the HTTP upgrade never gets an
  // answer, and ws without handshakeTimeout waits forever in silence.
  const tcp = createServer(() => { /* accept and hold, answer nothing */ });
  await new Promise((r) => tcp.listen(0, '127.0.0.1', r));
  process.env.ELEVENLABS_WS_BASE = `ws://127.0.0.1:${tcp.address().port}`;

  const errors = [];
  const started = Date.now();
  await openTtsStream({ onAudio: () => {}, onDone: () => {}, onError: (e) => errors.push(e) });
  await settle();

  assert.equal(errors.length, 1, 'handshakeTimeout turns the hang into a reportable failure');
  assert.ok(Date.now() - started < 3000, 'and it does so promptly');

  delete process.env.ELEVENLABS_WS_BASE;
  await new Promise((r) => tcp.close(r));
});

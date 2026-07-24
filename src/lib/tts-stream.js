/**
 * Jarvis Voice v2 — src/lib/tts-stream.js (see docs/VOICE-V2.md)
 *
 * One ElevenLabs `stream-input` websocket session per spoken reply: sentences
 * go in as the brain streams them, mp3 chunks come out within ~300-500ms, and
 * abort() kills the stream at the source — this is what makes interruption
 * real instead of "the client goes quiet while the server keeps rendering".
 *
 * Shares the daily character budget with lib/tts.js (one pool for streamed
 * and fetched speech) and respects TTS_DISABLED/unconfigured the same way.
 */

import WebSocket from 'ws';
import { VOICE_ID, MODEL_ID, ttsEnabled, budgetSpent, budgetAdd } from './tts.js';

const EL_URL = `wss://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream-input` +
  `?model_id=${MODEL_ID}&output_format=mp3_44100_64&auto_mode=true`;

/**
 * openTtsStream({ onAudio, onDone, onError }) →
 *   { sendText(t), end(), abort(), charsSent } | null when TTS is off/over budget.
 *
 *   onAudio(Buffer)  — an mp3 chunk, in order
 *   onDone()         — ElevenLabs finished rendering everything sent
 *   onError(err)     — stream failed mid-flight (caller should fall back to v1)
 */
export async function openTtsStream({ onAudio, onDone, onError }) {
  if (!ttsEnabled()) return null;
  const day = new Date().toISOString().slice(0, 10);
  const alreadySpent = await budgetSpent(day);
  const BUDGET = parseInt(process.env.TTS_DAILY_CHAR_BUDGET || '40000', 10);
  if (alreadySpent >= BUDGET) return null;

  let ws;
  try { ws = new WebSocket(EL_URL, { headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY } }); }
  catch (e) { onError?.(e); return null; }

  const session = { charsSent: 0, dead: false };
  let opened = false;
  const pending = []; // text queued before the socket opens

  const fail = (e) => {
    if (session.dead) return;
    session.dead = true;
    try { ws.close(); } catch {}
    onError?.(e instanceof Error ? e : new Error(String(e)));
  };

  ws.on('open', () => {
    opened = true;
    // First message carries voice settings; auth already went via header.
    ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.25 } }));
    for (const t of pending.splice(0)) ws.send(JSON.stringify({ text: t }));
  });

  ws.on('message', (raw) => {
    if (session.dead) return;
    try {
      const m = JSON.parse(raw.toString());
      if (m.audio) onAudio?.(Buffer.from(m.audio, 'base64'));
      if (m.isFinal) { session.dead = true; try { ws.close(); } catch {} onDone?.(); }
      if (m.error) fail(new Error(m.message || m.error));
    } catch (e) { fail(e); }
  });

  ws.on('error', fail);
  ws.on('close', () => {
    // Budget: settle once per session, however it ended.
    if (session.charsSent > 0) budgetAdd(day, session.charsSent, alreadySpent).catch(() => {});
    if (!session.dead) { session.dead = true; onDone?.(); }
  });

  return {
    get charsSent() { return session.charsSent; },
    sendText(t) {
      const text = String(t || '');
      if (session.dead || !text.trim()) return;
      if (alreadySpent + session.charsSent + text.length > BUDGET) return; // hard stop at the cap
      session.charsSent += text.length;
      // ElevenLabs wants a trailing space between fragments.
      const payload = text.endsWith(' ') ? text : text + ' ';
      if (opened) { try { ws.send(JSON.stringify({ text: payload })); } catch (e) { fail(e); } }
      else pending.push(payload);
    },
    end() { // no more text — let EL flush the tail, then it sends isFinal
      if (session.dead) return;
      if (opened) { try { ws.send(JSON.stringify({ text: '' })); } catch { /* close will settle */ } }
      else { session.dead = true; try { ws.close(); } catch {} onDone?.(); }
    },
    abort() { // interruption: kill it NOW, no tail flush
      if (session.dead) return;
      session.dead = true;
      try { ws.close(); } catch {}
    },
  };
}

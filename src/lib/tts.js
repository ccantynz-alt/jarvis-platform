/**
 * Jarvis neural voice — src/lib/tts.js
 *
 * ElevenLabs text-to-speech behind a disk cache and a daily character budget.
 * The Deck's GET /tts endpoint (and later the Gateway) call synthesize() and
 * stream the mp3 to the browser; on failure it returns a reason code
 * ('unconfigured' | 'budget' | 'api_error') the client uses to pick between
 * retrying and switching to its backup browser voice for the day.
 *
 * Env (config/secrets.env):
 *   ELEVENLABS_API_KEY   — required for real synthesis
 *   JARVIS_VOICE_ID      — ElevenLabs voice (default: Craig's chosen voice)
 *   TTS_DISABLED=1       — kill switch: behave as unconfigured
 *   TTS_DAILY_CHAR_BUDGET — default 40000 chars/day (≈ NZ$? pennies on flash)
 */

import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

export const VOICE_ID  = process.env.JARVIS_VOICE_ID || 'lUTamkMw7gOzZbFIwmq4';
export const MODEL_ID  = 'eleven_flash_v2_5'; // lowest latency tier
const CACHE_DIR = '/opt/jarvis/memory/tts-cache';
const CACHE_CAP_BYTES = 50 * 1024 * 1024;
const BUDGET    = parseInt(process.env.TTS_DAILY_CHAR_BUDGET || '40000', 10);
const MEMORY    = 'http://127.0.0.1:9200';

mkdirSync(CACHE_DIR, { recursive: true });

export function ttsEnabled() {
  return !!process.env.ELEVENLABS_API_KEY && process.env.TTS_DISABLED !== '1';
}

// ── Daily character budget (durable in memory KV, survives restarts) ────────
// Exported 2026-07-25 so lib/tts-stream.js (Voice v2) draws on the SAME
// daily budget — streamed chars and fetched chars spend from one pool.
export async function budgetSpent(day) {
  try {
    const r = await fetch(`${MEMORY}/memory/kv/tts-budget-${day}`);
    const j = await r.json();
    return parseInt(j?.value, 10) || 0;
  } catch { return 0; }
}
export async function budgetAdd(day, chars, prev) {
  try {
    await fetch(`${MEMORY}/memory/kv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `tts-budget-${day}`, value: String(prev + chars) }),
    });
  } catch { /* budget tracking is best-effort */ }
}

// ── Cache (sha1(text+voice) → mp3; LRU-pruned by mtime) ─────────────────────
function cachePath(text) {
  return join(CACHE_DIR, createHash('sha1').update(VOICE_ID + '|' + text).digest('hex') + '.mp3');
}
function pruneCache() {
  try {
    const files = readdirSync(CACHE_DIR).map(f => {
      const p = join(CACHE_DIR, f);
      const st = statSync(p);
      return { p, size: st.size, mtime: st.mtimeMs };
    });
    let total = files.reduce((n, f) => n + f.size, 0);
    if (total <= CACHE_CAP_BYTES) return;
    for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
      unlinkSync(f.p); total -= f.size;
      if (total <= CACHE_CAP_BYTES) break;
    }
  } catch { /* cache pruning is best-effort */ }
}

/**
 * synthesize(text) → { buf } (mp3) | { reason } on failure, where reason is
 * 'unconfigured' | 'budget' | 'api_error'. The reason lets the client decide
 * between retrying (transient) and switching to its backup voice for the day.
 */
export async function synthesize(rawText) {
  const text = String(rawText || '').trim().slice(0, 1200); // hard per-call cap
  if (!text || !ttsEnabled()) return { reason: 'unconfigured' };

  const cached = cachePath(text);
  if (existsSync(cached)) {
    try {
      const buf = readFileSync(cached);
      writeFileSync(cached, buf); // touch mtime for LRU
      return { buf };
    } catch { /* fall through to synth */ }
  }

  const day = new Date().toISOString().slice(0, 10);
  const spent = await budgetSpent(day);
  if (spent + text.length > BUDGET) {
    console.warn(`[tts] daily budget reached (${spent}/${BUDGET} chars) — falling back`);
    return { reason: 'budget' };
  }

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_64`, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.25 },
      }),
    });
    if (!r.ok) {
      console.error(`[tts] ElevenLabs ${r.status}: ${(await r.text()).slice(0, 160)}`);
      return { reason: 'api_error' };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 200) return { reason: 'api_error' }; // not real audio
    try { writeFileSync(cached, buf); pruneCache(); } catch { /* cache is best-effort */ }
    budgetAdd(day, text.length, spent);
    return { buf };
  } catch (e) {
    console.error('[tts] synth failed:', e.message);
    return { reason: 'api_error' };
  } finally {
    clearTimeout(t);
  }
}

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
import { guardrail } from './guardrail.js';
import { notify } from './notify.js';

export const VOICE_ID  = process.env.JARVIS_VOICE_ID || 'lUTamkMw7gOzZbFIwmq4';
export const MODEL_ID  = 'eleven_flash_v2_5'; // lowest latency tier
const CACHE_DIR = '/opt/jarvis/memory/tts-cache';
const CACHE_CAP_BYTES = 50 * 1024 * 1024;
// A malformed budget must not become NaN: `spent + len > NaN` is false, so
// the cap would silently vanish and ElevenLabs spend would run unbounded.
const BUDGET    = guardrail('TTS_DAILY_CHAR_BUDGET', 40000, { source: 'tts' });
// Read per call, not frozen at import: test/tts-stream.test.js has to be able to
// point this at a stub. Without that seam the suite talked to the LIVE memory
// server (2026-07-30, found by the code-health spine) — so running `npm test` on
// the box added its test phrases to the real ElevenLabs daily character budget
// via /memory/kv/incr, and once that budget was genuinely spent openTtsStream
// returned null and the tests failed for a reason that had nothing to do with the
// code under test. A test suite must not be able to spend money.
const memBase = () => process.env.JARVIS_MEMORY_URL || 'http://127.0.0.1:9200';

mkdirSync(CACHE_DIR, { recursive: true });

export function ttsEnabled() {
  return !!process.env.ELEVENLABS_API_KEY && process.env.TTS_DISABLED !== '1';
}

// ── Daily character budget (durable in memory KV, survives restarts) ────────
// Exported 2026-07-25 so lib/tts-stream.js (Voice v2) draws on the SAME
// daily budget — streamed chars and fetched chars spend from one pool.
/**
 * The day's spend so far. Fails OPEN (0) when memory is unreachable, which is
 * deliberate for a VOICE assistant — going mute because a counter is unavailable
 * is worse than overspending for a few minutes — but it is now LOUD about it,
 * once a minute at most. Silence was the part worth fixing: an unreachable
 * memory-server looked exactly like "nothing spent today".
 */
let budgetReadFailedAt = 0;
export async function budgetSpent(day) {
  try {
    const r = await fetch(`${memBase()}/memory/kv/tts-budget-${day}`);
    if (!r.ok && r.status !== 404) throw new Error(`memory KV returned ${r.status}`);
    const j = await r.json();
    return parseInt(j?.value, 10) || 0;
  } catch (e) {
    if (Date.now() - budgetReadFailedAt > 60_000) {
      budgetReadFailedAt = Date.now();
      console.warn(`[tts] cannot read today's character budget (${e.message}) — treating as 0, so the daily cap is NOT enforced until memory returns`);
    }
    return 0;
  }
}
// Once per day, not per utterance — a budget that is already spent would
// otherwise fire on every single reply.
let budgetAnnouncedFor = null;
function announceBudget(day, spent) {
  if (budgetAnnouncedFor === day) return;
  budgetAnnouncedFor = day;
  notify({
    source: 'tts', level: 'warn',
    title: 'ElevenLabs daily voice budget spent — using the browser voice',
    body: `${spent}/${BUDGET} characters used today. Replies still speak, but in the browser's own voice rather than mine. `
      + 'Raise TTS_DAILY_CHAR_BUDGET in config/secrets.env to lift the cap. '
      + 'Note this cap only started being enforced on 2026-07-28 — before that a malformed value parsed to NaN and the limit never applied.',
    speech: 'Sir, my voice budget for today is spent — I am on the browser voice until it resets.',
  }).catch(() => {});
}

/**
 * Add to the day's spend ATOMICALLY.
 *
 * The `prev` argument is gone on purpose (2026-07-30, found by the code-health
 * spine). This used to POST the absolute value `prev + chars`, where `prev` was a
 * snapshot taken BEFORE a multi-second ElevenLabs call — so concurrent speech
 * lost updates: three clients fetching /tts for the same alert all read 1000 and
 * all wrote 1000+N, recording one utterance instead of three. A spend cap that
 * under-counts is not a cap.
 *
 * memory-server's /memory/kv/incr does the read and the write inside its own
 * single-threaded process, where they cannot interleave. The signature keeps a
 * trailing optional arg so an old three-argument call still works — it is simply
 * ignored, rather than silently reintroducing the absolute write.
 */
export async function budgetAdd(day, chars, _ignoredPrev) {
  try {
    await fetch(`${memBase()}/memory/kv/incr`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: `tts-budget-${day}`, by: chars }),
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
// One paid synthesis per distinct string, however many callers ask at once
// (2026-07-30, found by the code-health spine's money-paths lens). The
// cache-hit decision is a single existsSync at entry and the file is only written
// after the ElevenLabs round-trip returns — so every request that lands inside
// that window missed the cache and paid for its own copy of the SAME sentence.
// Both deck notification paths broadcast an alert in the same tick as an
// un-awaited pre-warm, and each connected device then fetches /tts for the
// identical text, so the overlap is the normal case, not the rare one. Same shape
// as the double-Chromium launch fixed earlier today: memoise the WORK, not just
// its result.
const inFlight = new Map();   // cache key → Promise<{buf}|{reason}>

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

  const pending = inFlight.get(cached);
  if (pending) return pending;
  const work = synthesizeUncached(text, cached).finally(() => inFlight.delete(cached));
  inFlight.set(cached, work);
  return work;
}

async function synthesizeUncached(text, cached) {

  const day = new Date().toISOString().slice(0, 10);
  const spent = await budgetSpent(day);
  if (spent + text.length > BUDGET) {
    console.warn(`[tts] daily budget reached (${spent}/${BUDGET} chars) — falling back`);
    // Craig hears this as "it's fallen to a different voice" with no
    // explanation. Doctrine on this box is that a downgrade is never silent
    // (the 2026-07-18 Gemini incident), and this one had no signal at all
    // because until 2026-07-28 the cap was NaN and never actually fired --
    // guardrail() made it real, so this path is newly reachable. Announce it
    // once a day; the fallback itself is correct and still happens.
    announceBudget(day, spent);
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

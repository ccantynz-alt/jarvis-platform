/**
 * transcript.js — ONE durable conversation, shared by every surface Craig
 * talks to.
 *
 * Before this module the deck (:9210) and the gateway (:9208) each kept their
 * own idea of "the conversation", and they were not equals:
 *
 *   deck-server.js  — a module-level array persisted to memory KV, shared
 *                     across devices and reloads, with failed-brain turns
 *                     still recorded (the 2026-07-24 continuity fix).
 *   gateway-server.js — `const transcript = []` INSIDE the ws connection
 *                     handler. Per-connection. Never persisted. Never shared.
 *                     Reload the page, swap phone for iPad, or restart the
 *                     unit and the whole conversation was gone — on the
 *                     interface CLAUDE.md calls "THE interface". It also
 *                     never received the 2026-07-24 fix, so a brain hiccup
 *                     spliced the exchange away with no durable record.
 *
 * That asymmetry is why Jarvis "had no memory" on voice while seeming fine on
 * the deck. One store, one key, both surfaces — start a thought on the phone,
 * finish it on the deck.
 *
 * runAgent() mutates the array in place and bounds it to the last 24 messages,
 * so this module owns loading, saving, and the fallback-turn record only.
 */

const MEMORY = process.env.JARVIS_MEMORY_URL || 'http://127.0.0.1:9200';

// The deck wrote here before the two surfaces were unified. Read it once so an
// in-flight conversation survives the upgrade, then write only to the new key.
const LEGACY_KEY = 'deck-conversation';
const KEY = 'jarvis-conversation';

const MAX_MESSAGES = 24;   // matches runAgent's own bound
const SAVE_DEBOUNCE_MS = 400;

let transcript = null;     // the one shared array
let loading = null;        // in-flight load, so concurrent turns don't double-fetch
let saveTimer = null;
let lastSaveFailedAt = 0;

async function readKey(key) {
  const r = await fetch(`${MEMORY}/memory/kv/${key}`);
  if (!r.ok) return null;                      // 404 = never written
  const parsed = JSON.parse((await r.json())?.value || '[]');
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * The shared conversation. Safe to call concurrently — the first call owns the
 * fetch and everyone else awaits it, so two utterances landing together can't
 * produce two divergent arrays (the old per-server code could).
 */
export async function loadTranscript() {
  if (transcript) return transcript;
  if (loading) return loading;
  loading = (async () => {
    try {
      transcript = (await readKey(KEY)) || (await readKey(LEGACY_KEY)) || [];
    } catch {
      transcript = [];                         // memory down — start clean, don't crash a turn
    }
    return transcript;
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Persist. Debounced because a single turn can touch the array several times,
 * and a write per touch is pure churn against SQLite.
 *
 * A failed write is LOGGED, not swallowed. The old fire-and-forget
 * `.catch(() => {})` meant memory-server being down looked exactly like
 * everything working — right up until the next restart lost the day.
 */
export function saveTranscript() {
  if (!transcript || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!transcript) return;
    const snapshot = JSON.stringify(transcript.slice(-MAX_MESSAGES));
    try {
      const r = await fetch(`${MEMORY}/memory/kv`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: KEY, value: snapshot }),
      });
      if (!r.ok) throw new Error(`memory KV returned ${r.status}`);
    } catch (e) {
      // Once a minute at most — a wedged memory-server must not become a
      // log flood on every utterance.
      if (Date.now() - lastSaveFailedAt > 60_000) {
        lastSaveFailedAt = Date.now();
        console.error(`[transcript] could not persist conversation: ${e.message}`);
      }
    }
  }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

/**
 * Record a turn the reasoning brain could NOT serve.
 *
 * Craig, 2026-07-24: "within 30 seconds it completely forgot what we were
 * organising". The caller splices its partial turn off the transcript when the
 * brain throws, which used to erase his message AND the answer — so the next
 * brain turn had no idea the exchange happened. The keyword pipeline has no
 * memory of its own; this is what gives it one.
 */
export async function recordFallbackTurn(userText, replyText) {
  try {
    const t = await loadTranscript();
    t.push({ role: 'user', content: String(userText) });
    t.push({
      role: 'assistant',
      content: `[via basic pipeline while the main brain was unavailable] ${String(replyText).slice(0, 500)}`,
    });
    if (t.length > MAX_MESSAGES) t.splice(0, t.length - MAX_MESSAGES);
    saveTranscript();
  } catch { /* recording is best-effort — never block a reply on it */ }
}

/** Test seam only — drops the in-process cache. */
export function _reset() {
  transcript = null;
  loading = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

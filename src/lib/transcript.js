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

const LOAD_ATTEMPTS = 4;
const LOAD_BACKOFF_MS = 250;

let transcript = null;     // the one shared array
let loading = null;        // in-flight load, so concurrent turns don't double-fetch
let saveTimer = null;
let lastSaveFailedAt = 0;
// What we believe the STORE holds. Everything in `transcript` beyond this is
// ours-since-the-last-successful-save, and is the only thing a save may add.
// Without it a save cannot tell "my new turn" from "the other surface's turn",
// which is what made the write destructive — see saveTranscript.
let baseline = [];
// Did we ever successfully READ the store? Until we have, we do not know what
// the conversation is, and must not overwrite it. See loadTranscript.
let loaded = false;

/** null = key genuinely absent (404). Throws if the store can't be reached. */
async function readKey(key) {
  const r = await fetch(`${MEMORY}/memory/kv/${key}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`memory KV returned ${r.status}`);
  const parsed = JSON.parse((await r.json())?.value || '[]');
  return Array.isArray(parsed) ? parsed : null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * The shared conversation. Safe to call concurrently — the first call owns the
 * fetch and everyone else awaits it, so two utterances landing together can't
 * produce two divergent arrays (the old per-server code could).
 *
 * BOOT RACE (2026-07-28): the units order deck/gateway `After=
 * jarvis-memory.service`, but After= only means memory-server was STARTED, not
 * that node has bound :9200. A read that lands in that window used to be
 * indistinguishable from "no history": we cached [] and the very next
 * saveTranscript() wrote that empty array over the real conversation. Every
 * reboot could silently destroy it. So: retry a few times, and until a read
 * has actually SUCCEEDED, refuse to persist (see saveTranscript). A turn
 * still gets a usable array immediately — it just isn't allowed to become the
 * durable truth.
 */
export async function loadTranscript() {
  if (transcript) return transcript;
  if (loading) return loading;
  loading = (async () => {
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      try {
        transcript = (await readKey(KEY)) || (await readKey(LEGACY_KEY)) || [];
        baseline = transcript.slice();
        loaded = true;
        return transcript;
      } catch (e) {
        if (attempt === LOAD_ATTEMPTS - 1) {
          console.error(`[transcript] memory unreachable after ${LOAD_ATTEMPTS} attempts (${e.message}) — ` +
            'running on a scratch conversation; it will NOT be persisted over the stored one');
          transcript = [];
          return transcript;
        }
        await sleep(LOAD_BACKOFF_MS * (attempt + 1)); // 250ms, 500ms, 750ms
      }
    }
    return transcript;
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * Re-attempt the initial read after a failed boot, so a process that started
 * before memory-server can recover the real conversation instead of staying on
 * its scratch array for the rest of its life.
 *
 * Anything said while in scratch mode is deliberately dropped rather than
 * merged: the store is the truth, and a scratch array grafted on top would
 * duplicate whatever memory-server already had.
 */
export async function retryLoadIfUnread() {
  if (loaded || loading) return loaded;
  transcript = null;
  await loadTranscript();
  return loaded;
}

// Background recovery. Runs OFF the turn path on purpose — retrying inside
// loadTranscript() would put the load backoff (up to ~1.5s) in front of every
// voice utterance while memory is down, and this is a voice assistant.
// Stops as soon as a read succeeds; unref'd so it never holds a process open.
const RECOVERY_INTERVAL_MS = 30_000;
const recovery = setInterval(() => {
  if (loaded) return clearInterval(recovery);
  retryLoadIfUnread().then((ok) => {
    if (ok) {
      clearInterval(recovery);
      console.log('[transcript] memory reachable again — recovered the stored conversation');
    }
  }).catch(() => {});
}, RECOVERY_INTERVAL_MS);
recovery.unref?.();

/**
 * Persist. Debounced because a single turn can touch the array several times,
 * and a write per touch is pure churn against SQLite.
 *
 * A failed write is LOGGED, not swallowed. The old fire-and-forget
 * `.catch(() => {})` meant memory-server being down looked exactly like
 * everything working — right up until the next restart lost the day.
 */
const sameMsg = (a, b) => !!a && !!b && a.role === b.role && a.content === b.content;

/**
 * Which messages in `local` are ours-since-the-baseline?
 *
 * NOT a length comparison. runAgent bounds the array to 24 messages IN PLACE
 * after pushing, so once the conversation reaches the cap — which it always does
 * — appending two turns leaves the length unchanged. A length diff therefore sees
 * "nothing new" forever and silently stops persisting every turn. That is exactly
 * what happened when this merge first shipped: unit tests passed (short arrays,
 * no trimming) and the live deck-then-gateway run showed both turns vanishing.
 *
 * The real relationship is `local === baseline.slice(k) + ourNew` for some k
 * messages trimmed off the front, so find the smallest k whose remainder is a
 * prefix of local. No match (the rollback path spliced the array) → nothing new,
 * rather than a guess.
 */
export function newSince(local, base) {
  if (!base.length) return local.slice();
  // k stops BEFORE base.length on purpose: an empty tail matches anything, so
  // allowing it would call the entire local array "new" whenever no real overlap
  // exists — duplicating turns on the rollback path. No overlap means we cannot
  // tell what is new, and the honest answer to that is "nothing".
  for (let k = 0; k < base.length; k++) {
    const tail = base.slice(k);
    if (tail.length > local.length) continue;
    let match = true;
    for (let i = 0; i < tail.length; i++) {
      if (!sameMsg(tail[i], local[i])) { match = false; break; }
    }
    if (match) return local.slice(tail.length);
  }
  return [];
}

/**
 * Fold our new turns onto whatever the store now holds.
 *
 * Skips a turn that already sits at the tail of the stored array, so a partially
 * applied save can't duplicate it. Exported for tests.
 */
export function mergeTail(stored, ourNew, max = MAX_MESSAGES) {
  const out = stored.slice();
  for (const m of ourNew) {
    if (sameMsg(out[out.length - 1], m)) continue;
    out.push(m);
  }
  return out.slice(-max);
}

export function saveTranscript() {
  if (!transcript || saveTimer) return;
  // Never let a scratch conversation overwrite the stored one — see the boot
  // race in loadTranscript. Silence here is correct: the alternative is
  // destroying real history.
  if (!loaded) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!transcript) return;

    // RE-READ, THEN MERGE (2026-07-30, found by the code-health spine and
    // independently by the 2026-07-26 audit). This used to write
    // `transcript.slice(-MAX)` as the complete new value — a whole-array
    // overwrite from a cache that loadTranscript() never refreshes. The deck
    // (:9210) and the gateway (:9208) are separate processes with separate
    // caches, and both save. So: Craig has a long conversation on the deck, then
    // says one sentence to the gateway, and the gateway writes ITS stale array
    // plus that sentence over the top — the whole deck conversation is gone.
    // "One conversation, all surfaces" was the headline feature, and using two
    // surfaces was what broke it.
    //
    // Only what WE added since the last successful save may be appended. If the
    // local array is shorter than the baseline (the brain-failure rollback path
    // splices it), we add nothing rather than trying to be clever.
    const ourNew = newSince(transcript, baseline);

    let stored;
    try {
      stored = await readKey(KEY);
    } catch (e) {
      // The store is unreachable. Do NOT fall back to writing our copy — that is
      // precisely the destructive behaviour being removed here. The turn is safe
      // in memory and the next save will carry it, with the baseline unmoved.
      if (Date.now() - lastSaveFailedAt > 60_000) {
        lastSaveFailedAt = Date.now();
        console.error(`[transcript] could not read before saving (${e.message}) — holding this turn, not overwriting`);
      }
      return;
    }

    const merged = mergeTail(stored || [], ourNew);
    // Adopt the merge into the SHARED array in place: runAgent and both servers
    // hold a reference to it, so reassigning would silently orphan them.
    transcript.splice(0, transcript.length, ...merged);

    const snapshot = JSON.stringify(merged);
    try {
      const r = await fetch(`${MEMORY}/memory/kv`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: KEY, value: snapshot }),
      });
      if (!r.ok) throw new Error(`memory KV returned ${r.status}`);
      baseline = merged.slice();   // only a CONFIRMED write moves the baseline
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
  return recordTurn(userText, replyText, '[via basic pipeline while the main brain was unavailable] ');
}

/**
 * Record an exchange the reasoning brain did not produce.
 *
 * Two things answer Craig without the brain: the keyword pipeline (above) and
 * the dispatch confirmation gate, which intercepts the confirming turn and
 * returns before any brain runs. Neither used to reach the transcript, so the
 * brain's next turn had no idea the exchange happened — on 2026-07-30 that made
 * it talk about a job as still-staged after the gate had already launched it.
 */
export async function recordTurn(userText, replyText, prefix = '') {
  try {
    const t = await loadTranscript();
    t.push({ role: 'user', content: String(userText) });
    t.push({ role: 'assistant', content: `${prefix}${String(replyText).slice(0, 500)}` });
    if (t.length > MAX_MESSAGES) t.splice(0, t.length - MAX_MESSAGES);
    saveTranscript();
  } catch { /* recording is best-effort — never block a reply on it */ }
}

/** Test seam only — drops the in-process cache. */
export function _reset() {
  transcript = null;
  loading = null;
  loaded = false;
  lastSaveFailedAt = 0;
  baseline = [];
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

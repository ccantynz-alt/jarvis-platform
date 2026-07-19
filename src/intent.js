/**
 * Jarvis intent detection — src/intent.js
 *
 * Pure functions, no I/O: slack-bridge.js supplies the live platform list.
 * This is the keyword tier; the Haiku classifier in slack-bridge handles
 * whatever this tier isn't confident about.
 *
 * Fixes over the old in-bridge version:
 *  - "hey jarvis, ..." no longer matches the registered platform `jarvis`
 *    (the address prefix is stripped before platform matching)
 *  - "can you fix vapron signup" is a dispatch, not a question — polite
 *    prefixes are stripped before the question-word check
 *  - unrecognized text is `unclear`, NEVER auto-dispatched to the orchestrator
 *  - new notification-control intents: mute / unmute / digest / notif-status
 */

export const DISPATCH_VERBS = [
  'fix', 'upgrade', 'build', 'repair', 'add', 'create', 'update', 'deploy', 'run', 'scan',
  'restart', 'rebuild', 'redeploy', 'debug', 'investigate', 'improve', 'change',
  'optimize', 'optimise', 'implement', 'install', 'remove', 'migrate', 'refactor', 'audit',
];

const QUESTION_WORDS = ['what', 'how', 'why', 'is', 'are', 'does', 'when', 'who', 'where'];

/** Strip Slack formatting tags, the "hey jarvis" address, and polite lead-ins. */
export function normalizeText(raw) {
  let text = String(raw || '').replace(/<[^>]+>/g, '').trim();

  // Address prefix: "jarvis", "hey jarvis,", "ok jarvis:" — this is Craig
  // talking TO jarvis, not about the jarvis platform.
  text = text.replace(/^(hey|hi|ok|okay|yo|hello)?[\s,]*jarvis[\s,:!.-]+/i, '');

  // Polite lead-ins, possibly stacked: "please can you just fix..."
  const POLITE = /^(please|pls|just|can you|could you|would you|will you|kindly|go ahead and|go)\s+/i;
  for (let i = 0; i < 4 && POLITE.test(text); i++) text = text.replace(POLITE, '');

  return text.trim();
}

/**
 * Match a platform name in free text. Word-boundary first, then substring,
 * then a 5-char prefix as last resort (4 chars caused false hits: "booking"
 * → bookaride, "gateway" → gatetest).
 */
export function matchPlatform(text, names) {
  const lower = String(text).toLowerCase();
  for (const p of names) {
    if (new RegExp(`\\b${p}\\b`).test(lower)) return p;
  }
  for (const p of names) {
    if (lower.includes(p)) return p;
  }
  for (const p of names) {
    if (p.length >= 5 && new RegExp(`\\b${p.slice(0, 5)}`).test(lower)) return p;
  }
  return null;
}

/**
 * Classify raw Slack text into an intent:
 *   ask | dispatch | jobs | status | platform-status | briefing | help |
 *   mute | unmute | digest | notif-status | unclear
 *
 * `confident: true` → act on it directly.
 * `confident: false` → let the Haiku classifier take a look first.
 */
export function detectIntent(raw, platforms = []) {
  const text = normalizeText(raw).toLowerCase();
  if (!text) return { type: 'unclear', confident: true };

  const words = text.split(/\s+/).filter(Boolean);
  const isShortCommand = words.length <= 4;

  // ── Notification controls — always confident, checked first ──────────────
  if (/^(unmute|notifications?\s+(on|back on|resume)|resume notifications?)\b/.test(text)) {
    return { type: 'unmute', confident: true };
  }
  if (/^(mute( all)?|silence|quiet|shut up)\b/.test(text)
      || /^(stop|no more)( sending( me)?)? (the )?(notifications?|alerts?|messages?|pings?|spam)/.test(text)
      || /^notifications?\s+off\b/.test(text)) {
    return { type: 'mute', all: /\ball\b|\beverything\b|\bincluding critical\b/.test(text), rawText: text, confident: true };
  }
  if (/^(digest|flush digest|send( me)? the digest|what('| i)?s (queued|pending))\b/.test(text)) {
    return { type: 'digest', confident: true };
  }
  if (/^notifications?( status| settings)?$/.test(text) || /^notification (status|settings)\b/.test(text)) {
    return { type: 'notif-status', confident: true };
  }

  // ── "ask jarvis ..." memory questions ─────────────────────────────────────
  if (/^ask\s+/.test(text)) {
    const question = normalizeText(raw).replace(/^ask\s+(jarvis\s+)?/i, '').trim();
    return { type: 'ask', question, confident: true };
  }

  if (/\b(briefing|morning report|daily report|morning|good morning)\b/.test(text)) {
    return { type: 'briefing', confident: isShortCommand };
  }

  if (/\bjobs?\b|\bwhat'?s running\b|\bwhat are you doing\b|\bqueue\b|\brunning tasks?\b/.test(text)) {
    return { type: 'jobs', confident: isShortCommand };
  }

  if (/\b(help|commands?|what can you do)\b/.test(text)) {
    return { type: 'help', confident: isShortCommand };
  }

  const platform = matchPlatform(text, platforms);

  // Dispatch — an action verb up front is a command, even in a long sentence.
  // "fix the signup flow on vapron" / (after normalize) "can you fix..." both land here.
  const verbFirst = DISPATCH_VERBS.includes(words[0]);
  const hasVerb = verbFirst || DISPATCH_VERBS.some(v => new RegExp(`\\b${v}\\b`).test(text));

  if (verbFirst) {
    return { type: 'dispatch', platform: platform ?? 'auto', task: normalizeText(raw), confident: !!platform };
  }

  // Explicit status queries
  if (platform && /\b(how is|how'?s|check|status of|health of|what'?s (wrong|up|happening) with|is .* (up|down|working|broken))\b/.test(text)) {
    return { type: 'platform-status', platform, confident: true };
  }
  if (!platform && /\b(status|health)\b/.test(text)) {
    return { type: 'status', confident: isShortCommand };
  }

  // Genuine questions → status-ish, low confidence (Haiku decides)
  const isQuestion = QUESTION_WORDS.some(w => new RegExp(`^${w}\\b`).test(text)) || text.endsWith('?');
  if (isQuestion) {
    return platform
      ? { type: 'platform-status', platform, confident: false }
      : { type: 'status', confident: false };
  }

  // Verb buried mid-sentence → probable dispatch, not confident
  if (hasVerb) {
    return { type: 'dispatch', platform: platform ?? 'auto', task: normalizeText(raw), confident: false };
  }

  // Platform mentioned with no verb → probably asking about it
  if (platform) {
    return { type: 'platform-status', platform, confident: false };
  }

  // Nothing matched. NOT a dispatch — the old auto-dispatch fallback caused
  // spurious agent runs and "Which platform?" spam.
  return { type: 'unclear', confident: false };
}

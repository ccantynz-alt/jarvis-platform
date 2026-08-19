/**
 * Jarvis conversation engine — src/lib/conversation.js
 *
 * Transport-neutral intent detection + command handlers, originally
 * extracted verbatim from slack-bridge.js (2026-07-08, Gateway build — see
 * docs/GATEWAY.md). CORRECTION 2026-07-20: an earlier revision of this
 * comment claimed slack-bridge.js was deleted/retired — wrong, see
 * docs/ROADMAP.md's decisions-locked table for the correction. slack-bridge.js
 * is alive, frozen-legacy, and now has its OWN separate keyword-tier
 * classifier (src/intent.js, added by PR #1 2026-07-19) — this module is
 * consumed by src/gateway-server.js (the Jarvis Gateway, voice/text over
 * tailnet) only; the two intent systems are parallel, not shared, despite
 * this file's own history.
 *
 * Handlers return { text, speech, data }:
 *   text   — full formatted reply (Slack mrkdwn strings, unchanged from the
 *            original bridge; the Gateway renders them as-is)
 *   speech — short spoken form for TTS (≤ ~2 sentences)
 *   data   — raw structured payload where useful
 * Multi-message flows (dispatch) emit interim messages via an onEvent callback.
 */

import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { authHold } from './claude-auth.js';
import { notify } from './notify.js';

// ── Roadmap (project-completion checklist — "are we done yet", not health) ──
// Structured twin of docs/ROADMAP.md's "THE 20 MOVES". Kept in sync manually,
// same commit, per Rule 0 (see docs/GATEWAY.md).

export function loadRoadmap() {
  const raw = JSON.parse(readFileSync('/opt/jarvis/config/roadmap.json', 'utf8'));
  let done = 0, total = 0, current = null;
  for (const phase of raw.phases) {
    for (const move of phase.moves) {
      total++;
      if (move.status === 'done') done++;
      if (!current && move.status === 'in_progress') current = { phase: phase.name, title: move.title };
    }
  }
  return {
    updated: raw.updated,
    doneCount: done,
    totalCount: total,
    percent: Math.round((done / total) * 100),
    current,
    phases: raw.phases,
  };
}

// ── Service endpoints ────────────────────────────────────────────────────────

export const ORCHESTRATOR = 'http://127.0.0.1:9205';
export const MEMORY       = 'http://127.0.0.1:9200';
export const SCREENSHOT   = 'http://127.0.0.1:9201';
export const METRICS      = 'http://127.0.0.1:9202';

// Known live URLs for screenshot — derive from platform name when not listed
export const PLATFORM_URLS = {
  zoobicon: 'https://zoobicon.com',
  vapron:   'https://vapron.ai',
  alecrae:  'https://alecrae.com',
  gatetest: 'https://gatetest.ai',
  voxlen:   'https://www.voxlen.ai',
  bookaride:'https://www.bookaride.co.nz',
};

// ── Platform registry ────────────────────────────────────────────────────────

export function loadPlatforms() {
  try {
    const raw = readFileSync('/opt/jarvis/config/platforms.json', 'utf8');
    return JSON.parse(raw).platforms;
  } catch {
    return {};
  }
}

export function platformNames() {
  return Object.keys(loadPlatforms());
}

/**
 * Fuzzy-match a platform name from free text.
 * Tries word-boundary, substring, then 4-char prefix.
 */
export function matchPlatform(text) {
  const lower = text.toLowerCase();
  const names = platformNames();

  for (const p of names) {
    if (new RegExp(`\\b${p}\\b`).test(lower)) return p;
  }
  for (const p of names) {
    if (lower.includes(p)) return p;
  }
  for (const p of names) {
    if (p.length >= 4 && lower.includes(p.slice(0, 4))) return p;
  }
  return null;
}

// ── Intent detection ──────────────────────────────────────────────────────────

const DISPATCH_VERBS = [
  'fix', 'upgrade', 'build', 'repair', 'add', 'create', 'update', 'deploy', 'run', 'scan',
];

const QUESTION_WORDS = ['what', 'how', 'why', 'is', 'are', 'does', 'can'];

/**
 * Classify raw message text into one of:
 *   dispatch | jobs | status | platform-status | briefing | help | passthrough
 *
 * Each result carries `confident: true|false`:
 *   true  → exact/clear command (short direct command, explicit "ask jarvis",
 *           explicit "how is X / check X" phrasing) — safe fast path
 *   false → matched a fallback/default rule (question fallthrough, guessed
 *           dispatch platform, incidental keyword hit in a long sentence) —
 *           resolveIntent will consult the Haiku classifier
 */
export function detectIntent(raw) {
  // Strip Slack formatting tags, normalise whitespace
  const text = raw.toLowerCase().replace(/<[^>]+>/g, '').trim();

  // Short direct commands ("status", "jobs", "morning briefing") are confident;
  // long natural sentences that happen to contain a keyword are not.
  const isShortCommand = text.split(/\s+/).filter(Boolean).length <= 4;

  // "ask jarvis ..." — highest priority, must match before other rules
  if (/^ask\s+(jarvis\s+)?/.test(text)) {
    const question = raw.replace(/<[^>]+>/g, '').replace(/^ask\s+(jarvis\s+)?/i, '').trim();
    return { type: 'ask', question, confident: true };
  }

  if (/\b(briefing|morning report|daily report|morning|good morning)\b/.test(text)) {
    return { type: 'briefing', confident: isShortCommand };
  }

  if (/\b(roadmap|what'?s left|whats left|how (much|far)|are we done|project (progress|status)|% complete|percent complete)\b/.test(text)) {
    return { type: 'roadmap', confident: isShortCommand || /what'?s left|whats left|are we done/.test(text) };
  }

  if (/\bjobs?\b|\bwhat'?s running\b|\bwhat are you doing\b|\bqueue\b|\brunning tasks?\b/.test(text)) {
    return { type: 'jobs', confident: isShortCommand };
  }

  if (/\b(help|commands?|what can you do)\b/.test(text)) {
    return { type: 'help', confident: isShortCommand };
  }

  const platform = matchPlatform(text);

  // "how is X", "check X", "X status" — explicit status query with platform
  if (platform && /\b(how is|check|status of|health of|what'?s (wrong|up) with|is .* (up|down|working))\b/.test(text)) {
    return { type: 'platform-status', platform, confident: true };
  }

  // General status — no platform name, just "status" / "health"
  if (!platform && /\b(status|health)\b/.test(text)) {
    return { type: 'status', confident: isShortCommand };
  }

  // Questions (what/how/why/is/are/does/can) → status, never dispatch
  // Fallthrough guess — not confident, let Haiku have a look.
  const isQuestion = QUESTION_WORDS.some(w => new RegExp(`^${w}\\b`).test(text));
  if (isQuestion) {
    return platform
      ? { type: 'platform-status', platform, confident: false }
      : { type: 'status', confident: false };
  }

  // Dispatch — has a recognised action verb. Platform may be guessed/defaulted,
  // and verb matching is substring-level — not confident.
  const hasVerb = DISPATCH_VERBS.some(v => new RegExp(`\\b${v}\\b`).test(text));
  if (hasVerb) {
    return { type: 'dispatch', platform: platform ?? 'auto', confident: false };
  }

  // Platform mentioned without a clear verb → treat as status query (guess)
  if (platform) {
    return { type: 'platform-status', platform, confident: false };
  }

  // Nothing matched → passthrough to orchestrator
  return { type: 'passthrough', confident: false };
}

// ── LLM intent classification (Claude Haiku via local `claude` CLI) ──────────
//
// Used only when detectIntent() returns a non-confident (fallback/guessed)
// result. Spawns the locally-authenticated `claude` CLI — no API keys touched.
// Returns a validated intent object, or null on ANY failure (timeout, non-zero
// exit, unparseable output, unknown type/platform) so callers can fall back
// to the keyword result.

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CLASSIFY_TIMEOUT_MS = 20000;
const INTENT_TYPES = ['ask', 'dispatch', 'jobs', 'status', 'platform-status', 'briefing', 'help', 'roadmap'];

function buildClassifyPrompt(text) {
  const platforms = platformNames();
  return [
    'You classify Slack messages sent to Jarvis, an ops assistant that manages web platforms.',
    'Classify the message below into exactly one intent type:',
    '',
    '- "dispatch": user wants work done on a platform (fix, build, change, deploy something). Shape: {"type":"dispatch","platform":"<name or null>","task":"<what to do>"}',
    '- "ask": a knowledge/history question for the memory system (what broke, what happened, past issues). Shape: {"type":"ask","question":"<the question>"}',
    '- "jobs": asking what jobs/tasks are currently running or queued. Shape: {"type":"jobs"}',
    '- "status": general system/server health overview, not about one specific platform. Shape: {"type":"status"}',
    '- "platform-status": health/state of one specific platform, incl. "why is X slow/down/broken" diagnostics. Shape: {"type":"platform-status","platform":"<name>"}',
    '- "briefing": a morning/daily summary or rundown of everything. Shape: {"type":"briefing"}',
    '- "help": asking what Jarvis can do, or the message is unparseable/unclear. Shape: {"type":"help"}',
    '- "roadmap": asking how much of the JARVIS PROJECT ITSELF is built/left to build, or for a completion percentage (not a platform\'s health). Shape: {"type":"roadmap"}',
    '',
    `Known platforms: ${platforms.join(', ')}`,
    'Set "platform" to null if no known platform is mentioned.',
    'Respond with STRICT JSON only — a single object, no prose, no markdown fences.',
    '',
    `Message: ${JSON.stringify(text)}`,
  ].join('\n');
}

// HTTP Messages API path (KNOWN DEBT #1 fix, 2026-07-20): cuts classify
// latency from a ~3-10s CLI cold-start to ~300ms. Only runs when
// ANTHROPIC_API_KEY is configured (the same key agent.js's metered fallback
// providers use — never the CLI workers' subscription login, see
// spawn-agent.js). Falls through to the CLI path on any failure (missing
// key, network issue, bad key) so behavior never regresses versus before.
async function runClaudeHttp(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.warn(`[conversation] haiku HTTP classify ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return null;
    }
    const j = await r.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return text || null;
  } catch (e) {
    console.warn('[conversation] haiku HTTP classify failed, falling back to CLI:', e.message);
    return null;
  }
}

function runClaudeCli(prompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const env = { ...process.env, HOME: '/root' };
    // The services load ANTHROPIC_API_KEY from secrets.env; if it leaks into
    // the CLI it overrides the claude.ai subscription login (and fails hard
    // when the key has no credits). The CLI must run on the local login.
    delete env.ANTHROPIC_API_KEY;
    const proc = spawn('claude', ['--model', HAIKU_MODEL, '--print', prompt], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      console.warn('[conversation] haiku classify timed out — killing CLI');
      proc.kill('SIGKILL');
      done(null);
    }, CLASSIFY_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      console.warn('[conversation] haiku classify spawn error:', e.message);
      done(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[conversation] haiku classify exit ${code}: ${stderr.slice(0, 200)}`);
        return done(null);
      }
      done(stdout);
    });
  });
}

export async function classifyIntent(text) {
  const prompt = buildClassifyPrompt(text);
  // The CLI leg runs on the subscription login; while every login is inside
  // its auth cooldown it is a guaranteed 2-second exit 1 after up to 20 s of
  // dead air in the one mode where speed is all the fallback has (2026-08-19).
  const cliOk = !authHold().held;
  const output = (await runClaudeHttp(prompt)) ?? (cliOk ? await runClaudeCli(prompt) : null);
  if (!output) return null;

  // Defensive parse: strip markdown fences, isolate the first {...} object
  let body = output.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const braces = body.match(/\{[\s\S]*\}/);
  if (braces) body = braces[0];

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    console.warn('[conversation] haiku classify unparseable output:', output.slice(0, 200));
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !INTENT_TYPES.includes(parsed.type)) {
    console.warn('[conversation] haiku classify invalid intent:', JSON.stringify(parsed).slice(0, 200));
    return null;
  }

  // Validate platform against the live registry; unknown → null
  let platform = typeof parsed.platform === 'string' ? parsed.platform.toLowerCase().trim() : null;
  if (platform && !platformNames().includes(platform)) platform = null;

  const intent = { type: parsed.type };
  if (parsed.type === 'dispatch') {
    intent.platform = platform ?? 'auto';
    if (typeof parsed.task === 'string' && parsed.task.trim()) intent.task = parsed.task.trim();
  } else if (parsed.type === 'platform-status') {
    if (!platform) return null; // handler requires a real platform
    intent.platform = platform;
  } else if (parsed.type === 'ask') {
    intent.question = (typeof parsed.question === 'string' && parsed.question.trim()) || text;
  }
  return intent;
}

/**
 * Unified intent resolution — keyword fast path, Haiku consult on low
 * confidence. Returns { intent, via, ms }. Same logic both bridges ran inline.
 */
export async function resolveIntent(rawText) {
  const t0 = Date.now();
  let intent = detectIntent(rawText);
  let via = 'keyword';

  // Keyword result was a fallback/guess — ask Haiku, prefer its answer if valid
  if (!intent.confident) {
    const haiku = await classifyIntent(rawText);
    if (haiku) {
      intent = haiku;
      via = 'haiku';
    }
  }
  return { intent, via, ms: Date.now() - t0 };
}

// ── Safe JSON fetch ──────────────────────────────────────────────────────────
// Memory service occasionally appends an HTML 404 page after the JSON body.
// Strip it before parsing so we get the real data instead of a parse error.

export async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  const trimmed = text.replace(/<!DOCTYPE[\s\S]*$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('Memory service unavailable');
  }
}

// ── Command handlers — return { text, speech, data } ─────────────────────────

export async function handleAsk(question) {
  if (!question) {
    return {
      text: 'Ask me something — e.g. "ask jarvis what broke on vapron this week"',
      speech: 'Ask me something, for example: what broke on vapron this week.',
    };
  }
  try {
    const r = await fetchJSON(`${MEMORY}/memory/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const answer = r.answer || 'No answer found.';
    return { text: `🧠 ${answer}`, speech: String(answer).slice(0, 280), data: r };
  } catch (e) {
    return { text: `❌ Memory query failed: ${e.message}`, speech: 'Sorry, the memory query failed.' };
  }
}

/**
 * Dispatch is multi-message: emits the interim "Dispatching..." via onEvent,
 * returns the final job-started/failure message.
 */
export async function handleDispatch(rawText, platform, onEvent = () => {}) {
  const task = rawText.replace(/<[^>]+>/g, '').trim();
  let resolvedPlatform = platform;

  if (platform === 'auto') {
    resolvedPlatform = matchPlatform(task);
    if (!resolvedPlatform) {
      const known = platformNames().join(', ');
      return {
        text: `Which platform? Known: ${known}`,
        speech: 'Which platform should I use?',
      };
    }
  }

  await onEvent({
    text: `🤖 Dispatching to *${resolvedPlatform}*...\nTask: _${task.slice(0, 200)}_`,
    speech: `Dispatching to ${resolvedPlatform}.`,
  });

  try {
    const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: resolvedPlatform, task }),
    });
    const data = await r.json();

    if (data.error) {
      const known = data.known?.length ? `\nKnown platforms: ${data.known.join(', ')}` : '';
      return {
        text: `❌ Dispatch failed: ${data.error}${known}`,
        speech: `Dispatch failed. ${data.error}`,
        data,
      };
    }
    return {
      text: `✅ Job started — ID: \`${data.jobId}\`\nPlatform: *${resolvedPlatform}* | Claude agent is running...`,
      speech: `Job started on ${resolvedPlatform}. The agent is running.`,
      data,
    };
  } catch (e) {
    return {
      text: `❌ Orchestrator unreachable: ${e.message}`,
      speech: 'The orchestrator is unreachable.',
    };
  }
}

// ── Dispatch confirmation gate ───────────────────────────────────────────────
// Dispatching spawns a full-permission worker that can commit and push to a
// production branch — it must NEVER fire from a single turn, whether the request
// came through the agent brain OR the keyword fallback. The gate ({turn, pending})
// lives on the connection: a preview stamps the turn it was shown in, and the job
// only runs when the user affirms in a LATER turn. This is the sole execution path.
//
// 2026-07-30 — THE GATE THAT NEVER OPENED. Craig staged a repair, answered it
// with a bare "please", and nothing ever launched. Two defects, both here:
//   1. The yes-vocabulary was a short anchored regex that knew "please do" but
//      not "please". He confirms out loud, in his own words, through speech
//      recognition — "please", "ok", "go on", "launch it", "yes mate" are all
//      the same word to him, and only one of them used to count.
//   2. Anything that did not match SILENTLY DELETED the staged job. He was never
//      told, so from his side the gate simply swallowed the confirmation. The
//      brain then re-staged the identical job and said "I've passed your yes
//      through, sir" — the exact hallucination the truthfulness rule forbids,
//      produced because the gate left it nothing truthful to say.
// So: classify a whole reply against a vocabulary of affirmations rather than a
// phrase list, hold the pending across a few turns of ordinary conversation
// instead of dropping it at the first one, and always leave a trace
// (gate.launched / gate.lapsed) that the brain reads in its status digest.

const GATE_TTL_TURNS = 3;   // turns of unrelated talk a staged job survives

// Lower-case, drop Slack tags and the "hey jarvis" address prefix, keep only
// letters/digits/apostrophes. Deliberately NOT intent.js's normalizeText: that
// one strips "please" and "go" as polite lead-ins, which is exactly the signal
// this gate needs to read.
function normReply(raw) {
  let t = String(raw || '').toLowerCase().replace(/<[^>]+>/g, ' ').trim();
  t = t.replace(/^(hey|hi|ok|okay|yo|hello)?[\s,]*jarvis\b[\s,:!.?-]*/, ' ');
  return t.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Words that on their own mean "yes, do the thing". Interjections and explicit
// approvals — none of them can be the verb of a sentence about the speaker.
const YES_STRONG = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'yah', 'aye', 'ok', 'okay', 'okey', 'kay',
  'sure', 'please', 'pls', 'proceed', 'confirm', 'confirmed', 'affirmative',
  'granted', 'approve', 'approved', 'authorised', 'authorized', 'absolutely', 'definitely',
  'certainly', 'indeed', 'correct', 'roger', 'agreed', 'agree', 'permission', 'greenlight',
]);

// Action verbs. These are NOT affirmations on their own inside a sentence — they
// need an object ("do it", "go ahead", "launch it") or must be the entire reply
// ("go").
//
// This split is the 2026-07-30 fix for an overcorrection made the same morning.
// The gate had been too NARROW (a bare "please" never fired), and widening it to
// a vocabulary made it too LOOSE: with these verbs counted as standalone
// affirmations and first-person pronouns treated as filler, the gate answered YES
// to "i need to run", "let me go", "i can do that", "you can send it" and "we
// need to go" — every one of which would have launched a staged full-permission
// agent from ordinary speech. Found by the code-health spine, on my own code,
// hours after I wrote it.
//
// The discriminator is grammatical: a confirmation is an IMPERATIVE. A sentence
// about what the speaker needs, can, or will do is not one — which is why the
// first-person pronouns and the modals came out of FILLER below.
const YES_VERB = new Set([
  'do', 'go', 'launch', 'dispatch', 'deploy', 'send', 'ship', 'run', 'fire', 'crack', 'continue', 'hit',
]);

// Particles that turn a verb into an imperative confirmation. Every member is
// also in FILLER, so compactness still passes.
const YES_OBJECT = new Set(['it', 'that', 'this', 'them', 'one', 'ahead', 'on', 'away', 'up', 'along']);

// Any of these vetoes a launch, whatever else is in the sentence — fail safe.
const NO_CORE = new Set([
  'no', 'nope', 'nah', 'naw', 'not', 'negative', 'cancel', 'cancelled', 'abort', 'stop',
  'forget', 'scrap', 'skip', 'belay', 'never', 'dont', "don't", 'wait', 'hold', 'hang', 'later',
  'leave', 'ignore', 'nevermind', 'pause', 'park', 'unstage', 'withdraw',
]);

// Words that carry no instruction of their own. A reply made only of these plus
// a core word is an acknowledgement, not a new command.
// Deliberately NOT here: the first-person pronouns (i, i'm, me, my, we, us), the
// second person (you), and the modals (can, could, would, will, need). Those are
// the words that turn an imperative into a STATEMENT — "i need to run", "you can
// send it" — and treating them as filler is what let ordinary speech launch a
// production agent. Their absence makes such a reply non-compact, so it falls
// through to the brain as a fresh command, which is the correct outcome.
const FILLER = new Set([
  'it', 'that', 'this', 'them', 'then', 'now', 'sir', 'thanks', 'thank', 'cheers', 'mate', 'man',
  'ahead', 'on', 'off', 'out', 'all', 'right', 'righto', 'fine', 'good', 'great', 'perfect',
  'lovely', 'nice', 'cool', 'well', 'and', 'the', 'a', 'an', 'to', 'for', 'of', 'by', 'with',
  'up', 'along', 'one', 'two', 'moment', 'minute', 'sec', 'second', 'time', 'course', 'means',
  'if', 'about', 'worry', 'bother', 'mind', 'yet', 'just', 'still', 'so', 'lets', "let's", 'let',
  'give', 'happy', 'away',
]);

const DEFER_RE = /\b(wait|hold|hang|later|not yet|give me|minute|moment|sec|second)\b/;

/**
 * What is this reply, in the context of a staged dispatch?
 * 'yes' launch · 'no' drop it · 'defer' keep holding · 'none' a fresh command.
 *
 * Pure and exported so the vocabulary is testable without a live orchestrator —
 * this function is the whole safety boundary between "Craig said go" and a
 * full-permission agent pushing to a production branch.
 */
export function classifyGateReply(raw) {
  const t = normReply(raw);
  if (!t) return 'none';
  const toks = t.split(' ');
  // A long sentence is a new instruction, never a bare acknowledgement.
  if (toks.length > 8) return 'none';
  const known = (w) => YES_STRONG.has(w) || YES_VERB.has(w) || NO_CORE.has(w) || FILLER.has(w);
  if (!toks.every(known)) return 'none';
  if (toks.length <= 6 && DEFER_RE.test(t)) return 'defer';
  if (toks.some(w => NO_CORE.has(w))) return 'no';

  // An explicit approval stands alone. An action verb needs an object ("do it",
  // "go ahead") or must BE the whole reply ("go") — inside a longer sentence it
  // is describing something, not authorising it.
  if (toks.some(w => YES_STRONG.has(w))) return 'yes';
  const verb = toks.some(w => YES_VERB.has(w));
  if (verb && (toks.length === 1 || toks.some(w => YES_OBJECT.has(w)))) return 'yes';
  return 'none';
}

const sameTask = (a, b) =>
  String(a || '').trim().toLowerCase().replace(/\s+/g, ' ') ===
  String(b || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Stamp a pending dispatch and return the spoken confirmation prompt. Never runs.
 *
 * Re-staging the SAME job does NOT move its confirmation turn forward. The brain
 * re-calls dispatch_job whenever it thinks a confirmation went missing, and
 * re-stamping made "yes" permanently one turn too early: every affirmation
 * arrived on the same turn as a fresh preview, which the gate must refuse.
 */
export function previewDispatch(gate, platform, task) {
  const m = `Ready to dispatch to ${platform}: ${task}. Shall I proceed, sir? Say yes and I'll launch it.`;
  if (!gate) return { text: m, speech: m, previewed: true };
  if (gate.pending && gate.pending.platform === platform && sameTask(gate.pending.task, task)) {
    gate.pending.restaged = (gate.pending.restaged || 0) + 1;
    gate.pending.expiresTurn = gate.turn + GATE_TTL_TURNS;   // he clearly still wants it
    return { text: m, speech: m, previewed: true, alreadyStaged: true };
  }
  gate.pending = { platform, task, turn: gate.turn, expiresTurn: gate.turn + GATE_TTL_TURNS };
  return { text: m, speech: m, previewed: true };
}

/**
 * Stage a PC action (2026-07-31). Craig's ruling: diagnostics on his PC run
 * instantly, anything that CHANGES the machine waits for his word — restarting
 * a service, killing a process, running a shell command.
 *
 * It deliberately reuses the dispatch gate rather than inventing a second
 * confirmation path. That gate is the only route from "Craig said go" to
 * something with full permissions, it has been got wrong twice (too narrow on
 * 2026-07-30, then too loose the same day), and every fix since has landed in
 * ONE place with ONE test file. A parallel gate would double that surface and
 * halve the attention each half gets.
 */
export function previewPcAction(gate, plan) {
  // Text carries the FULL description (for `shell`, the whole command — it
  // used to be clipped at 200 chars, so an 8,000-char payload was confirmed
  // half-seen); speech carries the short form, because TTS of PowerShell is
  // noise and a "yes" must be to something he could follow (2026-08-19).
  const m = `On the PC I'm ready to ${plan.description}. Shall I, sir? Say yes and I'll do it.`;
  const s = `On the PC I'm ready to ${plan.speech || plan.description}. Shall I, sir? Say yes and I'll do it.`;
  if (!gate) return { text: m, speech: s, previewed: true };
  const same = gate.pending && gate.pending.kind === 'pc' &&
    gate.pending.verb === plan.verb &&
    JSON.stringify(gate.pending.args || {}) === JSON.stringify(plan.args || {});
  if (same) {
    gate.pending.restaged = (gate.pending.restaged || 0) + 1;
    gate.pending.expiresTurn = gate.turn + GATE_TTL_TURNS;
    return { text: m, speech: s, previewed: true, alreadyStaged: true };
  }
  gate.pending = {
    kind: 'pc', verb: plan.verb, args: plan.args, description: plan.description,
    // platform/task are kept so every existing reader of gate.pending
    // (statusDigest, gateNote, the lapse path) keeps working unchanged.
    platform: 'craig-pc', task: plan.description.split(/\r?\n/)[0].slice(0, 160),
    turn: gate.turn, expiresTurn: gate.turn + GATE_TTL_TURNS,
  };
  return { text: m, speech: s, previewed: true };
}

/**
 * What to SAY about a PC action's output. Pure; tested in
 * test/pc-shell-read.test.js. Short plain output is spoken verbatim (whitespace
 * collapsed); a table (the '----' underline PowerShell prints) or anything
 * long gets a one-line summary and a pointer to the screen.
 */
export function spokenPcResult(description, detail) {
  const d = String(detail || '').trim();
  if (!d) return `Done, sir — ${description}.`;
  const lines = d.split('\n').map(s => s.trimEnd());
  const underline = lines.findIndex(l => /^\s*-{3,}/.test(l));
  const isTable = underline > 0 || lines.length > 6;
  const flat = d.replace(/\s+/g, ' ').trim();
  if (!isTable && flat.length <= 220) return `Done, sir. ${flat}`;
  // Lead with the first real line if it is prose (not a table header/underline).
  const lead = lines.map(s => s.trim()).find((s, i) => s && i !== underline && i !== underline - 1) || '';
  const prose = lead && lead.length <= 140 && /[a-z]/.test(lead) && !/\s{2,}/.test(lead);
  return `Done, sir — ${description}. ${prose ? lead + ' — ' : ''}the full result is on your screen.`;
}

/** Run a confirmed PC action through the orchestrator and report it plainly. */
export async function handlePcAction(verb, args, onEvent = () => {}, waitSeconds = 45) {
  try {
    const r = await fetch(`${ORCHESTRATOR}/pc/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verb, args, wait_seconds: waitSeconds, enqueued_by: 'brain' }),
    });
    const data = await r.json();
    if (data.error) {
      const remedy = data.remedy ? ` ${data.remedy}.` : '';
      const m = `I couldn't do that on the PC, sir — ${data.error}.${remedy}`;
      return { text: m, speech: m, data };
    }
    if (data.status === 'pending') {
      const m = `It's queued for the PC, sir, but the machine hasn't picked it up — ${data.note}.`;
      return { text: m, speech: m, data };
    }
    const failed = data.status === 'failed' || (data.exit_code != null && data.exit_code !== 0);
    const detail = String(data.output || data.error || '').trim();
    // A confirmed `shell` is the most powerful thing this system does to the
    // PC; until 2026-08-19 only its FAILURES reached the inbox. Every run is
    // recorded now — command and the head of its output — success or not.
    if (verb === 'shell') {
      notify({
        source: 'pc', level: failed ? 'warn' : 'info',
        title: `${failed ? '❌' : '✅'} Ran on the PC: ${String(args?.command || '').trim().split(/\r?\n/)[0].slice(0, 90)}`,
        body: `Command:\n${String(args?.command || '').trim().slice(0, 2000)}\n\nOutput (${data.status}${data.exit_code != null ? `, exit ${data.exit_code}` : ''}):\n${detail.slice(0, 1500) || '(none)'}`,
      }).catch(() => {});
    }
    if (failed) {
      const m = `That didn't work on the PC, sir. ${detail.slice(0, 600) || 'No detail came back.'}`;
      return { text: m, speech: m, data };
    }
    // Spoken result (2026-08-19, move 40): "Done, sir." swallowed the answer —
    // a confirmed shell's output only ever reached the text channel. Short
    // output is spoken as-is; a table or a long dump is summarised with a
    // pointer to the screen.
    const spoken = spokenPcResult(data.description, detail);
    return {
      text: detail ? `Done on the PC — ${data.description}.\n\n${detail.slice(0, 3000)}` : `Done on the PC — ${data.description}.`,
      speech: spoken,
      data,
    };
  } catch (e) {
    const m = `I couldn't reach the dispatcher to run that on the PC, sir — ${e.message}`;
    return { text: m, speech: m };
  }
}

/**
 * Call FIRST on every command. A dispatch staged in an EARLIER turn runs when
 * Craig affirms, is dropped when he declines, and otherwise KEEPS WAITING —
 * ordinary conversation no longer destroys it, and when it finally lapses the
 * gate says so via gate.lapsed instead of forgetting in silence.
 */
export async function resolveDispatchGate(gate, text, onEvent = () => {}) {
  if (!gate || !gate.pending) return { handled: false };
  const p = gate.pending;
  // The preview and the yes must be two separate human turns — that is the
  // whole safety property. A same-turn affirmation is not an affirmation.
  if (p.turn >= gate.turn) return { handled: false };

  const verdict = classifyGateReply(text);

  if (verdict === 'yes') {
    gate.pending = null;
    // A staged PC action runs on Craig's machine, not through a fleet agent.
    if (p.kind === 'pc') {
      const res = await handlePcAction(p.verb, p.args, onEvent);
      // Truth for the brain (2026-08-19, move 40): a PC action returns a jobId
      // even when it FAILED, so `ok: !!jobId` told the model "NOW RUNNING" about
      // a refusal. ok = it completed or is genuinely still running on the PC.
      const st = res.data?.status;
      const failed = st === 'failed' || (res.data?.exit_code != null && res.data.exit_code !== 0) || !!res.data?.error;
      gate.launched = {
        platform: 'craig-pc', task: p.description, jobId: res.data?.jobId || null,
        ok: !!res.data?.jobId && !failed,
        outcome: failed ? 'failed' : st === 'completed' ? 'completed' : st === 'pending' ? 'pending' : 'unknown',
      };
      return { handled: true, ...res };
    }
    const res = await handleDispatch(p.task, p.platform, onEvent);
    // Let the brain know out loud what its own tool could not do — see
    // gateNote(). Without this the model has no evidence the job ever ran.
    gate.launched = { platform: p.platform, task: p.task, jobId: res.data?.jobId || null, ok: !!res.data?.jobId };
    return { handled: true, ...res };
  }

  if (verdict === 'no') {
    gate.pending = null;
    const m = `Understood, sir — I'll leave ${p.platform} be.`;
    gate.lapsed = { platform: p.platform, task: p.task, reason: 'declined' };
    return { handled: true, text: m, speech: m };
  }

  if (verdict === 'defer') {
    p.expiresTurn = gate.turn + GATE_TTL_TURNS;
    const m = `Standing by, sir — the ${p.platform} job is still staged. Say the word.`;
    return { handled: true, text: m, speech: m };
  }

  // A fresh command is not a rejection. Hold the job for a few turns; if he
  // never comes back to it, drop it and leave a note the digest will surface.
  if (gate.turn > (p.expiresTurn ?? p.turn + GATE_TTL_TURNS)) {
    gate.pending = null;
    gate.lapsed = { platform: p.platform, task: p.task, reason: 'expired' };
  }
  return { handled: false };
}

/**
 * One-shot background note for the brain's status digest: what the gate did that
 * the model could not see, and what is still waiting on Craig. Reading it clears
 * it, so a launch is announced once and never re-litigated.
 *
 * This is the other half of the 2026-07-30 fix. The gate intercepts the
 * confirming turn and returns early, so the brain's own session never witnesses
 * the "yes" or the job starting — which is precisely why it invented a story
 * about having passed one through.
 */
export function gateNote(gate) {
  if (!gate) return '';
  const parts = [];
  if (gate.launched) {
    const l = gate.launched;
    parts.push(l.ok
      ? (l.outcome === 'completed'
        ? `the PC action you staged (${l.task}) has COMPLETED — Craig confirmed it and the result was spoken; do not stage it again`
        : `the ${l.platform} job you staged is NOW RUNNING — Craig confirmed it and the gate launched it${l.jobId ? ` (job ${String(l.jobId).slice(0, 8)})` : ''}; do not stage it again`)
      : (l.outcome === 'failed'
        ? `Craig confirmed the ${l.platform} action (${l.task}) and it RAN BUT FAILED — say so plainly, never call it running`
        : `Craig confirmed the ${l.platform} job but the orchestrator refused it — say so plainly if he asks`));
    gate.launched = null;
  }
  if (gate.lapsed) {
    const x = gate.lapsed;
    parts.push(x.reason === 'declined'
      ? `Craig declined the staged ${x.platform} job — it is gone, do not revive it unless he asks`
      : `the staged ${x.platform} job lapsed without a yes — mention it if it still matters, or stage it again if he asks`);
    gate.lapsed = null;
  }
  if (gate.pending && gate.pending.turn < gate.turn) {
    parts.push(`a dispatch to ${gate.pending.platform} is STILL STAGED and waiting on Craig's yes — you cannot launch it yourself, do not call dispatch_job again, just remind him a plain "yes" starts it`);
  }
  return parts.join('; ');
}

export async function handleJobs() {
  try {
    const jobs = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json());

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return { text: '📋 No jobs in queue.', speech: 'No jobs in the queue.', data: [] };
    }

    const running  = jobs.filter(j => j.status === 'running');
    const recent   = jobs.slice(0, 10);

    let msg = `📋 *Jobs — ${running.length} running, ${jobs.length} total*\n`;
    for (const j of recent) {
      const emoji = j.status === 'running' ? '⏳' : j.status === 'completed' ? '✅' : '❌';
      const started = new Date(j.startedAt);
      const elapsed = j.finishedAt
        ? `${Math.round((new Date(j.finishedAt) - started) / 1000)}s`
        : `${Math.round((Date.now() - started) / 1000)}s elapsed`;
      msg += `${emoji} \`${j.id.slice(0, 8)}\` *${j.platform}* — ${j.status} (${elapsed})\n`;
      if (j.status !== 'completed') {
        msg += `  ↳ _${(j.task || '').slice(0, 90)}_\n`;
      }
    }
    if (jobs.length > 10) msg += `_...and ${jobs.length - 10} more_`;

    return {
      text: msg,
      speech: `${running.length} job${running.length === 1 ? '' : 's'} running, ${jobs.length} total.`,
      data: jobs,
    };
  } catch (e) {
    return { text: `❌ Jobs fetch failed: ${e.message}`, speech: 'Sorry, I could not fetch the jobs.' };
  }
}

export async function handleStatus() {
  try {
    const [metrics, memory] = await Promise.allSettled([
      fetch(`${METRICS}/metrics/current`).then(r => r.json()),
      fetchJSON(`${MEMORY}/memory/summary`),
    ]);

    const m  = metrics.status  === 'fulfilled' ? metrics.value  : {};
    const mem = memory.status  === 'fulfilled' ? memory.value   : { platforms: [] };

    let msg = `📊 *JARVIS STATUS*\n`;
    if (m.cpu != null) {
      msg += `Server: CPU ${m.cpu}% | RAM ${m.mem}% | Disk ${m.disk}%\n`;
    }
    if (m.jarvis) {
      msg += `\n*Services:*\n`;
      for (const [k, v] of Object.entries(m.jarvis)) {
        msg += `${v === 'ONLINE' ? '✅' : '🔴'} ${k}: ${v}\n`;
      }
    }

    const platforms = mem.platforms || [];
    // Only show platforms in the registry — memory can hold stale/removed entries
    const knownPlatforms = platformNames();
    const filtered = platforms.filter(p => knownPlatforms.includes(p.name));
    let healthyCount = 0;
    let attentionCount = 0;
    if (filtered.length) {
      msg += `\n*Platform health:*\n`;
      for (const p of filtered) {
        // Use status string as primary signal; fall back to health_score only when set
        const healthy = p.status === 'healthy' || p.health_score > 80;
        const warn    = p.status === 'working'  || (p.health_score > 50 && p.health_score <= 80);
        const e = healthy ? '✅' : warn ? '⚠️' : '🔴';
        if (healthy) healthyCount++; else attentionCount++;
        const score = p.health_score > 0 ? ` (${p.health_score}/100)` : '';
        msg += `${e} ${p.name}: ${p.status}${score}\n`;
      }
    }
    if (mem.open_issues > 0) {
      msg += `\n⚠️ *${mem.open_issues} open issues in memory*`;
    }

    const cpuBit = m.cpu != null ? `CPU ${m.cpu} percent, RAM ${m.mem} percent. ` : '';
    return {
      text: msg,
      speech: `${cpuBit}${healthyCount} platforms healthy${attentionCount ? `, ${attentionCount} need attention` : ''}.`,
      data: { metrics: m, memory: mem },
    };
  } catch (e) {
    return { text: `❌ Status fetch failed: ${e.message}`, speech: 'Sorry, the status fetch failed.' };
  }
}

export async function handlePlatformStatus(platform) {
  let msg = `📊 *${platform}* status\n`;
  let speech = `I have no data for ${platform} yet.`;
  let data = null;

  // 1. Memory lookup
  try {
    const mem = await fetchJSON(`${MEMORY}/memory/platform/${platform}`);
    if (mem && mem.name) {
      const e = mem.health_score > 80 ? '✅' : mem.health_score > 50 ? '⚠️' : '🔴';
      msg += `${e} Status: ${mem.status} (${mem.health_score}/100)\n`;
      if (mem.last_issue)  msg += `Last issue: _${mem.last_issue}_\n`;
      if (mem.last_audit)  msg += `Last audit: ${mem.last_audit}\n`;
      if (mem.notes)       msg += `Notes: ${String(mem.notes).slice(0, 200)}\n`;
      speech = `${platform} is ${mem.status}, score ${mem.health_score} out of 100.`;
      data = mem;
    } else {
      msg += `_No memory data yet — run an audit to populate_\n`;
    }
  } catch (e) {
    msg += `_Memory lookup failed: ${e.message}_\n`;
    speech = `The memory lookup for ${platform} failed.`;
  }

  // 2. Screenshot — only for platforms with a known public URL
  const url = PLATFORM_URLS[platform];
  if (url) {
    try {
      const shot = await fetch(`${SCREENSHOT}/screenshot/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }).then(r => r.json());

      if (shot.path || shot.url) {
        msg += `📸 Screenshot: ${shot.url ?? shot.path ?? 'captured'}`;
      } else if (shot.error) {
        msg += `📸 Screenshot failed: ${shot.error}`;
      }
    } catch (e) {
      msg += `📸 Screenshot service unavailable: ${e.message}`;
    }
  }

  return { text: msg, speech, data };
}

export async function handleBriefing() {
  const names = platformNames();
  let msg = `🌅 *JARVIS MORNING BRIEFING*\n`;
  msg += `${new Date().toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;
  let speech = 'Here is your briefing.';
  let data = null;

  try {
    const memory = await fetchJSON(`${MEMORY}/memory/summary`);
    // Filter to only registry platforms — drop stale memory entries
    const allPlatforms = memory.platforms || [];
    const platforms = allPlatforms.filter(p => names.includes(p.name));

    // Healthy = status is 'healthy', OR health_score > 80 if set
    const healthy   = platforms.filter(p => p.status === 'healthy' || p.health_score > 80);
    const warning   = platforms.filter(p => !healthy.includes(p) && (p.status === 'working' || p.status === 'error' || (p.health_score > 0 && p.health_score <= 80)));
    const audited   = new Set(platforms.map(p => p.name));
    const unaudited = names.filter(n => !audited.has(n));

    if (healthy.length) {
      msg += `*Healthy:*\n`;
      for (const p of healthy) {
        const score = p.health_score > 0 ? ` (${p.health_score}/100)` : '';
        msg += `✅ ${p.name}${score}\n`;
      }
      msg += '\n';
    }
    if (warning.length) {
      msg += `*Needs attention:*\n`;
      for (const p of warning) {
        const score = p.health_score > 0 ? ` (${p.health_score}/100)` : '';
        msg += `⚠️ ${p.name}${score}`;
        if (p.last_issue) msg += ` — _${String(p.last_issue).slice(0, 80)}_`;
        msg += '\n';
      }
      msg += '\n';
    }
    if (unaudited.length) {
      msg += `*Not yet audited:*\n`;
      for (const n of unaudited) msg += `❓ ${n}\n`;
      msg += '\n';
    }

    if (memory.open_issues > 0) {
      msg += `⚠️ *${memory.open_issues} unresolved issues in memory*\n`;
    }

    const jobs = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json()).catch(() => []);
    const running = (Array.isArray(jobs) ? jobs : []).filter(j => j.status === 'running');
    if (running.length) {
      msg += `\n⏳ *${running.length} job(s) currently running:*\n`;
      for (const j of running.slice(0, 3)) {
        msg += `• ${j.platform}: _${(j.task || '').slice(0, 60)}_\n`;
      }
    }

    speech = `Good morning. ${healthy.length} platforms healthy` +
      `${warning.length ? `, ${warning.length} need attention` : ''}` +
      `${unaudited.length ? `, ${unaudited.length} not yet audited` : ''}` +
      `${running.length ? `. ${running.length} job${running.length === 1 ? '' : 's'} running` : ''}.`;

    // Structured form for rich clients (Command Deck briefing panel).
    // Additive: existing callers keep using text/speech untouched.
    data = {
      date: new Date().toISOString(),
      healthy: healthy.map(p => ({ name: p.name, score: p.health_score || null })),
      attention: warning.map(p => ({ name: p.name, score: p.health_score || null, issue: p.last_issue ? String(p.last_issue).slice(0, 120) : null })),
      unaudited,
      openIssues: memory.open_issues || 0,
      jobs: running.slice(0, 5).map(j => ({ platform: j.platform, task: (j.task || '').slice(0, 80) })),
    };
  } catch (e) {
    msg += `❌ Memory unavailable: ${e.message}`;
    speech = 'Sorry, memory is unavailable for the briefing.';
  }

  return { text: msg, speech, data };
}

export async function handleRoadmap() {
  let roadmap;
  try {
    roadmap = loadRoadmap();
  } catch (e) {
    return { text: `❌ Roadmap unavailable: ${e.message}`, speech: 'Sorry, the roadmap is unavailable.' };
  }

  const { doneCount, totalCount, percent, current, phases } = roadmap;
  let msg = `🗺️ *JARVIS ROADMAP* — ${doneCount}/${totalCount} moves shipped (${percent}%)\n`;
  if (current) msg += `🔨 Currently: _${current.title}_ (${current.phase})\n`;

  for (const phase of phases) {
    const icon = (s) => s === 'done' ? '✅' : s === 'in_progress' ? '🔨' : s === 'superseded' ? '➖' : '⬜';
    msg += `\n*${phase.name}* — ${phase.subtitle || ''}\n`;
    for (const m of phase.moves) {
      msg += `${icon(m.status)} ${m.title}\n`;
    }
  }

  const nextUp = phases.flatMap(p => p.moves).find(m => m.status === 'pending');
  const speech = `${doneCount} of ${totalCount} moves done, ${percent} percent.` +
    (current ? ` Currently building ${current.title}.` : '') +
    (nextUp ? ` Next up: ${nextUp.title}.` : '');

  return { text: msg, speech, data: roadmap };
}

export function handleHelp() {
  const platforms = platformNames().join(', ');
  const msg =
    `*Jarvis commands:*\n` +
    `• \`fix zoobicon dashboard\` — dispatch a task to a platform\n` +
    `• \`upgrade vapron login flow\` — same, different verb\n` +
    `• \`jobs\` or \`what's running\` — show job queue\n` +
    `• \`status\` — server metrics + all platform health\n` +
    `• \`how is zoobicon\` — platform memory state + screenshot\n` +
    `• \`check vapron\` — same\n` +
    `• \`briefing\` or \`morning\` — full morning summary\n` +
    `• \`what's left\` or \`roadmap\` — Jarvis project completion checklist\n` +
    `• _anything else_ — in basic mode, nothing is dispatched without an action verb\n\n` +
    `Platforms: ${platforms}`;
  return {
    text: msg,
    speech: 'You can ask for status, jobs, a briefing, how a platform is doing, or tell me to fix something.',
  };
}

/**
 * Run a resolved intent through its handler. Multi-message flows emit interim
 * messages via onEvent({text, speech}); the final reply is returned.
 */
export async function runIntent(intent, rawText, onEvent = () => {}, gate = null) {
  const dispatchTask = (rawText || '').replace(/<[^>]+>/g, '').trim();
  switch (intent.type) {
    case 'ask':             return handleAsk(intent.question);
    // Dispatch/passthrough PREVIEW only — the gate runs it on the next
    // affirmative turn. Without a gate, a dispatch can never fire (fail-safe).
    case 'dispatch':        return previewDispatch(gate,
                              intent.platform === 'auto' ? (matchPlatform(dispatchTask) || 'auto') : intent.platform,
                              dispatchTask);
    case 'jobs':            return handleJobs();
    case 'status':          return handleStatus();
    case 'platform-status': return handlePlatformStatus(intent.platform);
    case 'briefing':        return handleBriefing();
    case 'roadmap':         return handleRoadmap();
    case 'help':            return handleHelp();
    // Nothing recognisable (2026-08-19). This pipeline only runs when the
    // reasoning brain is unavailable, and "nothing matched" used to stage a
    // DISPATCH of the raw utterance — the KV transcript shows "Ready to dispatch
    // to auto: love you what. Shall I proceed, sir?" and "Ready to dispatch to
    // auto: I just got a message from you saying okay baby have a safe flight"
    // during the 2026-08-16..19 outage: a degraded assistant turning household
    // speech into a production-agent preview one "yes" away from launch. A
    // dispatch needs an action VERB (the 'dispatch' case above); free speech in
    // basic mode gets an honest "I'm in basic mode" instead, and stages nothing.
    case 'passthrough':
    default:                return handleBasicMode(dispatchTask);
  }
}

export function handleBasicMode(text = '') {
  const heard = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const msg = `My reasoning brain is offline, sir — I'm in basic mode${heard ? ` and I didn't catch a command in "${heard}"` : ''}. ` +
    `I can give you status, the jobs, a briefing, the roadmap, or check a platform by name; ` +
    `to dispatch work, name the platform and say fix, build, update or deploy.`;
  return { text: msg, speech: msg, basicMode: true };
}

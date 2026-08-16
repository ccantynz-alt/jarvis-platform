/**
 * brain-claude.js — the subscription-billed Claude brain (Agent SDK).
 *
 * WHY: the metered Anthropic key ran dry on 2026-07-17 and the brain silently
 * degraded (OpenAI, then Gemini). Craig's ruling: the brain runs on his
 * claude.ai subscriptions — flat-rate, never "out of credits" — with
 * claude-auth.js flipping between his two logins on usage limits.
 *
 * HOW: one long-lived Agent SDK `query()` in streaming-input mode. The CLI
 * child stays warm across turns, so per-turn latency is API latency only —
 * voice-grade. The 8 Jarvis tools are served in-process via an SDK MCP server
 * wrapping the SAME runTool() every other provider uses (brain-tools.js); the
 * SDK runs the tool loop itself. Built-in file/bash tools are disallowed —
 * the brain is a talker/router, not a coder; real work goes through
 * dispatch_job's confirmation gate exactly as before.
 *
 * Session state lives in the CLI child; the caller's KV transcript stays the
 * durable source of truth. After a restart (crash, profile flip, watchdog) the
 * next turn carries a one-shot recap synthesized from that transcript.
 */

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { TOOLS, runTool, systemPrompt, statusDigest } from './brain-tools.js';
import { CONVERSATION_TAG } from './harvest.js';
import { ownTurn } from './transcript.js';
import {
  hasClaudeAuth, getActiveProfile, profileEnv,
  classifyFailure, reportExhausted, reportAuthFailure, reportModelRejected,
} from './claude-auth.js';

// Model tiers (Craig's ruling 2026-07-26, superseding 2026-07-19's
// Sonnet-everyday setup): **Opus 5 and Fable only.** Jarvis runs the smartest
// tiers available — he's making business calls, not answering trivia. Opus 5
// is the everyday brain; Fable 5 is the escalation for ONE retry when a turn
// fails for a non-limit reason, and is voice-selectable ("switch model to
// Fable"). Sonnet is deliberately no longer a tier: a stale KV value naming
// it is ignored by the TIERS.includes() guard below and falls back to Opus 5.
// This also retires 'claude-opus-4-8', which was a previous-generation Opus.
//
// Tradeoff Craig has accepted: heavier tiers consume the claude.ai
// subscription's usage windows faster, and since 2026-07-26 there is no
// metered fallback — so both accounts limiting out means degrading to the
// keyword pipeline rather than quietly billing an API. claude-auth.js's
// two-account failover plus the total-outage alert are what make that safe.
const TIERS = ['claude-opus-5', 'claude-fable-5'];
const TIER_LABEL = { 'claude-opus-5': 'Opus 5', 'claude-fable-5': 'Fable 5' };
const MODEL_KEY = 'brain-claude-model';
let modelChoice = null; // voice-selected tier, persisted in memory KV
(async () => { // restore across restarts (best effort)
  try {
    const r = await fetch(`http://127.0.0.1:9200/memory/kv/${MODEL_KEY}`).then(r => r.json());
    if (TIERS.includes(r?.value)) modelChoice = r.value;
  } catch { /* KV empty or memory down */ }
})();
const MODEL = () => modelChoice || process.env.BRAIN_CLAUDE_MODEL || 'claude-opus-5';
const nextTierUp = (m) => TIERS[Math.min(TIERS.indexOf(m) + 1, TIERS.length - 1)];

/** Voice/model selection: accepts opus/fable, returns spoken label. */
export async function setBrainModel(word) {
  // "switch model to sonnet" now resolves to Opus 5 rather than returning
  // null — null would make maybeBrainSwitch fall through and answer with a
  // confusing non-sequitur. Opus 5 IS the everyday tier now, so honouring the
  // intent ("give me the lighter/default brain") is the truthful answer.
  const model = /fable/i.test(word) ? 'claude-fable-5'
    : /opus|sonnet/i.test(word) ? 'claude-opus-5' : null;
  if (!model) return null;
  modelChoice = model;
  fetch('http://127.0.0.1:9200/memory/kv', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: MODEL_KEY, value: model }),
  }).catch(() => {});
  disposeSession('model switch');
  return TIER_LABEL[model];
}

// Voice-grade tightening 2026-07-24 (was 30s/180s — Craig: "I have to wait
// 10 minutes"): 30s of dead air before the FIRST token reads as broken, and
// 180s × 2 attempts made the claude provider alone a 6-minute worst case.
// 12s first-token is still generous for a warm session; 90s covers real
// tool-chaining turns. Env overrides remain for tuning without a deploy.
// 2026-07-28: raised 12s → 20s. The 12s figure was tuned on 2026-07-24 when
// the everyday tier was claude-sonnet-5; 7e1c7b9 made it Opus 5 two days later
// and nobody moved the watchdog, so healthy-but-heavier turns were being shot
// at 12s. Confirmed on the box 2026-07-28 20:33: first-token watchdog on Opus
// 5 → escalate to Fable 5 → de-escalate. Every one of those costs a killed
// turn plus a retry on a heavier tier, and two misses drop the whole brain to
// the keyword pipeline (which has no conversational memory — this is one of
// the ways Jarvis "forgets"). Still well inside the 120s total turn budget.
const FIRST_TOKEN_MS = Number(process.env.BRAIN_FIRST_TOKEN_TIMEOUT_MS) || 20_000;
const TURN_TIMEOUT_MS = Number(process.env.BRAIN_TURN_TIMEOUT_MS) || 90_000;
const MAX_TURNS = 12; // SDK-internal tool round-trips per user turn

export function hasClaudeBrain() {
  return process.env.BRAIN_CLAUDE_DISABLED !== '1' && hasClaudeAuth();
}

// ── Tool bridge: our schemas → SDK MCP tools running the shared runTool() ────
// ctx (dispatch gate etc.) is per-turn; the deck serves one Craig, and turns
// are serialized below, so a module-level slot is safe.
let currentCtx = null;

function zodShape(schema) {
  const shape = {};
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    let t = prop.type === 'boolean' ? z.boolean() : prop.type === 'number' ? z.number() : z.string();
    if (prop.description) t = t.describe(prop.description);
    if (!(schema.required || []).includes(key)) t = t.optional();
    shape[key] = t;
  }
  return shape;
}

function buildMcpServer() {
  return createSdkMcpServer({
    name: 'jarvis',
    version: '1.0.0',
    tools: TOOLS.map(t => tool(t.name, t.description, zodShape(t.input_schema), async (input) => {
      let out;
      try { out = await runTool(t.name, input || {}, currentCtx || {}); }
      catch (e) { out = `Tool ${t.name} failed: ${e.message}`; }
      return { content: [{ type: 'text', text: String(out).slice(0, 4000) }] };
    })),
  });
}

// ── Persistent session ───────────────────────────────────────────────────────

let session = null;      // { q, push, profile, dead, turnActive }
let chain = Promise.resolve(); // serializes turns

function startSession(model = MODEL()) {
  const profile = getActiveProfile();
  if (!profile) throw new Error('no claude subscription login on this box');

  // Belt-and-braces: make sure the metered key can never leak into the child.
  const env = profileEnv({ ...process.env, IS_SANDBOX: '1', DISABLE_AUTOUPDATER: '1' });

  const inbox = [];
  let wake = null;
  const push = (msg) => { inbox.push(msg); if (wake) { wake(); wake = null; } };
  async function* input() {
    for (;;) {
      while (!inbox.length) await new Promise(r => { wake = r; });
      yield inbox.shift();
    }
  }

  const q = query({
    prompt: input(),
    options: {
      model,
      systemPrompt: systemPrompt(),
      maxTurns: MAX_TURNS,
      includePartialMessages: true,
      mcpServers: { jarvis: buildMcpServer() },
      allowedTools: TOOLS.map(t => `mcp__jarvis__${t.name}`),
      disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookEdit'],
      permissionMode: 'bypassPermissions',
      env,
      cwd: '/opt/jarvis',
    },
  });

  const s = { q, push, profile: profile.name, model, dead: false, turn: null };

  // One reader loop owns the message stream and routes events to the live turn.
  (async () => {
    try {
      for await (const m of q) {
        const turn = s.turn;
        if (m.type === 'stream_event') {
          const ev = m.event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            turn?.onText(ev.delta.text);
          }
        } else if (m.type === 'assistant') {
          const txt = (m.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
          if (txt) turn && (turn.lastText = txt);
        } else if (m.type === 'result') {
          turn?.done(m);
        }
      }
    } catch (e) {
      s.err = e;
    }
    s.dead = true;
    s.turn?.fail(s.err || new Error('claude brain session ended'));
    if (session === s) session = null;
  })();

  console.log(`[brain-claude] session started — model ${model}, profile ${profile.name}`);
  return s;
}

/**
 * @param {string} reason
 * @param {{rewarm?: boolean}} [opts] rewarm=false when the CALLER is about to
 *   start a session itself. The background re-warm below runs SYNCHRONOUSLY up
 *   to its first await, so by the time dispose returns there is already a live
 *   session again — and the retry loop's `const fresh = !session || session.dead`
 *   therefore saw `fresh === false` and skipped `startSession(escalateTo)`.
 *   That silently disabled three separate documented behaviours: the escalated
 *   tier was never used, the model-rejection fallback to the everyday tier was
 *   never used, and a timeout retry never got the cold-spawn allowance it exists
 *   for (the comment in that branch even says it relies on this). Found by the
 *   code-health spine, 2026-07-30.
 */
function disposeSession(reason, { rewarm = true } = {}) {
  const s = session;
  session = null;
  if (s && !s.dead) {
    console.warn(`[brain-claude] session disposed (${reason})`);
    try { s.q.interrupt?.().catch?.(() => {}); } catch {}
    try { s.q.return?.(); } catch {}
  }
  // Re-warm immediately (2026-07-21, latency audit) — without this, the very
  // next real turn after ANY dispose (failure, watchdog, model/account
  // switch) paid a full CLI cold-start on top of whatever just went wrong,
  // right when the user was already waiting on a retry. Fire-and-forget;
  // warmupClaudeBrain() already no-ops if a session exists or auth is
  // missing, and swallows its own errors.
  if (rewarm) warmupClaudeBrain().catch(() => {});
}

/** Kill the live session (next turn starts fresh under the active profile). */
export function restartClaudeBrain(reason = 'manual restart') {
  disposeSession(reason);
}

export async function warmupClaudeBrain() {
  try { if (!session && hasClaudeBrain()) session = startSession(); }
  catch (e) { console.error(`[brain-claude] warmup failed: ${e.message}`); }
}

// Recap so a fresh session keeps continuity with the KV transcript.
function recapFrom(transcript) {
  const lines = [];
  for (const m of transcript.slice(-12, -1)) { // exclude the just-pushed user msg
    const text = typeof m.content === 'string'
      ? m.content
      : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
    if (text) lines.push(`${m.role === 'assistant' ? 'JARVIS' : 'CRAIG'}: ${text.slice(0, 300)}`);
  }
  return lines.length
    ? `[Context recap — your earlier conversation with Craig this session, for continuity. Do not mention this recap.]\n${lines.join('\n')}\n\n`
    : '';
}

function runTurn(s, text, onChunk, fresh = false) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let streamed = '';
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(firstT); clearTimeout(totalT); s.turn = null; fn(v); } };

    // 2026-07-24: a COLD session (CLI child just spawned) legitimately takes
    // longer than 12s to first token — the 07:26 UTC incident today showed
    // the 12s watchdog killing fresh sessions in a loop, cascading into
    // failover onto the metered APIs ("why has it switched to api?"). Warm
    // sessions keep the tight voice-grade limit; fresh ones get spawn slack.
    const firstMs = fresh ? (Number(process.env.BRAIN_FIRST_TOKEN_COLD_MS) || 35_000) : FIRST_TOKEN_MS;
    const firstT = setTimeout(() => {
      if (!streamed) { disposeSession('first-token watchdog'); finish(reject, new Error('claude brain: no first token in time')); }
    }, firstMs);
    const totalT = setTimeout(() => {
      disposeSession('turn watchdog'); finish(reject, new Error('claude brain: turn timed out'));
    }, TURN_TIMEOUT_MS);

    s.turn = {
      lastText: '',
      onText: (t) => { streamed += t; try { onChunk(t); } catch {} },
      done: (m) => {
        if (m.is_error) {
          const err = new Error(String(m.result || m.subtype || 'claude brain error'));
          err.resultMessage = m;
          return finish(reject, err);
        }
        finish(resolve, String(m.result ?? s.turn?.lastText ?? streamed ?? '').trim());
      },
      fail: (e) => finish(reject, e),
    };

    s.push({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    });
  });
}

/**
 * One conversational turn on the subscription brain.
 * Same contract as agent.js's provider loops: transcript already holds the
 * user's message (last entry); returns { text, speech, dispatched } and
 * appends the assistant reply. Throws on failure so agent.js can fail over.
 */
export async function runClaudeBrain(transcript, onChunk = () => {}, gate = null, deadline = Infinity, passedText = null, turnId = null) {
  const run = async () => {
    // The caller's OWN text, passed in explicitly (2026-07-30, found by the
    // code-health spine on the concurrency lens).
    //
    // This used to read transcript[transcript.length - 1] — but that read happens
    // inside run(), which is queued on `chain`, while runAgent() pushes the user
    // message immediately. Two overlapping commands therefore did this:
    //   A arrives, pushes "A", queues turn A
    //   B arrives, pushes "B", queues turn B
    //   turn A runs -> reads last == "B" and answers B
    //   turn A pushes its assistant reply
    //   turn B runs -> reads last == that ASSISTANT reply, and answers Jarvis
    // The second half is literally "Jarvis replies to his own previous message",
    // which is the symptom Craig spent a morning chasing on the voice path — a
    // completely separate cause from the microphone echo, reachable by any two
    // commands close together (the deck kills the previous VOICE session on a new
    // command but does not await the previous brain turn).
    const userText = typeof passedText === 'string' && passedText
      ? passedText
      : (typeof transcript[transcript.length - 1]?.content === 'string'
        ? transcript[transcript.length - 1].content : '');
    // The persistent session's systemPrompt is fixed at session start (can
    // live for hours), so live status can't ride on it without going stale —
    // it's freshened here instead, per turn, the same way recap works below.
    // Bounded to 150ms (2026-07-21, latency audit): statusDigest() already
    // races its own fetches internally, but that raced worst case (up to
    // ~2.5s) was still fully serial in front of EVERY turn's first token,
    // including plain chit-chat that never touches the fleet. A slow/down
    // dependency degrades to "no digest this turn," never to added lag.
    const digest = await Promise.race([
      statusDigest(gate).catch(() => ''),
      new Promise((resolve) => setTimeout(() => resolve(''), 150)),
    ]);

    let escalateTo = null; // set when a turn fails non-fatally → retry on a higher tier
    for (let attempt = 0; attempt < 2; attempt++) {
      const want = escalateTo || undefined;
      // A session warmed in the background can be on the WRONG tier for this
      // attempt. Dispose it properly rather than overwriting the variable —
      // reassigning would leak a live CLI child with nobody holding its handle.
      if (session && !session.dead && want && session.model !== want) {
        disposeSession(`tier change → ${want}`, { rewarm: false });
      }
      const fresh = !session || session.dead;
      if (fresh) session = startSession(want);
      const s = session;
      const ctx = { pending: null, dispatched: null, gate };
      currentCtx = ctx;

      try {
        // CONVERSATION_TAG goes FIRST and unconditionally — ahead of the recap
        // and the digest — because it is what keeps Craig's private speech out
        // of the harvester flywheel (lib/harvest.js isConversationSession).
        // The old exclusion rode on the digest prefix, which is best-effort:
        // it loses a 150ms race, or statusDigest returns '' when its loopback
        // fetches fail, and then the turn is unmarked. Position matters as much
        // as presence — the classifier uses startsWith, and on a FRESH session
        // the recap would otherwise sit in front of the marker.
        const text = await runTurn(s, CONVERSATION_TAG + ' ' + (fresh ? recapFrom(transcript) : '') + (digest ? digest + ' ' : '') + userText, onChunk, fresh);
        transcript.push(ownTurn({ role: 'assistant', content: text }, turnId));
        if (transcript.length > 24) transcript.splice(0, transcript.length - 24);
        // An escalated session served its one hard turn — drop back to the
        // everyday tier afterwards so usage limits aren't burned on chit-chat.
        if (escalateTo) disposeSession('de-escalate after escalated turn');
        const speech = text.replace(/\s+/g, ' ').trim().slice(0, 400);
        return { text: text || '(no reply)', speech, dispatched: ctx.dispatched };
      } catch (e) {
        const cls = classifyFailure({ message: e.message, stderr: String(e.resultMessage?.result || '') });
        console.error(`[brain-claude] turn failed (${cls.kind}) on ${s.profile}/${s.model}: ${e.message.slice(0, 200)}`);
        // rewarm:false — every branch below either retries in this loop (and
        // starts its own session, on the tier it actually wants) or throws, and
        // the throw path re-warms explicitly. A background re-warm here is what
        // used to make the retry look "not fresh".
        disposeSession(`turn failure: ${cls.kind}`, { rewarm: false });
        // 2026-07-24: retries are only worth it while there's budget left —
        // a second 90s attempt after a slow first failure is exactly how the
        // "10 minute wait" compounded. Past the caller's deadline, fail fast
        // so agent.js's fallback chain (or the keyword pipeline) answers.
        const budgetLeft = Date.now() < deadline;
        if (cls.kind === 'usage_limit' && attempt === 0 && budgetLeft) {
          const next = await reportExhausted(s.profile, cls.resetAt);
          if (next) continue;             // retry once on the other login
        } else if (cls.kind === 'auth') {
          await reportAuthFailure(s.profile, e.message);
        } else if (cls.kind === 'model') {
          // This box's `claude` binary doesn't know the tier we asked for.
          // Escalating UP would hand the same stale binary a model it knows
          // even less, so drop DOWN to the everyday tier for one retry and
          // say out loud what's actually wrong (never a silent downgrade).
          const rejected = cls.model || s.model;
          await reportModelRejected(rejected, e.message);
          if (modelChoice && rejected === modelChoice) {
            await setBrainModel('opus'); // stop re-asking for a tier this box can't serve
          }
          if (s.model !== TIERS[0] && attempt === 0 && budgetLeft) {
            escalateTo = TIERS[0];
            console.warn(`[brain-claude] ${rejected} rejected — retrying on ${escalateTo}`);
            continue;
          }
        } else if (cls.kind === 'timeout' && attempt === 0 && budgetLeft) {
          // Retry on the SAME tier, never a heavier one. disposeSession above
          // means the retry is a fresh session, which gets the cold-spawn
          // allowance (35s) — that is the slack a slow turn actually needs.
          // Escalating here would answer "too slow" with "something slower",
          // and spend the subscription window doing it.
          console.warn(`[brain-claude] ${s.model} missed the first-token watchdog — retrying same tier with cold slack`);
          continue;
        } else if (cls.kind === 'other' && attempt === 0 && budgetLeft && nextTierUp(s.model) !== s.model) {
          escalateTo = nextTierUp(s.model); // this tier struggled → one retry on the bigger brain
          console.warn(`[brain-claude] escalating retry to ${escalateTo}`);
          continue;
        }
        // Giving up on this turn: warm a session now so the NEXT one doesn't pay
        // a cold start on top of whatever just went wrong (the 2026-07-21 point
        // of re-warming at all).
        warmupClaudeBrain().catch(() => {});
        throw e;                          // agent.js fails over (and announces)
      } finally {
        currentCtx = null;
      }
    }
    throw new Error('claude brain: retries exhausted');
  };

  // Serialize turns — one brain, one mouth.
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}

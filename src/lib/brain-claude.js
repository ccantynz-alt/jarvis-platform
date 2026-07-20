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
import {
  hasClaudeAuth, getActiveProfile, profileEnv,
  classifyFailure, reportExhausted, reportAuthFailure,
} from './claude-auth.js';

// Model tiers (Craig's ruling 2026-07-19): Sonnet 5 is the everyday brain —
// fast and light on subscription usage limits. Opus/Fable are the heavy tiers:
// voice-selectable ("switch model to Fable") and used automatically for ONE
// retry when the current tier's turn fails for a non-limit reason.
const TIERS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'];
const TIER_LABEL = { 'claude-sonnet-5': 'Sonnet 5', 'claude-opus-4-8': 'Opus', 'claude-fable-5': 'Fable 5' };
const MODEL_KEY = 'brain-claude-model';
let modelChoice = null; // voice-selected tier, persisted in memory KV
(async () => { // restore across restarts (best effort)
  try {
    const r = await fetch(`http://127.0.0.1:9200/memory/kv/${MODEL_KEY}`).then(r => r.json());
    if (TIERS.includes(r?.value)) modelChoice = r.value;
  } catch { /* KV empty or memory down */ }
})();
const MODEL = () => modelChoice || process.env.BRAIN_CLAUDE_MODEL || 'claude-sonnet-5';
const nextTierUp = (m) => TIERS[Math.min(TIERS.indexOf(m) + 1, TIERS.length - 1)];

/** Voice/model selection: accepts sonnet/opus/fable, returns spoken label. */
export async function setBrainModel(word) {
  const model = /fable/i.test(word) ? 'claude-fable-5' : /opus/i.test(word) ? 'claude-opus-4-8'
    : /sonnet/i.test(word) ? 'claude-sonnet-5' : null;
  if (!model) return null;
  modelChoice = model;
  fetch('http://127.0.0.1:9200/memory/kv', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: MODEL_KEY, value: model }),
  }).catch(() => {});
  disposeSession('model switch');
  return TIER_LABEL[model];
}

const FIRST_TOKEN_MS = Number(process.env.BRAIN_FIRST_TOKEN_TIMEOUT_MS) || 30_000;
const TURN_TIMEOUT_MS = Number(process.env.BRAIN_TURN_TIMEOUT_MS) || 180_000;
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

function disposeSession(reason) {
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
  warmupClaudeBrain().catch(() => {});
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

function runTurn(s, text, onChunk) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let streamed = '';
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(firstT); clearTimeout(totalT); s.turn = null; fn(v); } };

    const firstT = setTimeout(() => {
      if (!streamed) { disposeSession('first-token watchdog'); finish(reject, new Error('claude brain: no first token in time')); }
    }, FIRST_TOKEN_MS);
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
export async function runClaudeBrain(transcript, onChunk = () => {}, gate = null) {
  const run = async () => {
    const userMsg = transcript[transcript.length - 1];
    const userText = typeof userMsg?.content === 'string' ? userMsg.content : '';
    // The persistent session's systemPrompt is fixed at session start (can
    // live for hours), so live status can't ride on it without going stale —
    // it's freshened here instead, per turn, the same way recap works below.
    // Bounded to 150ms (2026-07-21, latency audit): statusDigest() already
    // races its own fetches internally, but that raced worst case (up to
    // ~2.5s) was still fully serial in front of EVERY turn's first token,
    // including plain chit-chat that never touches the fleet. A slow/down
    // dependency degrades to "no digest this turn," never to added lag.
    const digest = await Promise.race([
      statusDigest().catch(() => ''),
      new Promise((resolve) => setTimeout(() => resolve(''), 150)),
    ]);

    let escalateTo = null; // set when a turn fails non-fatally → retry on a higher tier
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = !session || session.dead;
      if (fresh) session = startSession(escalateTo || undefined);
      const s = session;
      const ctx = { pending: null, dispatched: null, gate };
      currentCtx = ctx;

      try {
        const text = await runTurn(s, (fresh ? recapFrom(transcript) : '') + (digest ? digest + ' ' : '') + userText, onChunk);
        transcript.push({ role: 'assistant', content: text });
        if (transcript.length > 24) transcript.splice(0, transcript.length - 24);
        // An escalated session served its one hard turn — drop back to the
        // everyday tier afterwards so usage limits aren't burned on chit-chat.
        if (escalateTo) disposeSession('de-escalate after escalated turn');
        const speech = text.replace(/\s+/g, ' ').trim().slice(0, 400);
        return { text: text || '(no reply)', speech, dispatched: ctx.dispatched };
      } catch (e) {
        const cls = classifyFailure({ message: e.message, stderr: String(e.resultMessage?.result || '') });
        console.error(`[brain-claude] turn failed (${cls.kind}) on ${s.profile}/${s.model}: ${e.message.slice(0, 200)}`);
        disposeSession(`turn failure: ${cls.kind}`);
        if (cls.kind === 'usage_limit' && attempt === 0) {
          const next = await reportExhausted(s.profile, cls.resetAt);
          if (next) continue;             // retry once on the other login
        } else if (cls.kind === 'auth') {
          await reportAuthFailure(s.profile, e.message);
        } else if (cls.kind === 'other' && attempt === 0 && nextTierUp(s.model) !== s.model) {
          escalateTo = nextTierUp(s.model); // Sonnet struggled → one retry on the bigger brain
          console.warn(`[brain-claude] escalating retry to ${escalateTo}`);
          continue;
        }
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

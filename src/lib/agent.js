/**
 * Jarvis agentic brain — src/lib/agent.js
 *
 * A Claude tool-calling loop that lets Craig TALK to Jarvis instead of issuing
 * rigid commands. The model reads free-form speech, decides whether to just
 * answer or to take an action, and calls tools that map 1:1 onto the existing
 * handlers in lib/conversation.js — so there is zero behaviour drift from the
 * frozen Slack/intent path.
 *
 * FOUR PROVIDERS, ONE BRAIN (Craig's ruling, 2026-07-19): the PRIMARY brain is
 * 'claude' — a persistent Agent SDK session billed to Craig's claude.ai
 * SUBSCRIPTION logins (brain-claude.js + claude-auth.js two-account failover).
 * It never runs out of credits, only hits resettable usage limits, and flips
 * between Craig's two logins automatically. The metered APIs (openai,
 * anthropic, gemini) remain as EMERGENCY fallbacks only; any automatic
 * failover away from claude is announced out loud via notify() — the silent
 * Gemini downgrade of 2026-07-18 must never repeat.
 * BRAIN_PROVIDER=auto prefers claude whenever a subscription login exists.
 * Runtime-switchable by voice ("Jarvis, switch brain to GPT / Claude") via
 * maybeBrainSwitch(), persisted in memory KV 'brain-provider'. The transcript
 * stays in Anthropic block format for every provider, so mid-session switches
 * are safe. Callers MUST check hasAgent() first and fall back to
 * resolveIntent()/runIntent() when no provider is usable.
 * Tools + persona live in brain-tools.js — ONE surface for all providers.
 *
 * Safety: dispatch_job is GATED. The first call returns needs_confirmation with
 * a spoken summary; the actual orchestrator dispatch only fires when the model
 * calls it again with confirmed:true (which it should do only after Craig says
 * yes). A misheard sentence therefore cannot launch an agent on its own.
 *
 * Streaming contract (matches gateway-server.js converseStream):
 *   onChunk(textDelta)     — assistant prose tokens, as they arrive
 *   returns { text, speech } — full reply text + a short spoken form for TTS
 */

import { MEMORY } from './conversation.js';
import { TOOLS, runTool, systemPrompt } from './brain-tools.js';
import { runClaudeBrain, hasClaudeBrain, warmupClaudeBrain, restartClaudeBrain, setBrainModel } from './brain-claude.js';
import { switchProfile } from './claude-auth.js';
import { notify } from './notify.js';

// Fable 5 — Anthropic's top-tier model. Craig's call (2026-07-16): the brain
// runs the smartest model available; cost is accepted. Workers stay on sonnet.
const AGENT_MODEL = 'claude-fable-5';
const API_URL     = 'https://api.anthropic.com/v1/messages';
// OpenAI side — override with OPENAI_BRAIN_MODEL when a newer model lands.
const OPENAI_URL  = 'https://api.openai.com/v1/chat/completions';
const openaiModel = () => process.env.OPENAI_BRAIN_MODEL || 'gpt-5.1';
// Gemini side (Google AI Studio) — needs GEMINI_API_KEY.
const geminiModel = () => process.env.GEMINI_BRAIN_MODEL || 'gemini-flash-latest';
const geminiUrl   = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;
const MAX_TURNS   = 8;   // tool-use round-trips before we force a final answer
const MAX_TOKENS  = 2000;

// ── Provider selection ───────────────────────────────────────────────────────
// 'claude' = subscription Agent SDK session (no API key — keyFor returns a
// truthy sentinel when a login exists). The rest are metered APIs.
const PROVIDERS = ['claude', 'openai', 'anthropic', 'gemini'];
const openaiKey    = () => process.env.OPENAI_API_KEY || null;
const anthropicKey = () => process.env.ANTHROPIC_API_KEY || null;
const geminiKey    = () => process.env.GEMINI_API_KEY || null;
const keyFor = (p) => p === 'claude' ? (hasClaudeBrain() ? 'subscription' : null)
  : p === 'openai' ? openaiKey() : p === 'anthropic' ? anthropicKey() : geminiKey();

let brainProvider = null; // resolved/switched provider name
(async () => { // restore last voice-switched choice across restarts (best effort)
  try {
    const r = await fetch(`${MEMORY}/memory/kv/brain-provider`).then(r => r.json());
    if (PROVIDERS.includes(r?.value)) brainProvider = r.value;
  } catch { /* KV empty or memory down — env/auto rules apply */ }
})();

export function getBrainProvider() {
  if (brainProvider) return brainProvider;
  const pref = (process.env.BRAIN_PROVIDER || 'auto').toLowerCase();
  if (PROVIDERS.includes(pref)) return (brainProvider = pref);
  return (brainProvider = hasClaudeBrain() ? 'claude'
    : openaiKey() ? 'openai' : anthropicKey() ? 'anthropic' : 'gemini');
}

// Pre-warm the subscription brain at service boot so the first voice turn has
// no CLI cold start. Delayed so the KV brain-provider restore above lands first.
setTimeout(() => {
  try { if (getBrainProvider() === 'claude') warmupClaudeBrain(); } catch { /* best effort */ }
}, 3000);

export function hasAgent() {
  return !!keyFor(getBrainProvider());
}

// One-shot degradation signal so the servers announce "basic mode" ONCE (not on
// every utterance) when the smart brain falls back to the keyword pipeline, and
// once again when it recovers. Returns a string to speak, or null for silence.
let brainHealthy = true;
export function noteBrainDegraded() {
  if (!brainHealthy) return null;
  brainHealthy = false;
  return 'My reasoning brain is unavailable, sir — running in basic command mode until it returns.';
}
export function noteBrainHealthy() {
  if (brainHealthy) return null;
  brainHealthy = true;
  return 'Reasoning brain back online, sir.';
}

// "Jarvis, switch brain to GPT / Claude" and "Jarvis, switch account" — both
// servers call this before the agent; a non-null return is the spoken
// confirmation and the turn is done.
const SWITCH_RE = /\b(?:switch|change|set|swap)\s+(?:the\s+)?(?:brain|model|ai)\s*(?:over\s+)?(?:to\s+)?(gpt|codex|open\s*ai|chatgpt|claude|sonnet|opus|fable|anthropic|gemini|google|bard)\b/i;
const ACCOUNT_RE = /\b(?:switch|swap|change|use)\s+(?:to\s+)?(?:the\s+)?(?:other\s+)?(?:claude\s+)?account\b/i;
export async function maybeBrainSwitch(text) {
  // Account flip between Craig's two subscription logins.
  if (ACCOUNT_RE.test(String(text || ''))) {
    const got = await switchProfile('other');
    if (!got) return 'I only have one Claude login on this box right now, sir — the second account still needs signing in.';
    restartClaudeBrain('voice account switch');
    if (getBrainProvider() === 'claude') warmupClaudeBrain();
    return `Switched to Claude account ${got === 'default' ? 'one' : got.replace(/^account-/, '')}, sir.`;
  }
  const m = String(text || '').match(SWITCH_RE);
  if (!m) return null;
  const want  = /gpt|codex|open\s*ai|chatgpt/i.test(m[1]) ? 'openai'
              : /gemini|google|bard/i.test(m[1]) ? 'gemini' : 'claude';
  const label = want === 'openai' ? 'GPT' : want === 'gemini' ? 'Gemini' : 'Claude';
  const vendor = want === 'openai' ? 'OpenAI' : want === 'gemini' ? 'Google' : 'Anthropic';
  if (!keyFor(want)) {
    return want === 'claude'
      ? "I can't switch to Claude, sir — no subscription login is set up on this box."
      : `I can't switch to ${label}, sir — no ${vendor} API key is configured on this box.`;
  }
  brainProvider = want;
  try {
    await fetch(`${MEMORY}/memory/kv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'brain-provider', value: want }),
    });
  } catch { /* persistence is best-effort */ }
  // "switch model to sonnet/opus/fable" — pick the Claude tier as well.
  if (want === 'claude' && /sonnet|opus|fable/i.test(m[1])) {
    const tier = await setBrainModel(m[1]);
    if (tier) return `Brain switched to Claude ${tier}, sir.`;
  }
  return `Brain switched to ${label}, sir.`;
}

/**
 * Run one conversational turn through the agent.
 *   transcript — array of {role, content} (content may be string or blocks);
 *                mutated in place with this turn's assistant/tool messages.
 *   onChunk    — streamed assistant text deltas.
 * Returns { text, speech, dispatched } — dispatched is the orchestrator job
 * payload if a confirmed dispatch fired this turn (so the caller can watchJob).
 */
export async function runAgent(transcript, userText, onChunk = () => {}, gate = null) {
  transcript.push({ role: 'user', content: userText });

  // Try the active provider; on an auth/billing/API failure, fail over to the
  // other provider if it has a key (a Claude-pinned box with dead credits
  // auto-recovers on GPT, and vice-versa) and STICK to the one that worked.
  const primary = getBrainProvider();
  const order = [primary, ...PROVIDERS.filter(p => p !== primary)]; // primary first, then fail over
  const before = transcript.length;
  let lastErr = null;

  for (const provider of order) {
    const apiKey = keyFor(provider);
    if (!apiKey) continue;
    try {
      const out = provider === 'claude'
        ? await runClaudeBrain(transcript, onChunk, gate)
        : await runBrainLoop(provider, apiKey, transcript, onChunk, gate);
      if (provider !== brainProvider) { // failed over — make the working one sticky
        brainProvider = provider;
        fetch(`${MEMORY}/memory/kv`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'brain-provider', value: provider }),
        }).catch(() => {});
        console.warn(`[agent] failed over to ${provider} (${primary} unavailable)`);
        // NEVER degrade silently (the Gemini incident of 2026-07-18): leaving
        // the subscription brain is announced out loud; returning to it too.
        const label = provider === 'openai' ? 'GPT' : provider === 'gemini' ? 'Gemini' : provider === 'claude' ? 'Claude' : 'the metered Claude API';
        notify({
          source: 'brain', level: provider === 'claude' ? 'info' : 'warn',
          title: `Brain failed over: ${primary} → ${provider}`,
          body: `The ${primary} brain was unavailable; the brain is now running on ${provider} (sticky until switched back).`,
          speech: provider === 'claude'
            ? 'Reasoning brain back on Claude, sir.'
            : `Sir, my Claude brain is unavailable — running on ${label} until it returns.`,
        }).catch(() => {});
      }
      return out;
    } catch (e) {
      lastErr = e;
      console.error(`[agent] ${provider} brain failed: ${e.message}`);
      transcript.splice(before); // undo any partial turns before retrying/bailing
    }
  }
  throw lastErr || new Error('agent unavailable: no usable brain provider');
}

// The tool-calling loop for one provider. Throws on API failure so runAgent can
// fail over. Returns { text, speech, dispatched }.
async function runBrainLoop(provider, apiKey, transcript, onChunk, gate = null) {
  const ctx = { pending: null, dispatched: null, gate };
  let finalText = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { text, toolUses } = provider === 'openai'
      ? await streamOnceOpenAI(apiKey, transcript, onChunk)
      : provider === 'gemini'
      ? await callGemini(apiKey, transcript, onChunk)
      : await streamOnce(apiKey, transcript, onChunk);
    if (text) finalText = text;

    if (!toolUses.length) break; // model gave a plain answer — done

    // Record the assistant's tool-use message, then run each tool.
    const assistantBlocks = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    for (const tu of toolUses) {
      const blk = { type: 'tool_use', id: tu.id, name: tu.name, input: tu.input };
      if (tu.sig) blk._thoughtSig = tu.sig; // Gemini 3 thinking signature — replayed to Gemini, stripped for others
      assistantBlocks.push(blk);
    }
    transcript.push({ role: 'assistant', content: assistantBlocks });

    const toolResults = [];
    for (const tu of toolUses) {
      let out;
      try { out = await runTool(tu.name, tu.input || {}, ctx); }
      catch (e) { out = `Tool ${tu.name} failed: ${e.message}`; }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out).slice(0, 4000) });
    }
    transcript.push({ role: 'user', content: toolResults });
    // loop again so the model can read tool output and answer (or chain a tool)
  }

  if (finalText) transcript.push({ role: 'assistant', content: finalText });
  // keep the transcript bounded (voice sessions are long-lived)
  if (transcript.length > 24) transcript.splice(0, transcript.length - 24);

  const speech = finalText.replace(/\s+/g, ' ').trim().slice(0, 400);
  return { text: finalText || '(no reply)', speech, dispatched: ctx.dispatched };
}

// Anthropic sends transcript blocks RAW, so strip the Gemini-only _thoughtSig
// key that may be present after a mid-conversation provider switch.
function sanitizeForAnthropic(transcript) {
  return transcript.map(m => {
    if (typeof m.content === 'string') return m;
    return { role: m.role, content: m.content.map(b => {
      if (b && b._thoughtSig) { const { _thoughtSig, ...rest } = b; return rest; }
      return b;
    }) };
  });
}

// ── One streaming Messages API call; returns final text + any tool_use blocks ─
async function streamOnce(apiKey, transcript, onChunk) {
  const r = await fetch(API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: AGENT_MODEL,
      max_tokens: MAX_TOKENS,
      stream: true,
      system: systemPrompt(),
      tools: TOOLS,
      messages: sanitizeForAnthropic(transcript),
    }),
  });
  if (!r.ok) throw new Error(`Anthropic API ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const toolUses = [];
  const partialJson = {}; // index → accumulated input_json_delta string

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }

      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
        toolUses[ev.index] = { id: ev.content_block.id, name: ev.content_block.name, input: {} };
        partialJson[ev.index] = '';
      } else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta' && ev.delta.text) { text += ev.delta.text; onChunk(ev.delta.text); }
        else if (ev.delta?.type === 'input_json_delta') { partialJson[ev.index] = (partialJson[ev.index] || '') + (ev.delta.partial_json || ''); }
      } else if (ev.type === 'content_block_stop' && toolUses[ev.index]) {
        try { toolUses[ev.index].input = partialJson[ev.index] ? JSON.parse(partialJson[ev.index]) : {}; }
        catch { toolUses[ev.index].input = {}; }
      }
    }
  }
  return { text: text.trim(), toolUses: toolUses.filter(Boolean) };
}

// ── OpenAI provider ──────────────────────────────────────────────────────────
// The transcript's canonical format stays Anthropic blocks; translate per call.

const OPENAI_TOOLS = TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

function toOpenAIMessages(transcript) {
  const msgs = [{ role: 'system', content: systemPrompt() }];
  // OpenAI is strict: a `tool` message must immediately follow an assistant
  // message whose tool_calls include its id. When the rolling transcript is
  // trimmed mid-exchange it can orphan a tool_result (its assistant tool_use got
  // cut) — which 400'd the whole brain. Track the ids opened by the last
  // assistant turn and DROP any tool_result that isn't one of them.
  let openIds = new Set();
  for (const m of transcript) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); openIds = new Set(); continue; }
    if (m.role === 'assistant') {
      let text = '';
      const calls = [];
      for (const b of m.content) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') calls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
      }
      if (!text && !calls.length) continue;
      const am = { role: 'assistant', content: text || null };
      if (calls.length) am.tool_calls = calls;
      msgs.push(am);
      openIds = new Set(calls.map(c => c.id));
    } else { // user message carrying tool results → one 'tool' message each
      let consumed = false;
      for (const b of m.content) {
        if (b.type === 'tool_result' && openIds.has(b.tool_use_id)) {
          msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
          consumed = true;
        }
        // orphan tool_results (no matching open tool_call) are silently dropped
      }
      if (consumed) openIds = new Set();
    }
  }
  return msgs;
}

// One streaming chat-completions call; same return shape as streamOnce().
async function streamOnceOpenAI(apiKey, transcript, onChunk) {
  const r = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: openaiModel(),
      stream: true,
      max_completion_tokens: MAX_TOKENS,
      // gpt-5.x on chat/completions only allows function tools with reasoning
      // off ("use /v1/responses or set reasoning_effort to 'none'"). Voice
      // wants fast answers anyway; flip via OPENAI_BRAIN_EFFORT only if we
      // ever migrate to /v1/responses.
      ...(openaiModel().startsWith('gpt-5') ? { reasoning_effort: 'none' } : {}),
      messages: toOpenAIMessages(transcript),
      tools: OPENAI_TOOLS,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI API ${r.status}: ${(await r.text()).slice(0, 200)}`);

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  const calls = []; // index → { id, name, args } accumulated across deltas

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') continue;
      let ev; try { ev = JSON.parse(payload); } catch { continue; }
      const d = ev.choices?.[0]?.delta;
      if (!d) continue;
      if (typeof d.content === 'string' && d.content) { text += d.content; onChunk(d.content); }
      for (const tc of d.tool_calls || []) {
        const slot = calls[tc.index] || (calls[tc.index] = { id: '', name: '', args: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
      }
    }
  }

  const toolUses = calls.filter(Boolean).map((c, i) => {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch { /* malformed args → {} */ }
    return { id: c.id || `call_${i}`, name: c.name, input };
  });
  return { text: text.trim(), toolUses };
}

// ── Gemini provider (Google AI Studio) ───────────────────────────────────────
// Same canonical Anthropic-block transcript; translated to Gemini `contents`.
// Non-streaming under the hood (generateContent) — the tool loop only needs the
// final text + tool calls; onChunk gets the text once it lands.
const GEMINI_TOOLS = [{ function_declarations: TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];

function toGeminiContents(transcript) {
  const contents = [];
  const idToName = {}; // tool_use id → function name (Gemini keys results by name)
  // Gemini is strict: a functionResponse must IMMEDIATELY follow the functionCall
  // it answers. When the rolling transcript is trimmed mid-exchange it can orphan
  // a tool_result (its call was cut) → 400. Track the calls opened by the last
  // model turn and DROP any tool_result that isn't one of them.
  let openNames = new Set();
  for (const m of transcript) {
    if (typeof m.content === 'string') { contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }); openNames = new Set(); continue; }
    if (m.role === 'assistant') {
      const parts = [];
      const names = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') {
          idToName[b.id] = b.name;
          const part = { functionCall: { name: b.name, args: b.input || {} } };
          if (b._thoughtSig) part.thoughtSignature = b._thoughtSig; // required by Gemini 3 thinking
          parts.push(part);
          names.push(b.name);
        }
      }
      if (parts.length) { contents.push({ role: 'model', parts }); openNames = new Set(names); }
    } else {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const nm = idToName[b.tool_use_id] || 'tool';
          if (openNames.has(nm)) parts.push({ functionResponse: { name: nm, response: { result: String(b.content) } } });
          // orphan tool_result (its call was trimmed away) → dropped
        }
      }
      if (parts.length) { contents.push({ role: 'user', parts }); openNames = new Set(); }
    }
  }
  return contents;
}

async function callGemini(apiKey, transcript, onChunk) {
  const r = await fetch(geminiUrl(geminiModel()), {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents: toGeminiContents(transcript),
      tools: GEMINI_TOOLS,
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
  });
  if (!r.ok) throw new Error(`Gemini API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const parts = j.candidates?.[0]?.content?.parts || [];
  let text = '';
  const toolUses = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    else if (p.functionCall) toolUses.push({ id: `gm_${toolUses.length}`, name: p.functionCall.name, input: p.functionCall.args || {}, sig: p.thoughtSignature || p.thought_signature || null });
  }
  if (text) onChunk(text);
  return { text: text.trim(), toolUses };
}

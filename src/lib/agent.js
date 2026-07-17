/**
 * Jarvis agentic brain — src/lib/agent.js
 *
 * A Claude tool-calling loop that lets Craig TALK to Jarvis instead of issuing
 * rigid commands. The model reads free-form speech, decides whether to just
 * answer or to take an action, and calls tools that map 1:1 onto the existing
 * handlers in lib/conversation.js — so there is zero behaviour drift from the
 * frozen Slack/intent path.
 *
 * TWO PROVIDERS, ONE BRAIN (Craig's split, 2026-07-17): the brain can run on
 * either the OpenAI API (GPT/Codex credits) or the Anthropic Messages API.
 * BRAIN_PROVIDER=auto prefers OpenAI when OPENAI_API_KEY is set, else
 * Anthropic; runtime-switchable by voice ("Jarvis, switch brain to GPT /
 * Claude") via maybeBrainSwitch(), persisted in memory KV 'brain-provider'.
 * The transcript is stored in Anthropic block format regardless of provider
 * (toOpenAIMessages() translates per call), so mid-session switches are safe.
 * Callers MUST check hasAgent() first and fall back to resolveIntent()/
 * runIntent() when no usable key exists — this module deliberately does NOT
 * shell out to the `claude`/`codex` CLIs (the claude CLI path stays in
 * conversation.js as the graceful fallback).
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

import {
  handleStatus, handlePlatformStatus, handleJobs, handleAsk,
  handleBriefing, handleRoadmap, handleDispatch,
  platformNames, matchPlatform, MEMORY,
} from './conversation.js';

// Fable 5 — Anthropic's top-tier model. Craig's call (2026-07-16): the brain
// runs the smartest model available; cost is accepted. Workers stay on sonnet.
const AGENT_MODEL = 'claude-fable-5';
const API_URL     = 'https://api.anthropic.com/v1/messages';
// OpenAI side — override with OPENAI_BRAIN_MODEL when a newer model lands.
const OPENAI_URL  = 'https://api.openai.com/v1/chat/completions';
const openaiModel = () => process.env.OPENAI_BRAIN_MODEL || 'gpt-5.1';
const MAX_TURNS   = 8;   // tool-use round-trips before we force a final answer
const MAX_TOKENS  = 2000;

// ── Provider selection ───────────────────────────────────────────────────────
const openaiKey    = () => process.env.OPENAI_API_KEY || null;
const anthropicKey = () => process.env.ANTHROPIC_API_KEY || null;

let brainProvider = null; // 'openai' | 'anthropic' once resolved/switched
(async () => { // restore last voice-switched choice across restarts (best effort)
  try {
    const r = await fetch(`${MEMORY}/memory/kv/brain-provider`).then(r => r.json());
    if (r?.value === 'openai' || r?.value === 'anthropic') brainProvider = r.value;
  } catch { /* KV empty or memory down — env/auto rules apply */ }
})();

export function getBrainProvider() {
  if (brainProvider) return brainProvider;
  const pref = (process.env.BRAIN_PROVIDER || 'auto').toLowerCase();
  if (pref === 'openai' || pref === 'anthropic') return (brainProvider = pref);
  return (brainProvider = openaiKey() ? 'openai' : 'anthropic');
}

export function hasAgent() {
  return getBrainProvider() === 'openai' ? !!openaiKey() : !!anthropicKey();
}

// "Jarvis, switch brain to GPT / Claude" — both servers call this before the
// agent; a non-null return is the spoken confirmation and the turn is done.
const SWITCH_RE = /\b(?:switch|change|set|swap)\s+(?:the\s+)?(?:brain|model|ai)\s*(?:over\s+)?(?:to\s+)?(gpt|codex|open\s*ai|chatgpt|claude|sonnet|fable|anthropic)\b/i;
export async function maybeBrainSwitch(text) {
  const m = String(text || '').match(SWITCH_RE);
  if (!m) return null;
  const want  = /gpt|codex|open\s*ai|chatgpt/i.test(m[1]) ? 'openai' : 'anthropic';
  const label = want === 'openai' ? 'GPT' : 'Claude';
  if (!(want === 'openai' ? openaiKey() : anthropicKey())) {
    return `I can't switch to ${label}, sir — no ${want === 'openai' ? 'OpenAI' : 'Anthropic'} API key is configured on this box.`;
  }
  brainProvider = want;
  try {
    await fetch(`${MEMORY}/memory/kv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'brain-provider', value: want }),
    });
  } catch { /* persistence is best-effort */ }
  return `Brain switched to ${label}, sir.`;
}

function systemPrompt() {
  // The CEO-orchestrator persona from Craig's Command Deck design handoff,
  // adapted to the tools that actually exist here.
  return [
    'You are JARVIS, the Chief Executive Orchestrator of a private multi-agent platform owned and directed by one principal, Craig. You are the only agent that speaks with him.',
    'IDENTITY & TONE: Address him as "Sir". Be precise, calm, lightly dry-witted, never sycophantic. You are spoken aloud — 1-3 natural sentences unless he asks for detail. No markdown, no emoji, no bullet lists in spoken replies.',
    `SITUATION: You command the platform fleet: ${platformNames().join(', ')}. Role agents (social media, accountants, legal) run on cron under the agent scheduler; the orchestrator dispatches Claude workers; self-heal watches the fleet.`,
    'DOCTRINE: Lead with the single most important fact. Numbers over adjectives — one flagged risk beats ten green checkmarks. If an agent is down or a queue is backed up, say so immediately with impact. End with a proposed next action when one exists.',
    'ROUTE, DON\'T GUESS: when a question maps to a tool (status, platform health, jobs, briefing, history, roadmap, inbox, agent reports), call the tool and answer from its output.',
    'ESCALATE, DON\'T DECIDE on anything irreversible: dispatch_job MUST be called with confirmed=false first to describe the action; only after Craig verbally agrees do you call it again with confirmed=true.',
  ].join(' ');
}

// ── Tool schemas exposed to the model ────────────────────────────────────────
const TOOLS = [
  { name: 'get_status', description: "Overall system + all-platform health snapshot (server CPU/RAM/disk, Jarvis services, each platform's state).",
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_platform_status', description: "Health/state of ONE platform, incl. why it might be slow/down. Also returns a fresh screenshot when the platform has a public URL.",
    input_schema: { type: 'object', properties: { platform: { type: 'string', description: 'platform name' } }, required: ['platform'] } },
  { name: 'list_jobs', description: 'Currently running and recent orchestrator jobs (Claude agents working on platforms).',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'query_memory', description: "Ask Jarvis's long-term memory a history/knowledge question (what broke, what happened, past issues).",
    input_schema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
  { name: 'get_briefing', description: 'The morning/daily rundown across every platform, plus running jobs.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_roadmap', description: 'Completion status of the JARVIS PROJECT ITSELF (how much is built/left), not a platform.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_inbox', description: "Craig's notification inbox — recent alerts/warnings/info from all Jarvis services. Use for 'what needs my attention' / 'any alerts'.",
    input_schema: { type: 'object', properties: { unread_only: { type: 'boolean', description: 'default true' } }, required: [] } },
  { name: 'get_agent_reports', description: 'Latest reports filed by the role agents (social media, accountants, legal) — what each department last did and found.',
    input_schema: { type: 'object', properties: {}, required: [] } },
  { name: 'dispatch_job', description: "Send a Claude agent to DO WORK on a platform (fix, build, change, deploy). GATED: call with confirmed=false first to preview; only confirmed=true after Craig says yes actually launches it.",
    input_schema: { type: 'object', properties: {
      platform: { type: 'string', description: 'target platform (or omit to auto-detect from the task)' },
      task: { type: 'string', description: 'what the agent should do' },
      confirmed: { type: 'boolean', description: 'true ONLY after Craig has verbally confirmed' },
    }, required: ['task'] } },
];

// ── Tool implementations — thin wrappers over conversation.js handlers ────────
// Each returns a string the model reads. `pending` carries a dispatch awaiting
// confirmation so the caller can persist it on the connection if desired.

async function runTool(name, input, ctx) {
  switch (name) {
    case 'get_status':          return (await handleStatus()).text;
    case 'list_jobs':           return (await handleJobs()).text;
    case 'get_briefing':        return (await handleBriefing()).text;
    case 'get_roadmap':         return (await handleRoadmap()).text;
    case 'query_memory':        return (await handleAsk(input.question || '')).text;
    case 'get_inbox': {
      const qs = input.unread_only === false ? '?limit=15' : '?unread=1';
      const r = await fetch(`${MEMORY}/memory/notifications${qs}`).then(r => r.json());
      const list = (r?.notifications || []).slice(0, 15);
      if (!list.length) return 'Inbox clear — no unread notifications.';
      return list.map(n => `[${n.level}] ${n.ts.slice(5, 16)} ${n.title}${n.body && n.body !== n.title ? ' — ' + n.body.slice(0, 120) : ''}`).join('\n');
    }
    case 'get_agent_reports': {
      const r = await fetch(`${MEMORY}/memory/agent-reports?limit=12`).then(r => r.json());
      const list = Array.isArray(r) ? r : [];
      if (!list.length) return 'No agent reports on file yet.';
      return list.map(x => `${x.agent} [${x.status}] ${x.ts.slice(5, 16)}: ${x.summary}`).join('\n');
    }
    case 'get_platform_status': {
      const p = input.platform && platformNames().includes(input.platform.toLowerCase())
        ? input.platform.toLowerCase() : matchPlatform(input.platform || '');
      if (!p) return `Unknown platform "${input.platform}". Known: ${platformNames().join(', ')}.`;
      return (await handlePlatformStatus(p)).text;
    }
    case 'dispatch_job': {
      const task = (input.task || '').trim();
      if (!task) return 'No task described.';
      const platform = input.platform && platformNames().includes(input.platform.toLowerCase())
        ? input.platform.toLowerCase() : (matchPlatform(input.platform || task) || 'auto');
      if (!input.confirmed) {
        ctx.pending = { platform, task };
        return `NEEDS CONFIRMATION. Prepared to dispatch to "${platform}": ${task}. Ask Craig to confirm out loud before calling again with confirmed=true.`;
      }
      // Confirmed → actually dispatch via the existing handler.
      const res = await handleDispatch(task, platform, () => {});
      ctx.dispatched = res?.data || null;
      ctx.pending = null;
      return res.text;
    }
    default: return `Unknown tool ${name}.`;
  }
}

/**
 * Run one conversational turn through the agent.
 *   transcript — array of {role, content} (content may be string or blocks);
 *                mutated in place with this turn's assistant/tool messages.
 *   onChunk    — streamed assistant text deltas.
 * Returns { text, speech, dispatched } — dispatched is the orchestrator job
 * payload if a confirmed dispatch fired this turn (so the caller can watchJob).
 */
export async function runAgent(transcript, userText, onChunk = () => {}) {
  const provider = getBrainProvider();
  const apiKey = provider === 'openai' ? openaiKey() : anthropicKey();
  if (!apiKey) throw new Error(`agent unavailable: no ${provider} API key set`);

  transcript.push({ role: 'user', content: userText });
  const ctx = { pending: null, dispatched: null };
  let finalText = '';

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { text, toolUses } = provider === 'openai'
      ? await streamOnceOpenAI(apiKey, transcript, onChunk)
      : await streamOnce(apiKey, transcript, onChunk);
    if (text) finalText = text;

    if (!toolUses.length) break; // model gave a plain answer — done

    // Record the assistant's tool-use message, then run each tool.
    const assistantBlocks = [];
    if (text) assistantBlocks.push({ type: 'text', text });
    for (const tu of toolUses) assistantBlocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
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
      messages: transcript,
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
  for (const m of transcript) {
    if (typeof m.content === 'string') { msgs.push({ role: m.role, content: m.content }); continue; }
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
    } else { // user message carrying tool results → one 'tool' message each
      for (const b of m.content) {
        if (b.type === 'tool_result') msgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: String(b.content) });
      }
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

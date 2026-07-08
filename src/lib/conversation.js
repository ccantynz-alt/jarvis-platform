/**
 * Jarvis conversation engine — src/lib/conversation.js
 *
 * Transport-neutral intent detection + command handlers, extracted verbatim
 * from slack-bridge.js (2026-07-08, Gateway build — see docs/GATEWAY.md).
 * Consumed by BOTH:
 *   - src/slack-bridge.js  (FROZEN LEGACY — thin mrkdwn wrappers)
 *   - src/gateway-server.js (the Jarvis Gateway, voice/text over tailnet)
 * Sharing this module is what makes behavior drift between the two impossible.
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
  voxlen:   'https://voxlen.com',
  bookaride:'https://bookaride.com',
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
const INTENT_TYPES = ['ask', 'dispatch', 'jobs', 'status', 'platform-status', 'briefing', 'help'];

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
    '',
    `Known platforms: ${platforms.join(', ')}`,
    'Set "platform" to null if no known platform is mentioned.',
    'Respond with STRICT JSON only — a single object, no prose, no markdown fences.',
    '',
    `Message: ${JSON.stringify(text)}`,
  ].join('\n');
}

function runClaudeCli(prompt) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const proc = spawn('claude', ['--model', HAIKU_MODEL, '--print', prompt], {
      env: { ...process.env, HOME: '/root' },
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
  const output = await runClaudeCli(buildClassifyPrompt(text));
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
  } catch (e) {
    msg += `❌ Memory unavailable: ${e.message}`;
    speech = 'Sorry, memory is unavailable for the briefing.';
  }

  return { text: msg, speech };
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
    `• _anything else_ — passed through to orchestrator as a task\n\n` +
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
export async function runIntent(intent, rawText, onEvent = () => {}) {
  switch (intent.type) {
    case 'ask':             return handleAsk(intent.question);
    case 'dispatch':        return handleDispatch(rawText, intent.platform, onEvent);
    case 'jobs':            return handleJobs();
    case 'status':          return handleStatus();
    case 'platform-status': return handlePlatformStatus(intent.platform);
    case 'briefing':        return handleBriefing();
    case 'help':            return handleHelp();
    case 'passthrough':
    default:                return handleDispatch(rawText, 'auto', onEvent);
  }
}

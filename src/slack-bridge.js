/**
 * Jarvis Slack Bridge — src/slack-bridge.js
 *
 * ⚠️ FROZEN LEGACY (decision 2026-07-08, see docs/ROADMAP.md + docs/GATEWAY.md):
 * zero new features. The intent engine + handlers live in src/lib/conversation.js,
 * shared with the Jarvis Gateway; this file is only the Slack transport wrapper.
 * Retirement: NOTIFY_SLACK_LEGACY=0 → disable jarvis-slack → delete.
 *
 * Receives commands from #jarvis via Socket Mode (preferred) or HTTP Events.
 * Routes to the orchestrator for dispatching Claude Code agents.
 *
 * Two kinds of outbound traffic, handled differently:
 *   - SOLICITED replies (Craig sent a command, Jarvis answers) → posted
 *     directly, always, even while muted.
 *   - UNSOLICITED notifications (audits, alerts, cron chatter from other
 *     services) → must pass through the NotifyCenter (src/notify-center.js):
 *     severity levels, dedupe, rate limiting, digest batching, mute and
 *     quiet hours. Control it from Slack: `mute`, `mute 2h`, `unmute`,
 *     `digest`, `notifications`.
 *
 * Socket Mode setup:
 *   1. api.slack.com/apps → Your App → Socket Mode → Enable
 *   2. Create an App-Level Token with scope: connections:write
 *   3. Add to secrets.env: SLACK_APP_TOKEN=xapp-...
 *
 * Required bot scopes: chat:write, channels:history, im:history, groups:history
 */

import express from 'express';
import { App as BoltApp } from '@slack/bolt';
import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { NotifyCenter, parseDuration } from './notify-center.js';
import { detectIntent, matchPlatform, normalizeText } from './intent.js';
import { parseAllowlist, senderAllowed } from './lib/slack-auth.js';

// ── Config ──────────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN  = process.env.SLACK_APP_TOKEN; // xapp-... for Socket Mode
const SLACK_CHANNEL    = process.env.JARVIS_SLACK_CHANNEL || '#jarvis';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORCHESTRATOR     = 'http://127.0.0.1:9205';
const MEMORY           = 'http://127.0.0.1:9200';
const SCREENSHOT       = 'http://127.0.0.1:9201';
const METRICS          = 'http://127.0.0.1:9202';

// Notification tuning — all overridable in secrets.env
// NaN-safe (2026-07-26): systemd's EnvironmentFile does NOT strip inline
// comments, so a naive Number(process.env.X || default) can silently parse to
// NaN — every downstream `< NaN` comparison is then false, which disables the
// rate limit, dedupe, AND digest-flush gates at once (this is the exact same
// bug class that caused the 117-dispatches/day incident on 2026-07-17,
// documented in self-heal.js's guardrail() — that fix was never mirrored
// here). Strip a trailing comment and fall back to the default on anything
// that doesn't parse to a positive finite number.
function guardedNumber(name, fallback) {
  const n = Number(String(process.env[name] ?? '').trim().split(/\s|#/)[0]);
  if (Number.isFinite(n) && n > 0) return n;
  if (process.env[name] !== undefined) {
    console.error(`[slack-bridge] BAD CONFIG ${name}=${JSON.stringify(process.env[name])} — using default ${fallback}`);
  }
  return fallback;
}
const DIGEST_MINUTES    = guardedNumber('JARVIS_DIGEST_MINUTES', 30);
const NOTIFY_COOLDOWN   = guardedNumber('JARVIS_NOTIFY_COOLDOWN_MINUTES', 30);
const MAX_PER_HOUR      = guardedNumber('JARVIS_MAX_IMMEDIATE_PER_HOUR', 15);
// "22-7" = hold non-critical from 10pm to 7am NZ. Set to "off" to disable.
const QUIET_HOURS_RAW   = process.env.JARVIS_QUIET_HOURS || '22-7';

// Known live URLs for screenshot — derive from platform name when not listed
const PLATFORM_URLS = {
  zoobicon: 'https://zoobicon.com',
  vapron:   'https://vapron.ai',
  alecrae:  'https://alecrae.com',
  gatetest: 'https://gatetest.ai',
  voxlen:   'https://www.voxlen.ai',
  bookaride:'https://bookaride.com',
};

// ── Platform registry ────────────────────────────────────────────────────────

function loadPlatforms() {
  try {
    const raw = readFileSync('/opt/jarvis/config/platforms.json', 'utf8');
    return JSON.parse(raw).platforms;
  } catch {
    return {};
  }
}

function platformNames() {
  return Object.keys(loadPlatforms());
}

// ── Slack send helper (solicited replies + NotifyCenter's transport) ────────

async function sendSlack(text, channel = SLACK_CHANNEL) {
  if (!SLACK_BOT_TOKEN) {
    console.log(`[slack] No token — would send: ${text.slice(0, 120)}`);
    return { ok: false, error: 'no_token' };
  }
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel, text, mrkdwn: true }),
    });
    const result = await r.json();
    if (!result.ok) console.warn('[slack] postMessage error:', result.error);
    return result;
  } catch (e) {
    console.error('[slack] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

// ── Notify Center — the gate for all unsolicited notifications ──────────────

function parseQuietHours(raw) {
  // Same inline-comment hazard as guardedNumber above, but this one fails
  // QUIET (returns null → quiet hours silently disabled) rather than NaN —
  // still worth stripping so a trailing "# ..." comment can't turn this off
  // without anyone noticing.
  const stripped = String(raw).trim().split('#')[0].trim();
  const m = stripped.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  return { start: Number(m[1]) % 24, end: Number(m[2]) % 24 };
}

const notifyCenter = new NotifyCenter({
  send: (text) => sendSlack(text),
  statePath: '/opt/jarvis/memory/notify-state.json',
  digestIntervalMs: DIGEST_MINUTES * 60 * 1000,
  dedupeCooldownMs: NOTIFY_COOLDOWN * 60 * 1000,
  maxImmediatePerHour: MAX_PER_HOUR,
  quietHours: parseQuietHours(QUIET_HOURS_RAW),
  timeZone: 'Pacific/Auckland',
});

// Digest flusher — checks every minute whether a flush is due
setInterval(() => {
  notifyCenter.flushDigest().catch(e => console.error('[notify] digest flush failed:', e.message));
}, 60_000);

// ── LLM intent classification (Claude Haiku) ─────────────────────────────────
//
// Used only when detectIntent() returns a non-confident (fallback/guessed)
// result. Prefers the HTTP Messages API when ANTHROPIC_API_KEY is set
// (~300ms); falls back to the locally-authenticated `claude` CLI (~3-10s
// cold start). Returns a validated intent object, or null on ANY failure
// so callers can fall back to the keyword result.

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CLASSIFY_TIMEOUT_MS = 20000;
const API_TIMEOUT_MS = 10000;
const INTENT_TYPES = ['ask', 'dispatch', 'jobs', 'status', 'platform-status', 'briefing', 'help', 'mute', 'unmute', 'digest'];

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
    '- "mute": user wants fewer or no notifications, is complaining about notification spam, or asks Jarvis to quiet down. Shape: {"type":"mute","duration_minutes":<number or null>}',
    '- "unmute": user wants notifications back on. Shape: {"type":"unmute"}',
    '- "digest": user asks what has been queued/batched, or for the pending digest. Shape: {"type":"digest"}',
    '- "help": asking what Jarvis can do, or the message is unparseable/unclear. Shape: {"type":"help"}',
    '',
    `Known platforms: ${platforms.join(', ')}`,
    'Set "platform" to null if no known platform is mentioned.',
    'Note: the user often addresses the bot as "jarvis" — that is the bot\'s name, not the "jarvis" platform, unless they are clearly asking about the jarvis platform itself.',
    'Respond with STRICT JSON only — a single object, no prose, no markdown fences.',
    '',
    `Message: ${JSON.stringify(text)}`,
  ].join('\n');
}

async function runClaudeApi(prompt) {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!r.ok) {
      console.warn(`[slack] haiku API HTTP ${r.status}`);
      return null;
    }
    const data = await r.json();
    return data?.content?.[0]?.text || null;
  } catch (e) {
    console.warn('[slack] haiku API error:', e.message);
    return null;
  }
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
      console.warn('[slack] haiku classify timed out — killing CLI');
      proc.kill('SIGKILL');
      done(null);
    }, CLASSIFY_TIMEOUT_MS);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      clearTimeout(timer);
      console.warn('[slack] haiku classify spawn error:', e.message);
      done(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.warn(`[slack] haiku classify exit ${code}: ${stderr.slice(0, 200)}`);
        return done(null);
      }
      done(stdout);
    });
  });
}

async function classifyIntent(text) {
  const prompt = buildClassifyPrompt(text);
  // HTTP API first (fast), CLI as fallback (slow but works without a key)
  let output = ANTHROPIC_API_KEY ? await runClaudeApi(prompt) : null;
  if (!output) output = await runClaudeCli(prompt);
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
    console.warn('[slack] haiku classify unparseable output:', output.slice(0, 200));
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !INTENT_TYPES.includes(parsed.type)) {
    console.warn('[slack] haiku classify invalid intent:', JSON.stringify(parsed).slice(0, 200));
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
  } else if (parsed.type === 'mute') {
    if (Number(parsed.duration_minutes) > 0) intent.durationMs = Number(parsed.duration_minutes) * 60 * 1000;
  }
  return intent;
}

// ── Safe JSON fetch ──────────────────────────────────────────────────────────
// Memory service occasionally appends an HTML 404 page after the JSON body.
// Strip it before parsing so we get the real data instead of a parse error.

async function fetchJSON(url, opts) {
  const r = await fetch(url, opts);
  const text = await r.text();
  const trimmed = text.replace(/<!DOCTYPE[\s\S]*$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error('Memory service unavailable');
  }
}

// ── Command handlers ─────────────────────────────────────────────────────────

async function handleAsk(question, channel) {
  if (!question) {
    return sendSlack('Ask me something — e.g. "ask jarvis what broke on vapron this week"', channel);
  }
  try {
    const r = await fetchJSON(`${MEMORY}/memory/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    return sendSlack(`🧠 ${r.answer || 'No answer found.'}`, channel);
  } catch (e) {
    return sendSlack(`❌ Memory query failed: ${e.message}`, channel);
  }
}

async function handleDispatch(task, platform, channel) {
  let resolvedPlatform = platform;

  if (!platform || platform === 'auto') {
    resolvedPlatform = matchPlatform(task.toLowerCase(), platformNames());
    if (!resolvedPlatform) {
      const known = platformNames().join(', ');
      return sendSlack(`Which platform is that for? Known: ${known}\n_(say e.g. "fix the signup flow on vapron")_`, channel);
    }
  }

  // One message per dispatch — posted after the orchestrator answers,
  // not a play-by-play.
  try {
    const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: resolvedPlatform, task }),
    });
    const data = await r.json();

    if (data.error) {
      const known = data.known?.length ? `\nKnown platforms: ${data.known.join(', ')}` : '';
      return sendSlack(`❌ Dispatch failed: ${data.error}${known}`, channel);
    }
    return sendSlack(
      `🤖 On it — *${resolvedPlatform}* agent running (job \`${data.jobId?.slice(0, 8)}\`)\n_${task.slice(0, 200)}_`,
      channel,
    );
  } catch (e) {
    return sendSlack(`❌ Orchestrator unreachable: ${e.message}`, channel);
  }
}

async function handleJobs(channel) {
  try {
    const jobs = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json());

    if (!Array.isArray(jobs) || jobs.length === 0) {
      return sendSlack('📋 No jobs in queue.', channel);
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

    return sendSlack(msg, channel);
  } catch (e) {
    return sendSlack(`❌ Jobs fetch failed: ${e.message}`, channel);
  }
}

async function handleStatus(channel) {
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
    if (filtered.length) {
      msg += `\n*Platform health:*\n`;
      for (const p of filtered) {
        // Use status string as primary signal; fall back to health_score only when set
        const healthy = p.status === 'healthy' || p.health_score > 80;
        const warn    = p.status === 'working'  || (p.health_score > 50 && p.health_score <= 80);
        const e = healthy ? '✅' : warn ? '⚠️' : '🔴';
        const score = p.health_score > 0 ? ` (${p.health_score}/100)` : '';
        msg += `${e} ${p.name}: ${p.status}${score}\n`;
      }
    }
    if (mem.open_issues > 0) {
      msg += `\n⚠️ *${mem.open_issues} open issues in memory*`;
    }

    return sendSlack(msg, channel);
  } catch (e) {
    return sendSlack(`❌ Status fetch failed: ${e.message}`, channel);
  }
}

async function handlePlatformStatus(platform, channel) {
  let msg = `📊 *${platform}* status\n`;

  // 1. Memory lookup
  try {
    const mem = await fetchJSON(`${MEMORY}/memory/platform/${platform}`);
    if (mem && mem.name) {
      const e = mem.health_score > 80 ? '✅' : mem.health_score > 50 ? '⚠️' : '🔴';
      msg += `${e} Status: ${mem.status} (${mem.health_score}/100)\n`;
      if (mem.last_issue)  msg += `Last issue: _${mem.last_issue}_\n`;
      if (mem.last_audit)  msg += `Last audit: ${mem.last_audit}\n`;
      if (mem.notes)       msg += `Notes: ${String(mem.notes).slice(0, 200)}\n`;
    } else {
      msg += `_No memory data yet — run an audit to populate_\n`;
    }
  } catch (e) {
    msg += `_Memory lookup failed: ${e.message}_\n`;
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

  return sendSlack(msg, channel);
}

async function handleBriefing(channel) {
  const names = platformNames();
  let msg = `🌅 *JARVIS MORNING BRIEFING*\n`;
  msg += `${new Date().toLocaleDateString('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;

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
  } catch (e) {
    msg += `❌ Memory unavailable: ${e.message}`;
  }

  return sendSlack(msg, channel);
}

function handleHelp(channel) {
  const platforms = platformNames().join(', ');
  const msg =
    `*Jarvis commands:*\n` +
    `• \`fix the signup flow on vapron\` — dispatch a task to a platform\n` +
    `• \`jobs\` or \`what's running\` — show job queue\n` +
    `• \`status\` — server metrics + all platform health\n` +
    `• \`how is zoobicon\` / \`check vapron\` — platform state + screenshot\n` +
    `• \`briefing\` or \`morning\` — full morning summary\n` +
    `• \`ask jarvis what broke on vapron this week\` — query memory\n` +
    `\n*Notification controls:*\n` +
    `• \`mute\` / \`mute 2h\` / \`mute all\` — silence non-critical (or all) notifications\n` +
    `• \`unmute\` — notifications back on\n` +
    `• \`digest\` — post everything that's been batched, right now\n` +
    `• \`notifications\` — show mute state, queue size, rate-limit status\n` +
    `\nPlatforms: ${platforms}`;
  return sendSlack(msg, channel);
}

// ── Notification-control handlers (solicited — always reply directly) ───────

async function handleMute(intent, channel) {
  const durationMs = intent.durationMs ?? parseDuration(intent.rawText || '');
  notifyCenter.mute(durationMs, { all: !!intent.all });
  const scope = intent.all ? 'ALL notifications (including critical)' : 'non-critical notifications';
  const until = durationMs
    ? `for ${Math.round(durationMs / 60000)} minutes`
    : 'until you say `unmute`';
  return sendSlack(
    `🔕 Muted ${scope} ${until}. ` +
    `${intent.all ? '' : 'Critical alerts still come through. '}` +
    `Everything else batches into the digest — say \`digest\` anytime to see it.`,
    channel,
  );
}

async function handleUnmute(channel) {
  notifyCenter.unmute();
  const queued = notifyCenter.digestQueue.length;
  await sendSlack(`🔔 Notifications back on.${queued ? ` ${queued} update(s) queued — posting digest now.` : ''}`, channel);
  if (queued) await notifyCenter.flushDigest({ force: true });
  return null;
}

async function handleDigestNow(channel) {
  const flushed = await notifyCenter.flushDigest({ force: true });
  if (!flushed) return sendSlack('🗞 Nothing queued — you\'re all caught up.', channel);
  return null;
}

async function handleNotifStatus(channel) {
  const s = notifyCenter.status();
  const quiet = s.quietHours ? `${s.quietHours.start}:00–${s.quietHours.end}:00 NZ` : 'off';
  return sendSlack(
    `🔔 *Notification settings*\n` +
    `• Mute: ${s.muteDesc}\n` +
    `• Queued for digest: ${s.queued}\n` +
    `• Immediate posts last hour: ${s.immediateLastHour}/${s.maxImmediatePerHour}\n` +
    `• Digest interval: every ${s.digestIntervalMin} min\n` +
    `• Quiet hours (non-critical held): ${quiet}\n` +
    `_Commands: \`mute\`, \`mute 2h\`, \`mute all\`, \`unmute\`, \`digest\`_`,
    channel,
  );
}

async function handleUnclear(rawText, channel) {
  const cleaned = normalizeText(rawText);
  return sendSlack(
    `🤔 I didn't catch that: _"${cleaned.slice(0, 120)}"_\n` +
    `Try something like \`fix the signup flow on vapron\`, \`status\`, \`how is zoobicon\`, or \`help\` for the full list.\n` +
    `_(I no longer guess — an unclear message won't launch an agent anymore.)_`,
    channel,
  );
}

/**
 * Unified entry point — called from both Socket Mode listener and HTTP events.
 * Intent resolution + handlers come from lib/conversation.js; this wrapper
 * only maps {text} results (and interim onEvent messages) to Slack posts.
 */
// ── Who is allowed to command Jarvis from Slack (2026-07-30) ────────────────
//
// Until now: NOBODY was checked. The two entry points below tested only
// `bot_id` and `subtype`, so ANY member of the workspace — including via a DM to
// the bot — could send one message and have it routed. And the Slack dispatch
// path has no confirmation gate at all (unlike the deck and the gateway, which
// require a yes in a LATER turn): handleDispatch POSTs straight to
// /dispatch, which spawns a full-permission agent as root. One message. Also
// reachable: `mute all`, which silences every alert Jarvis can raise.
//
// It was not exploitable before today only by accident — every message threw
// ReferenceError on an undeclared `ms` before reaching the switch (see line ~644).
// Fixing that this morning turned a dead path into a live one, which is exactly
// the sort of thing worth saying out loud rather than quietly patching.
//
// FAIL CLOSED: with no allowlist configured, nothing is executed. Craig has not
// sent a Slack command in 22 days, so the safe default costs nothing and the
// unsafe default costs the fleet. Every rejection is logged, and the first time
// each unknown sender appears it is announced — so he can read his own Slack user
// id out of the inbox and allowlist himself.
// The decision itself lives in lib/slack-auth.js so it can be tested — this file
// starts a Bolt listener at module scope and cannot be imported by a test.
const ALLOWED_SLACK_USERS = parseAllowlist(process.env.SLACK_ALLOWED_USERS);
const announcedSenders = new Set();
const checkSender = (userId) => senderAllowed(userId, ALLOWED_SLACK_USERS);

/** Log, and announce an unfamiliar sender ONCE so the id is discoverable. */
async function rejectSender(userId, reason, text) {
  console.warn(`[slack] REFUSED command from ${userId || '(no user id)'} (${reason}): "${String(text).slice(0, 60)}"`);
  const key = `${userId || 'unknown'}:${reason}`;
  if (announcedSenders.has(key)) return;
  announcedSenders.add(key);
  const { notify } = await import('./lib/notify.js').catch(() => ({ notify: null }));
  if (!notify) return;
  await notify({
    source: 'slack-bridge',
    level: 'warn',
    title: reason === 'no-allowlist'
      ? 'Slack command refused — no SLACK_ALLOWED_USERS configured'
      : `Slack command refused from an unrecognised user (${userId})`,
    body: reason === 'no-allowlist'
      ? `A Slack message tried to command Jarvis and was refused because SLACK_ALLOWED_USERS is not set in ` +
        `config/secrets.env. That is the safe default: the Slack path dispatches full-permission agents with no ` +
        `confirmation step. The sender's user id was ${userId || '(unknown)'} — add it to SLACK_ALLOWED_USERS if ` +
        `that is you. Message began: "${String(text).slice(0, 80)}"`
      : `Slack user ${userId} sent "${String(text).slice(0, 80)}" and was refused — they are not in ` +
        `SLACK_ALLOWED_USERS. Add them if that is intended.`,
    speech: reason === 'no-allowlist'
      ? 'Sir, a Slack message tried to command me and I refused it — no allowed-users list is configured.'
      : 'Sir, an unrecognised Slack user tried to command me. I refused it.',
  }).catch(() => {});
}

async function handleCommand(rawText, channel) {
  const t0 = Date.now();
  let intent = detectIntent(rawText, platformNames());
  let via = 'keyword';

  // Keyword result was a fallback/guess — ask Haiku, prefer its answer if valid
  if (!intent.confident) {
    const haiku = await classifyIntent(normalizeText(rawText));
    if (haiku) {
      intent = haiku;
      via = 'haiku';
    }
  }

  // `${ms}` — an identifier that has never existed in this module — sat here from
  // 2026-07-08 (11d8af7, the lib/ extraction) until 2026-07-30. ESM is strict
  // mode, so reading it throws ReferenceError, and the throw lands AFTER intent
  // resolution but BEFORE the switch below: every Slack command would have died.
  // Both call sites `.catch(e => console.error(...))`, so Craig would have seen
  // nothing at all in Slack, not even an error. t0 was declared for this and
  // never used.
  console.log(`[slack] intent via ${via} (${Date.now() - t0}ms)`);
  console.log(`[slack] intent=${JSON.stringify(intent)} text="${rawText.replace(/<[^>]+>/g, '').slice(0, 60)}"`);

  switch (intent.type) {
    case 'ask':            return handleAsk(intent.question, channel);
    case 'dispatch':       return handleDispatch(intent.task || normalizeText(rawText), intent.platform, channel);
    case 'jobs':           return handleJobs(channel);
    case 'status':         return handleStatus(channel);
    case 'platform-status':return handlePlatformStatus(intent.platform, channel);
    case 'briefing':       return handleBriefing(channel);
    case 'help':           return handleHelp(channel);
    case 'mute':           return handleMute(intent, channel);
    case 'unmute':         return handleUnmute(channel);
    case 'digest':         return handleDigestNow(channel);
    case 'notif-status':   return handleNotifStatus(channel);
    case 'unclear':
    default:               return handleUnclear(rawText, channel);
  }
}

// ── Socket Mode (preferred — no public inbound URL required) ─────────────────

if (SLACK_APP_TOKEN && SLACK_BOT_TOKEN) {
  const bolt = new BoltApp({
    token: SLACK_BOT_TOKEN,
    socketMode: true,
    appToken: SLACK_APP_TOKEN,
    logLevel: 'warn',
  });

  // All messages in channels the bot is in, plus DMs
  bolt.message(async ({ message }) => {
    // Ignore bot messages and non-message subtypes (reactions, edits, etc.)
    if (message.bot_id || message.subtype) return;
    const text = ((message.text) || '').trim();
    if (!text) return;
    console.log(`[bolt] #${message.channel} "${text.slice(0, 80)}"`);
    // Identity BEFORE intent. The Slack path dispatches root agents with no
    // confirmation turn, so this is the only thing standing in front of it.
    const who = checkSender(message.user);
    if (!who.ok) return void rejectSender(message.user, who.reason, text);
    // Fire-and-forget — Socket Mode acks first, then we do slow work
    handleCommand(text, message.channel).catch(e =>
      console.error('[bolt] handleCommand error:', e.message),
    );
  });

  bolt.start().then(() => {
    console.log('[jarvis-slack] ✅ Socket Mode connected — bot is live in Slack');
  }).catch(e => {
    console.error('[jarvis-slack] ❌ Socket Mode failed to start:', e.message);
    console.error('[jarvis-slack]    Check SLACK_APP_TOKEN has connections:write scope');
  });
} else {
  if (!SLACK_APP_TOKEN) {
    console.warn('[jarvis-slack] ⚠️  SLACK_APP_TOKEN not set — Socket Mode disabled');
    console.warn('[jarvis-slack]    Bot can SEND to Slack but cannot RECEIVE messages');
    console.warn('[jarvis-slack]    To fix:');
    console.warn('[jarvis-slack]      1. api.slack.com/apps → Your App → Socket Mode → Enable');
    console.warn('[jarvis-slack]      2. Create App-Level Token with scope: connections:write');
    console.warn('[jarvis-slack]      3. Add SLACK_APP_TOKEN=xapp-... to /opt/jarvis/config/secrets.env');
    console.warn('[jarvis-slack]      4. systemctl restart jarvis-slack');
  }
}

// ── Express HTTP API (port 9203) ─────────────────────────────────────────────
// These endpoints are called by other Jarvis services (audit-runner, metrics, etc.)
// and serve as a fallback HTTP events handler when Socket Mode is unavailable.
// Everything arriving here is UNSOLICITED → it goes through the NotifyCenter.

const app = express();
app.use(express.json());

// POST /slack/send — generic message from any Jarvis service
// Body: { text, channel?, level? (critical|warning|info), key? }
// Default level is "warning": immediate but deduped and rate-limited.
app.post('/slack/send', async (req, res) => {
  const { text, channel, level = 'warning', key = null } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  // Explicit non-default channel = a targeted message, post directly
  if (channel && channel !== SLACK_CHANNEL) {
    return res.json(await sendSlack(text, channel));
  }
  const result = await notifyCenter.notify({ text, level, key });
  res.json({ ok: true, ...result });
});

// POST /slack/report — structured audit report
// Healthy reports batch into the digest; warnings post immediately (deduped);
// critical always posts. This alone kills the daily per-platform spam.
app.post('/slack/report', async (req, res) => {
  const { platform, status, issues = [], fixed = [], health_score } = req.body;
  const emoji = status === 'healthy' ? '✅' : status === 'warning' ? '⚠️' : '🔴';
  const score = health_score != null ? ` | Score: ${health_score}/100` : '';

  let text = `${emoji} *${(platform || 'UNKNOWN').toUpperCase()} AUDIT REPORT*${score}\n`;
  text += `Status: ${status || 'unknown'}\n`;
  text += `Issues found: ${issues.length} | Fixed: ${fixed.length}\n`;

  if (issues.length > 0) {
    text += `\n*Open issues:*\n`;
    text += issues.slice(0, 10).map(i => `• ${String(i).slice(0, 120)}`).join('\n');
    if (issues.length > 10) text += `\n_...and ${issues.length - 10} more_`;
  }
  if (fixed.length > 0) {
    text += `\n\n*Fixed this session:*\n`;
    text += fixed.slice(0, 5).map(f => `✓ ${String(f).slice(0, 120)}`).join('\n');
  }

  const level = status === 'healthy' ? 'info' : status === 'warning' ? 'warning' : 'critical';
  const result = await notifyCenter.notify({ text, level, key: `audit-${platform}` });
  res.json({ ok: true, ...result });
});

// POST /slack/alert — urgent platform alert
app.post('/slack/alert', async (req, res) => {
  const { platform, message, level = 'warning' } = req.body;
  const emoji = level === 'critical' ? '🚨' : '⚠️';
  const text  = `${emoji} *JARVIS ALERT — ${(platform || '').toUpperCase()}*\n${message}`;
  const result = await notifyCenter.notify({
    text,
    level: level === 'critical' ? 'critical' : 'warning',
    key: `alert-${platform || 'general'}`,
  });
  res.json({ ok: true, ...result });
});

// POST /slack/image-alert — upload an image file to Slack and post with a message
// Gated by the NotifyCenter first: if a visual-change alert for this platform
// fired recently (or we're muted/rate-limited), the text note goes to the
// digest and the upload is skipped entirely.
// Uses Slack's current upload flow: getUploadURLExternal → PUT → completeUploadExternal
app.post('/slack/image-alert', async (req, res) => {
  const { platform, message, filepath, filename } = req.body;
  if (!filepath || !filename) return res.status(400).json({ error: 'filepath and filename required' });
  if (!existsSync(filepath)) return res.status(400).json({ error: `File not found: ${filepath}` });
  if (!SLACK_BOT_TOKEN) return res.status(503).json({ error: 'no_token' });

  // Would this even be allowed out right now? Do a dry-run via a sentinel send.
  let gateAction = null;
  const gate = await notifyCenter.notify({
    text: message || `📸 Visual change on *${platform || 'unknown'}*`,
    level: 'warning',
    key: `visual-${platform || filename}`,
  });
  gateAction = gate.action;
  if (gateAction !== 'sent') {
    // Text note is queued in the digest; skip the noisy image upload.
    return res.json({ ok: true, action: gateAction, reason: gate.reason, image_skipped: true });
  }
  // NOTE: the gate already posted the text message (that's the dedupe record);
  // now attach the image via the upload flow.

  try {
    const fileData = readFileSync(filepath);
    const fileSize = fileData.length;

    // Step 1: get upload URL
    const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, length: fileSize }),
    }).then(r => r.json());

    if (!urlRes.ok) {
      return res.status(500).json({ error: `getUploadURL failed: ${urlRes.error}` });
    }

    // Step 2: PUT the file. The response used to be discarded entirely, so an
    // expired upload URL or a rejected body carried on to completeUploadExternal
    // and surfaced (if at all) as a confusing "completeUpload failed" — with the
    // real cause a status code nobody had looked at.
    const putRes = await fetch(urlRes.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: fileData,
    });
    if (!putRes.ok) {
      console.error(`[slack] file PUT failed: HTTP ${putRes.status}`);
      return res.status(502).json({ error: `upload PUT failed: HTTP ${putRes.status}`, file_id: urlRes.file_id });
    }

    // Step 3: complete upload, post to channel
    const channel = (SLACK_CHANNEL || '#jarvis').replace(/^#/, '');
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: urlRes.file_id }],
        channel_id: channel,
      }),
    }).then(r => r.json());

    if (!completeRes.ok) {
      console.error('[slack] completeUpload failed:', completeRes.error);
      // HTTP 200 with {ok:false} is the same false-success shape this route was
      // fixed for above: a caller checking the status code was told the visual
      // alert had been posted when it had not.
      return res.status(502).json({ ok: false, error: `completeUpload failed: ${completeRes.error}`, file_id: urlRes.file_id });
    }

    res.json({ ok: true, file_id: urlRes.file_id });
  } catch (e) {
    console.error('[slack] image-alert error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /slack/digest — force-flush the digest (used by cron or manually)
app.post('/slack/digest', async (_req, res) => {
  // Express 4 does not catch a rejected async handler: it becomes an unhandled
  // rejection and the caller waits forever for a response that never comes.
  // flushDigest now propagates a Slack-level rejection (it has to, so the queue
  // survives), which makes that reachable for the first time.
  try {
    const flushed = await notifyCenter.flushDigest({ force: true });
    res.json({ ok: true, flushed: !!flushed });
  } catch (e) {
    console.error('[notify] forced digest flush failed:', e.message);
    res.status(502).json({ ok: false, error: e.message, queued: notifyCenter.digestQueue.length });
  }
});

// GET /slack/notify-status — NotifyCenter state for dashboards/debugging
app.get('/slack/notify-status', (_req, res) => {
  res.json(notifyCenter.status());
});

// POST /slack/events — legacy Slack HTTP Events API fallback
// (Only useful if the server has a public URL configured in the Slack app.)
// With Socket Mode preferred, this endpoint is mostly unused.
app.post('/slack/events', async (req, res) => {
  const { type, challenge, event } = req.body;

  // URL verification handshake
  if (type === 'url_verification') return res.json({ challenge });

  // Ack immediately — Slack requires < 3s response
  res.json({ ok: true });

  if (!event || event.bot_id || event.type !== 'message') return;
  const text = (event.text || '').trim();
  if (!text) return;

  // Same gate as the Socket Mode path — this endpoint is mostly unused, but
  // "mostly" is not a security property.
  const who = checkSender(event.user);
  if (!who.ok) return void rejectSender(event.user, who.reason, text);

  handleCommand(text, event.channel).catch(e =>
    console.error('[slack] HTTP event handler error:', e.message),
  );
});

// GET /slack/test?text=... — dry-run intent detection (no Slack post)
// Exercises the same fast-path/Haiku logic as handleCommand:
// haiku is only invoked (non-null haiku_ms) when the keyword result is not confident.
app.get('/slack/test', async (req, res) => {
  const text = (req.query.text || '').toString();
  if (!text) return res.status(400).json({ error: 'text query param required' });

  const keyword = detectIntent(text, platformNames());
  let haiku = null;
  let haiku_ms = null;
  let chosen = keyword;

  if (!keyword.confident) {
    const t0 = Date.now();
    haiku = await classifyIntent(normalizeText(text));
    haiku_ms = Date.now() - t0;
    if (haiku) chosen = haiku;
  }

  res.json({ text, normalized: normalizeText(text), keyword, haiku, chosen, haiku_ms, platforms: platformNames() });
});

// GET /slack/health
app.get('/slack/health', (req, res) => {
  res.json({
    status: 'ok',
    token_configured: !!SLACK_BOT_TOKEN,
    socket_mode_enabled: !!(SLACK_APP_TOKEN && SLACK_BOT_TOKEN),
    classifier: ANTHROPIC_API_KEY ? 'http-api' : 'cli',
    channel: SLACK_CHANNEL,
    notify: notifyCenter.status(),
  });
});

const PORT = 9203;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-slack] HTTP API on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-slack] Bot token: ${SLACK_BOT_TOKEN ? 'configured ✓' : 'MISSING ✗'}`);
  console.log(`[jarvis-slack] Socket Mode: ${SLACK_APP_TOKEN ? 'ENABLED ✓' : 'disabled (no SLACK_APP_TOKEN)'}`);
  console.log(`[jarvis-slack] Haiku classifier: ${ANTHROPIC_API_KEY ? 'HTTP API (~300ms) ✓' : 'CLI fallback (~3-10s) — add ANTHROPIC_API_KEY to speed up'}`);
  console.log(`[jarvis-slack] Notifications: digest every ${DIGEST_MINUTES}m, max ${MAX_PER_HOUR} immediate/hr, quiet hours ${QUIET_HOURS_RAW}`);
});

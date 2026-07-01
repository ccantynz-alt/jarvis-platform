/**
 * Jarvis Slack Bridge — src/slack-bridge.js
 *
 * Receives commands from #jarvis via Socket Mode (preferred) or HTTP Events.
 * Routes to the orchestrator for dispatching Claude Code agents.
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

// ── Config ──────────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN  = process.env.SLACK_APP_TOKEN; // xapp-... for Socket Mode
const SLACK_CHANNEL    = process.env.JARVIS_SLACK_CHANNEL || '#jarvis';
const ORCHESTRATOR     = 'http://127.0.0.1:9205';
const MEMORY           = 'http://127.0.0.1:9200';
const SCREENSHOT       = 'http://127.0.0.1:9201';
const METRICS          = 'http://127.0.0.1:9202';

// Known live URLs for screenshot — derive from platform name when not listed
const PLATFORM_URLS = {
  zoobicon: 'https://zoobicon.com',
  vapron:   'https://vapron.ai',
  alecrae:  'https://alecrae.com',
  gatetest: 'https://gatetest.ai',
  voxlen:   'https://voxlen.com',
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

/**
 * Fuzzy-match a platform name from free text.
 * Tries word-boundary, substring, then 4-char prefix.
 */
function matchPlatform(text) {
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
 * Classify raw Slack message text into one of:
 *   dispatch | jobs | status | platform-status | briefing | help | passthrough
 */
function detectIntent(raw) {
  // Strip Slack formatting tags, normalise whitespace
  const text = raw.toLowerCase().replace(/<[^>]+>/g, '').trim();

  // "ask jarvis ..." — highest priority, must match before other rules
  if (/^ask\s+(jarvis\s+)?/.test(text)) {
    const question = raw.replace(/<[^>]+>/g, '').replace(/^ask\s+(jarvis\s+)?/i, '').trim();
    return { type: 'ask', question };
  }

  if (/\b(briefing|morning report|daily report|morning|good morning)\b/.test(text)) {
    return { type: 'briefing' };
  }

  if (/\bjobs?\b|\bwhat'?s running\b|\bwhat are you doing\b|\bqueue\b|\brunning tasks?\b/.test(text)) {
    return { type: 'jobs' };
  }

  if (/\b(help|commands?|what can you do)\b/.test(text)) {
    return { type: 'help' };
  }

  const platform = matchPlatform(text);

  // "how is X", "check X", "X status" — explicit status query with platform
  if (platform && /\b(how is|check|status of|health of|what'?s (wrong|up) with|is .* (up|down|working))\b/.test(text)) {
    return { type: 'platform-status', platform };
  }

  // General status — no platform name, just "status" / "health"
  if (!platform && /\b(status|health)\b/.test(text)) {
    return { type: 'status' };
  }

  // Questions (what/how/why/is/are/does/can) → status, never dispatch
  const isQuestion = QUESTION_WORDS.some(w => new RegExp(`^${w}\\b`).test(text));
  if (isQuestion) {
    return platform ? { type: 'platform-status', platform } : { type: 'status' };
  }

  // Dispatch — has a recognised action verb
  const hasVerb = DISPATCH_VERBS.some(v => new RegExp(`\\b${v}\\b`).test(text));
  if (hasVerb) {
    return { type: 'dispatch', platform: platform ?? 'auto' };
  }

  // Platform mentioned without a clear verb → treat as status query
  if (platform) {
    return { type: 'platform-status', platform };
  }

  // Nothing matched → passthrough to orchestrator
  return { type: 'passthrough' };
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

// ── Slack send helper ────────────────────────────────────────────────────────

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

async function handleDispatch(rawText, platform, channel) {
  const task = rawText.replace(/<[^>]+>/g, '').trim();
  let resolvedPlatform = platform;

  if (platform === 'auto') {
    resolvedPlatform = matchPlatform(task);
    if (!resolvedPlatform) {
      const known = platformNames().join(', ');
      return sendSlack(`Which platform? Known: ${known}`, channel);
    }
  }

  await sendSlack(
    `🤖 Dispatching to *${resolvedPlatform}*...\nTask: _${task.slice(0, 200)}_`,
    channel,
  );

  try {
    const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: resolvedPlatform, task }),
    });
    const data = await r.json();

    if (data.error) {
      const known = data.known?.length ? `\nKnown platforms: ${data.known.join(', ')}` : '';
      await sendSlack(`❌ Dispatch failed: ${data.error}${known}`, channel);
    } else {
      await sendSlack(
        `✅ Job started — ID: \`${data.jobId}\`\nPlatform: *${resolvedPlatform}* | Claude agent is running...`,
        channel,
      );
    }
  } catch (e) {
    await sendSlack(`❌ Orchestrator unreachable: ${e.message}`, channel);
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
    `• \`fix zoobicon dashboard\` — dispatch a task to a platform\n` +
    `• \`upgrade vapron login flow\` — same, different verb\n` +
    `• \`jobs\` or \`what's running\` — show job queue\n` +
    `• \`status\` — server metrics + all platform health\n` +
    `• \`how is zoobicon\` — platform memory state + screenshot\n` +
    `• \`check vapron\` — same\n` +
    `• \`briefing\` or \`morning\` — full morning summary\n` +
    `• _anything else_ — passed through to orchestrator as a task\n\n` +
    `Platforms: ${platforms}`;
  return sendSlack(msg, channel);
}

/**
 * Unified entry point — called from both Socket Mode listener and HTTP events.
 * Returns immediately after dispatching (fire-and-forget for slow operations).
 */
async function handleCommand(rawText, channel) {
  const intent = detectIntent(rawText);
  console.log(`[slack] intent=${JSON.stringify(intent)} text="${rawText.replace(/<[^>]+>/g, '').slice(0, 60)}"`);

  switch (intent.type) {
    case 'ask':            return handleAsk(intent.question, channel);
    case 'dispatch':       return handleDispatch(rawText, intent.platform, channel);
    case 'jobs':           return handleJobs(channel);
    case 'status':         return handleStatus(channel);
    case 'platform-status':return handlePlatformStatus(intent.platform, channel);
    case 'briefing':       return handleBriefing(channel);
    case 'help':           return handleHelp(channel);
    case 'passthrough':
    default:               return handleDispatch(rawText, 'auto', channel);
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

const app = express();
app.use(express.json());

// POST /slack/send — generic message from any Jarvis service
app.post('/slack/send', async (req, res) => {
  const { text, channel } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const result = await sendSlack(text, channel);
  res.json(result);
});

// POST /slack/report — structured audit report
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

  const result = await sendSlack(text);
  res.json(result);
});

// POST /slack/alert — urgent platform alert
app.post('/slack/alert', async (req, res) => {
  const { platform, message, level = 'warning' } = req.body;
  const emoji = level === 'critical' ? '🚨' : '⚠️';
  const text  = `${emoji} *JARVIS ALERT — ${(platform || '').toUpperCase()}*\n${message}`;
  const result = await sendSlack(text);
  res.json(result);
});

// POST /slack/image-alert — upload an image file to Slack and post with a message
// Uses Slack's current upload flow: getUploadURLExternal → PUT → completeUploadExternal
app.post('/slack/image-alert', async (req, res) => {
  const { platform, message, filepath, filename } = req.body;
  if (!filepath || !filename) return res.status(400).json({ error: 'filepath and filename required' });
  if (!existsSync(filepath)) return res.status(400).json({ error: `File not found: ${filepath}` });
  if (!SLACK_BOT_TOKEN) return res.status(503).json({ error: 'no_token' });

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

    // Step 2: PUT the file
    await fetch(urlRes.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: fileData,
    });

    // Step 3: complete upload, post to channel
    const channel = (SLACK_CHANNEL || '#jarvis').replace(/^#/, '');
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ id: urlRes.file_id }],
        channel_id: channel,
        initial_comment: message || `📸 Screenshot from *${platform || 'unknown'}*`,
      }),
    }).then(r => r.json());

    if (!completeRes.ok) {
      console.error('[slack] completeUpload failed:', completeRes.error);
      // Fall back to text-only alert
      await sendSlack(`${message || '📸 Screenshot'} _(image upload failed: ${completeRes.error})_`);
    }

    res.json({ ok: completeRes.ok, file_id: urlRes.file_id });
  } catch (e) {
    console.error('[slack] image-alert error:', e.message);
    await sendSlack(`📸 Visual regression detected on *${platform}* — image upload failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
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

  handleCommand(text, event.channel).catch(e =>
    console.error('[slack] HTTP event handler error:', e.message),
  );
});

// GET /slack/test?text=... — dry-run intent detection (no Slack post)
app.get('/slack/test', (req, res) => {
  const text = (req.query.text || '').toString();
  if (!text) return res.status(400).json({ error: 'text query param required' });
  const intent = detectIntent(text);
  res.json({ text, intent, platforms: platformNames() });
});

// GET /slack/health
app.get('/slack/health', (req, res) => {
  res.json({
    status: 'ok',
    token_configured: !!SLACK_BOT_TOKEN,
    socket_mode_enabled: !!(SLACK_APP_TOKEN && SLACK_BOT_TOKEN),
    channel: SLACK_CHANNEL,
  });
});

const PORT = 9203;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-slack] HTTP API on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-slack] Bot token: ${SLACK_BOT_TOKEN ? 'configured ✓' : 'MISSING ✗'}`);
  console.log(`[jarvis-slack] Socket Mode: ${SLACK_APP_TOKEN ? 'ENABLED ✓' : 'disabled (no SLACK_APP_TOKEN)'}`);
});

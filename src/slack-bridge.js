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
import {
  detectIntent,
  classifyIntent,
  resolveIntent,
  runIntent,
  platformNames,
} from './lib/conversation.js';

// ── Config ──────────────────────────────────────────────────────────────────

const SLACK_BOT_TOKEN  = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN  = process.env.SLACK_APP_TOKEN; // xapp-... for Socket Mode
const SLACK_CHANNEL    = process.env.JARVIS_SLACK_CHANNEL || '#jarvis';

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

/**
 * Unified entry point — called from both Socket Mode listener and HTTP events.
 * Intent resolution + handlers come from lib/conversation.js; this wrapper
 * only maps {text} results (and interim onEvent messages) to Slack posts.
 */
async function handleCommand(rawText, channel) {
  const { intent, via, ms } = await resolveIntent(rawText);

  console.log(`[slack] intent via ${via} (${ms}ms)`);
  console.log(`[slack] intent=${JSON.stringify(intent)} text="${rawText.replace(/<[^>]+>/g, '').slice(0, 60)}"`);

  const result = await runIntent(intent, rawText, (m) => sendSlack(m.text, channel));
  if (result?.text) return sendSlack(result.text, channel);
  return result;
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
// Exercises the same fast-path/Haiku logic as handleCommand:
// haiku is only invoked (non-null haiku_ms) when the keyword result is not confident.
app.get('/slack/test', async (req, res) => {
  const text = (req.query.text || '').toString();
  if (!text) return res.status(400).json({ error: 'text query param required' });

  const keyword = detectIntent(text);
  let haiku = null;
  let haiku_ms = null;
  let chosen = keyword;

  if (!keyword.confident) {
    const t0 = Date.now();
    haiku = await classifyIntent(text);
    haiku_ms = Date.now() - t0;
    if (haiku) chosen = haiku;
  }

  res.json({ text, keyword, haiku, chosen, haiku_ms, platforms: platformNames() });
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

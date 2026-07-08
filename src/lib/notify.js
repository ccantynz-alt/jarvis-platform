/**
 * Jarvis notification fan-out — src/lib/notify.js (see docs/GATEWAY.md)
 *
 * Order matters:
 *   1. jarvis-memory (:9200) — DURABLE inbox write; never skipped. This is the
 *      source of truth for missed notifications.
 *   2. jarvis-gateway (:9208) /internal/notify — best-effort live push to
 *      connected devices (renders + optionally speaks).
 *   3. jarvis-slack (:9203) — ONLY while NOTIFY_SLACK_LEGACY=1 (secrets.env).
 *      Flip to 0 to start Slack retirement; delete this branch when the bridge
 *      is removed.
 *
 * All failures are logged and swallowed — notification plumbing must never
 * take down a caller (matches the old slackSend behavior).
 */

const MEMORY  = 'http://127.0.0.1:9200';
const GATEWAY = 'http://127.0.0.1:9208';
const SLACK   = 'http://127.0.0.1:9203';

async function post(url, payload, label) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) console.warn(`[notify] ${label} responded ${r.status}`);
    return r.ok;
  } catch (e) {
    console.warn(`[notify] ${label} failed: ${e.message}`);
    return false;
  }
}

/**
 * notify({ source, level, title, body, speech })
 *   source — which subsystem raised it (e.g. 'orchestrator-cron', 'fleet-check')
 *   level  — 'info' | 'warn' | 'alert'
 *   title  — short headline (required)
 *   body   — full text (defaults to title)
 *   speech — short spoken form for TTS (defaults to title)
 */
export async function notify({ source = 'jarvis', level = 'info', title, body, speech }) {
  if (!title) return { ok: false, error: 'title required' };
  body = body ?? title;
  speech = speech ?? title;

  const stored = await post(`${MEMORY}/memory/notifications`,
    { source, level, title, body, speech }, 'memory');

  await post(`${GATEWAY}/internal/notify`,
    { source, level, title, body, speech }, 'gateway');

  if (process.env.NOTIFY_SLACK_LEGACY === '1') {
    await post(`${SLACK}/slack/send`, { text: body }, 'slack-legacy');
  }

  return { ok: stored };
}

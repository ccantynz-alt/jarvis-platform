/**
 * Jarvis notification fan-out — src/lib/notify.js (see docs/GATEWAY.md)
 *
 * Order matters:
 *   1. jarvis-memory (:9200) — DURABLE inbox write; never skipped. This is the
 *      source of truth for missed notifications. Its assigned row id is
 *      threaded through to steps 2/3 below so each live-push target can
 *      dedupe against its own later poll of the same memory table.
 *   2. jarvis-gateway (:9208) /internal/notify — best-effort live push to
 *      connected devices (renders + optionally speaks).
 *   3. jarvis-deck (:9210) /internal/notify — same live push, for the
 *      Command Deck. Added 2026-07-21: the Deck previously had NO push path
 *      at all and only found out via its own 5s poll of memory — instant
 *      for the Gateway, laggy for the actual UI Craig watches, for no
 *      reason other than the two servers never having been wired together.
 *   4. jarvis-slack (:9203) — ONLY while NOTIFY_SLACK_LEGACY=1 (secrets.env).
 *      Flip to 0 to start Slack retirement; delete this branch when the bridge
 *      is removed.
 *   5. lib/push.js — device push (ntfy), warn/alert by default. Added
 *      2026-07-30: EVERY step above needs something of Craig's to be open or
 *      polling. Steps 2 and 3 reach connected tabs; step 1 waits to be read.
 *      Close the laptop and walk out — the exact moment an alert matters — and
 *      nothing reached him at all. This is the step that survives that.
 *
 * All failures are logged and swallowed — notification plumbing must never
 * take down a caller (matches the old slackSend behavior).
 */

import { pushAlert } from './push.js';

const MEMORY  = 'http://127.0.0.1:9200';
const GATEWAY = 'http://127.0.0.1:9208';
const DECK    = 'http://127.0.0.1:9210';
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
    return r.ok ? r : null;
  } catch (e) {
    console.warn(`[notify] ${label} failed: ${e.message}`);
    return null;
  }
}

// Level synonyms, normalised at the ONE entry point.
//
// Found by the code-health spine's first-ever sweep (2026-07-30, and the defect
// was 40 minutes old): orchestrator.js and agent-scheduler.js both raise
// `level: 'error'`, which is not in this function's contract. Every consumer
// then guessed differently — and lib/push.js, being the newest, treated an
// unrecognised level as 'info', which is below its default threshold. So "job
// failed" and "could not dispatch an agent" were the exact notifications that
// silently never reached his phone. A contract that is only written in a comment
// is a contract that drifts; this enforces it in one place, out loud.
const LEVEL_SYNONYMS = {
  error: 'alert', critical: 'alert', fatal: 'alert', emergency: 'alert', alert: 'alert',
  warning: 'warn', warn: 'warn',
  info: 'info', notice: 'info', debug: 'info',
};
const warnedLevels = new Set();

export function normalizeLevel(level) {
  const key = String(level ?? '').trim().toLowerCase();
  const mapped = LEVEL_SYNONYMS[key];
  if (mapped) return mapped;
  // Unknown levels resolve UP, not down: a caller that invented a level was
  // trying to say something, and swallowing it is the failure mode above.
  if (!warnedLevels.has(key)) {
    warnedLevels.add(key);
    console.warn(`[notify] unknown level ${JSON.stringify(level)} — treating it as 'warn' (contract: info|warn|alert)`);
  }
  return 'warn';
}

/**
 * notify({ source, level, title, body, speech })
 *   source — which subsystem raised it (e.g. 'orchestrator-cron', 'fleet-check')
 *   level  — 'info' | 'warn' | 'alert' (synonyms like 'error'/'critical' are
 *            normalised; see LEVEL_SYNONYMS above for why that matters)
 *   title  — short headline (required)
 *   body   — full text (defaults to title)
 *   speech — short spoken form for TTS (defaults to title)
 */
export async function notify({ source = 'jarvis', level = 'info', title, body, speech }) {
  if (!title) return { ok: false, error: 'title required' };
  body = body ?? title;
  speech = speech ?? title;
  level = normalizeLevel(level);

  const memRes = await post(`${MEMORY}/memory/notifications`,
    { source, level, title, body, speech }, 'memory');
  let id;
  try { id = memRes && (await memRes.json())?.id; } catch { /* best-effort */ }

  await post(`${GATEWAY}/internal/notify`,
    { id, source, level, title, body, speech }, 'gateway');

  await post(`${DECK}/internal/notify`,
    { id, source, level, title, body, speech }, 'deck');

  if (process.env.NOTIFY_SLACK_LEGACY === '1') {
    await post(`${SLACK}/slack/send`, { text: body }, 'slack-legacy');
  }

  // Off-device push last, so a slow relay can never delay the in-house paths.
  const pushed = await pushAlert({ level, title, body, source });

  return { ok: !!memRes, pushed: pushed.sent, pushReason: pushed.reason };
}

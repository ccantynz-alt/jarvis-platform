/**
 * Mail watch — src/mail-watch.js (oneshot, jarvis-mail-watch.timer, 5 min)
 *
 * Keeps Marco's standing copy of Craig's email (marco@alecrae.com) under
 * full-time watch. Reads the mailbox through the AlecRae product API with
 * the scoped ALECRAE_MARCO_API_KEY — the supported surface, never the
 * co-tenant's DB — diffs against a durable KV cursor, and files AT MOST ONE
 * 'info' inbox row per tick (lib/mail-watch.js carries the flood doctrine
 * and its tests). The brain reads mail on demand via the check_mail tool;
 * replying stays deliberate: Marco replies only when Craig asks (2026-08-25).
 *
 * Read-only against the mail store. Repairs nothing, sends nothing.
 */

import { appendFileSync } from 'fs';
import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import { planMailTick } from './lib/mail-watch.js';
import { installInternalAuth } from './lib/internal-http.js';
installInternalAuth();

const MEMORY = 'http://127.0.0.1:9200';
const ALECRAE = process.env.ALECRAE_API_URL || 'http://127.0.0.1:4100';
const KEY = process.env.ALECRAE_MARCO_API_KEY || '';
const MAILBOX = process.env.MAILWATCH_MAILBOX || 'marco@alecrae.com';
const MODE = process.env.MAILWATCH_MODE || 'live';     // off | live
const FETCH_LIMIT = guardrail('MAILWATCH_FETCH_LIMIT', 50, { source: 'mail-watch' });
const LOG = '/var/log/jarvis-mail-watch.log';
const CURSOR_KEY = 'mail-watch-cursor';
const DOWN_MARKER_KEY = 'mail-watch-degraded';         // announce-on-change, not per-tick

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG, line); } catch { /* journald still has stdout */ }
  process.stdout.write(line);
}

const jget = (url, headers = {}, ms = 10_000) =>
  fetch(url, { headers, signal: AbortSignal.timeout(ms) })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));

// KV values are STRINGS by contract (see experience-check.js) — callers
// stringify on write and parse on read. Passing an object here coerces to
// "[object Object]" and silently destroys the cursor (caught on the very
// first deploy tick, 2026-08-24).
const kvGet = (key) => jget(`${MEMORY}/memory/kv/${key}`)
  .then(r => { try { return JSON.parse(r?.value ?? 'null'); } catch { return null; } })
  .catch(() => null);
const kvSet = (key, value) => fetch(`${MEMORY}/memory/kv`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ key, value: JSON.stringify(value) }),
}).catch(() => null);

// A watcher that cannot see the mailbox must say so ONCE (fail loud), then
// hold its tongue until recovery — a 5-min timer that warns per-tick is the
// alert flood with a new name.
async function degraded(reason) {
  const prev = await kvGet(DOWN_MARKER_KEY);
  if (!prev) {
    await kvSet(DOWN_MARKER_KEY, { since: new Date().toISOString(), reason });
    await notify({
      source: 'mail-watch', level: 'warn',
      title: 'Mail watch cannot read marco@alecrae.com',
      body: `${reason} — Marco is blind to incoming email until this recovers. Will announce once on recovery, not per tick.`,
    });
  }
  log(`degraded: ${reason}`);
}

async function recovered() {
  const prev = await kvGet(DOWN_MARKER_KEY);
  if (prev) {
    await kvSet(DOWN_MARKER_KEY, null);
    await notify({
      source: 'mail-watch', level: 'info',
      title: 'Mail watch recovered',
      body: `Reading marco@alecrae.com again (had been degraded since ${prev.since}: ${prev.reason}).`,
    });
  }
}

async function main() {
  if (MODE === 'off') { log('MAILWATCH_MODE=off — skipping'); return; }
  if (!KEY) { await degraded('ALECRAE_MARCO_API_KEY is not set in secrets.env'); return; }
  const auth = { Authorization: `Bearer ${KEY}` };

  // Resolve the mailbox id by address each tick — survives re-provisioning.
  let mailboxId;
  try {
    const boxes = await jget(`${ALECRAE}/v1/mailboxes`, auth);
    const rows = Array.isArray(boxes) ? boxes : boxes?.data || [];
    mailboxId = rows.find(b => (b.address || '').toLowerCase() === MAILBOX.toLowerCase())?.id;
    if (!mailboxId) { await degraded(`no mailbox ${MAILBOX} on the account`); return; }
  } catch (e) { await degraded(`mailbox list failed: ${e.message}`); return; }

  let messages;
  try {
    const r = await jget(`${ALECRAE}/v1/messages?mailboxId=${mailboxId}&limit=${FETCH_LIMIT}`, auth);
    messages = r?.data || [];
  } catch (e) { await degraded(`message list failed: ${e.message}`); return; }

  await recovered();

  const cursor = await kvGet(CURSOR_KEY);
  const { newMessages, nextCursor, notification } = planMailTick({ messages, cursor });

  // Cursor first: if notify fails we drop one digest, never re-announce.
  await kvSet(CURSOR_KEY, nextCursor);

  if (notification) {
    await notify({ source: 'mail-watch', ...notification });
    log(`${newMessages.length} new message(s) → inbox digest filed`);
  } else {
    log(`quiet tick (${messages.length} on file, cursor ${nextCursor.lastSeenAt || 'baselined'})`);
  }
}

main().catch(async (e) => {
  log(`tick failed: ${e.message}`);
  await degraded(`tick failed: ${e.message}`);
  process.exitCode = 1;
});

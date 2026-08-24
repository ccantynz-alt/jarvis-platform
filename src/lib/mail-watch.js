/**
 * Mail-watch pure logic — src/lib/mail-watch.js
 *
 * marco@alecrae.com is Marco's standing copy of Craig's email (created
 * 2026-08-22; Craig 2026-08-25: "so marco has a copy of the emails at all
 * times — he won't need to reply unless I ask him to"). The mail already
 * lives on this box as rows in the AlecRae store, read through the product
 * API with the scoped ALECRAE_MARCO_API_KEY — so "full-time monitoring" is
 * a cursor over that mailbox, not IMAP polling.
 *
 * Flood doctrine (the 235-alerts-in-48h lesson, and jarvis-experience's
 * rule): a timer must never be able to buzz Craig's phone per-event. One
 * tick emits AT MOST ONE inbox row, at 'info' — visible to the brain via
 * get_inbox and on the deck's OPS tab, never a push. The first tick ever
 * BASELINES silently: announcing a whole backlog as "new mail" would be
 * the flood wearing a different hat.
 */

/** Bound on ids remembered at the cursor timestamp — ties in createdAt are
 *  rare (same-second deliveries), so a small window is plenty. */
const MAX_SEEN_IDS = 50;

/**
 * Decide what one tick does.
 *
 * @param {object} args
 * @param {Array<{id: string, createdAt: string, from?: {email?: string, name?: string},
 *                subject?: string, preview?: string}>} args.messages
 *        Newest-first page from GET /v1/messages (the API's order).
 * @param {{ lastSeenAt: string|null, seenIds: string[] }|null} args.cursor
 *        Durable cursor from KV; null/malformed = first run.
 * @param {number} [args.maxList=10] Max messages itemised in the inbox row.
 * @returns {{ newMessages: object[], nextCursor: object, notification: object|null }}
 */
export function planMailTick({ messages, cursor, maxList = 10 }) {
  const list = Array.isArray(messages) ? messages.filter(m => m && m.id && m.createdAt) : [];
  const cur = normalizeCursor(cursor);

  // First run: baseline without announcing. The backlog is not "new".
  const firstRun = cur.lastSeenAt === null;

  const fresh = firstRun ? [] : list.filter(m => {
    if (m.createdAt > cur.lastSeenAt) return true;
    if (m.createdAt === cur.lastSeenAt && !cur.seenIds.includes(m.id)) return true;
    return false;
  });

  // Advance the cursor to the newest message we can see — never backwards,
  // so a short/failed page can only delay news, not repeat it.
  let lastSeenAt = cur.lastSeenAt;
  for (const m of list) if (lastSeenAt === null || m.createdAt > lastSeenAt) lastSeenAt = m.createdAt;
  const seenIds = lastSeenAt === null ? [] : dedupe([
    ...list.filter(m => m.createdAt === lastSeenAt).map(m => m.id),
    ...(lastSeenAt === cur.lastSeenAt ? cur.seenIds : []),
  ]).slice(0, MAX_SEEN_IDS);

  const notification = fresh.length === 0 ? null : {
    level: 'info',
    title: `📧 ${fresh.length} new email${fresh.length === 1 ? '' : 's'} in marco@alecrae.com`,
    body: fresh.slice(0, maxList).map(line).join('\n')
      + (fresh.length > maxList ? `\n…and ${fresh.length - maxList} more` : ''),
  };

  return { newMessages: fresh, nextCursor: { lastSeenAt, seenIds }, notification };
}

function normalizeCursor(cursor) {
  if (!cursor || typeof cursor.lastSeenAt !== 'string' || !cursor.lastSeenAt) {
    return { lastSeenAt: null, seenIds: [] };
  }
  return {
    lastSeenAt: cursor.lastSeenAt,
    seenIds: Array.isArray(cursor.seenIds) ? cursor.seenIds.filter(x => typeof x === 'string') : [],
  };
}

function dedupe(xs) { return [...new Set(xs)]; }

function line(m) {
  const from = m.from?.name || m.from?.email || 'unknown sender';
  const subject = (m.subject || '(no subject)').slice(0, 90);
  return `• ${from} — ${subject}`;
}

/** One readable line per message for the check_mail brain tool. */
export function formatMailLine(m, { tz = 'Pacific/Auckland' } = {}) {
  const when = new Date(m.createdAt).toLocaleString('en-NZ', {
    timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const from = m.from?.name ? `${m.from.name} <${m.from.email || '?'}>` : (m.from?.email || 'unknown');
  return `[${when}] ${from} — ${m.subject || '(no subject)'}${m.id ? `  (id ${m.id})` : ''}`;
}

/** Case-insensitive subject/from filter for check_mail's query argument. */
export function filterMail(messages, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return messages;
  return messages.filter(m =>
    (m.subject || '').toLowerCase().includes(q) ||
    (m.from?.email || '').toLowerCase().includes(q) ||
    (m.from?.name || '').toLowerCase().includes(q) ||
    (m.preview || '').toLowerCase().includes(q));
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMailTick, filterMail, formatMailLine } from '../src/lib/mail-watch.js';

const msg = (id, createdAt, subject = 's', from = { email: 'a@b.c' }) =>
  ({ id, createdAt, subject, from, preview: '' });

test('first run baselines silently — a backlog is not "new mail"', () => {
  // The 235-alerts lesson in miniature: the very first tick sees every message
  // ever received. Announcing them would flood the inbox with history.
  const r = planMailTick({
    messages: [msg('b', '2026-08-25T02:00:00Z'), msg('a', '2026-08-25T01:00:00Z')],
    cursor: null,
  });
  assert.equal(r.notification, null);
  assert.equal(r.newMessages.length, 0);
  assert.equal(r.nextCursor.lastSeenAt, '2026-08-25T02:00:00Z');
  assert.deepEqual(r.nextCursor.seenIds, ['b']);
});

test('a genuinely new message produces exactly one info row', () => {
  const cursor = { lastSeenAt: '2026-08-25T02:00:00Z', seenIds: ['b'] };
  const r = planMailTick({
    messages: [msg('c', '2026-08-25T03:00:00Z', 'Invoice'), msg('b', '2026-08-25T02:00:00Z')],
    cursor,
  });
  assert.equal(r.newMessages.length, 1);
  assert.equal(r.notification.level, 'info');   // never warn/alert from a timer tick
  assert.match(r.notification.title, /1 new email/);
  assert.match(r.notification.body, /Invoice/);
  assert.equal(r.nextCursor.lastSeenAt, '2026-08-25T03:00:00Z');
});

test('same-timestamp tie: unseen id at the cursor instant still counts as new', () => {
  const t = '2026-08-25T02:00:00Z';
  const cursor = { lastSeenAt: t, seenIds: ['b'] };
  const r = planMailTick({ messages: [msg('c', t), msg('b', t)], cursor });
  assert.deepEqual(r.newMessages.map(m => m.id), ['c']);
  assert.ok(r.nextCursor.seenIds.includes('b') && r.nextCursor.seenIds.includes('c'));
});

test('quiet tick: nothing new → no notification, cursor unchanged', () => {
  const cursor = { lastSeenAt: '2026-08-25T02:00:00Z', seenIds: ['b'] };
  const r = planMailTick({ messages: [msg('b', '2026-08-25T02:00:00Z')], cursor });
  assert.equal(r.notification, null);
  assert.deepEqual(r.nextCursor, cursor);
});

test('cursor never moves backwards on a short or empty page', () => {
  // A failed/partial API page must delay news, never repeat it.
  const cursor = { lastSeenAt: '2026-08-25T02:00:00Z', seenIds: ['b'] };
  const r = planMailTick({ messages: [], cursor });
  assert.equal(r.nextCursor.lastSeenAt, '2026-08-25T02:00:00Z');
  assert.equal(r.notification, null);
});

test('a burst is one batched row with a +more line, not N rows', () => {
  const cursor = { lastSeenAt: '2026-08-25T00:00:00Z', seenIds: [] };
  const messages = Array.from({ length: 15 }, (_, i) =>
    msg(`m${i}`, `2026-08-25T01:00:${String(i).padStart(2, '0')}Z`, `subject ${i}`));
  const r = planMailTick({ messages, cursor, maxList: 10 });
  assert.equal(r.newMessages.length, 15);
  assert.match(r.notification.title, /15 new emails/);
  assert.match(r.notification.body, /…and 5 more/);
  assert.equal(r.notification.body.split('\n').length, 11);   // 10 lines + the more-line
});

test('malformed cursor is treated as first run, not a crash', () => {
  const r = planMailTick({ messages: [msg('a', '2026-08-25T01:00:00Z')], cursor: { junk: true } });
  assert.equal(r.notification, null);
  assert.equal(r.nextCursor.lastSeenAt, '2026-08-25T01:00:00Z');
});

test('filterMail matches subject, sender and preview, case-insensitively', () => {
  const ms = [
    { id: '1', createdAt: 'x', subject: 'Invoice #42', from: { email: 'billing@stripe.com' }, preview: '' },
    { id: '2', createdAt: 'x', subject: 'hello', from: { email: 'a@b.c', name: 'Dave Smith' }, preview: 'about the invoice' },
    { id: '3', createdAt: 'x', subject: 'other', from: { email: 'a@b.c' }, preview: '' },
  ];
  assert.deepEqual(filterMail(ms, 'INVOICE').map(m => m.id), ['1', '2']);
  assert.deepEqual(filterMail(ms, 'dave').map(m => m.id), ['2']);
  assert.equal(filterMail(ms, '').length, 3);
});

test('formatMailLine carries sender, subject and the id needed to read it', () => {
  const s = formatMailLine({ id: 'abc', createdAt: '2026-08-25T01:00:00Z', subject: 'Hi', from: { email: 'x@y.z' } });
  assert.match(s, /x@y\.z/);
  assert.match(s, /Hi/);
  assert.match(s, /id abc/);
});

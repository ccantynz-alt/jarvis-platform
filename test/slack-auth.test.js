// test/slack-auth.test.js — who may command Jarvis from Slack, 2026-07-30.
//
// Found by the code-health spine on the auth-session lens. The Slack entry points
// checked only `bot_id` and `subtype`, so ANY member of the workspace — including
// by DM to the bot — could send one message and have it routed. And unlike the
// deck and the gateway, the Slack dispatch path has NO confirmation gate:
// handleDispatch POSTs straight to /dispatch, which spawns a full-permission
// agent as root. One message from anyone was one root agent. `mute all` was
// equally reachable.
//
// It had only been unexploitable by accident: every Slack message threw
// ReferenceError on an undeclared identifier before reaching the intent switch,
// from 2026-07-08 until that was fixed the same morning — so the fix turned a
// dead path into a live one.
//
// Hence: FAIL CLOSED, and tested.

import test from 'node:test';
import assert from 'node:assert/strict';
import { senderAllowed, parseAllowlist } from '../src/lib/slack-auth.js';

test('no allowlist configured authorises NOBODY', () => {
  for (const raw of [undefined, null, '', '   ', ',', ' , ,']) {
    const r = senderAllowed('U123', raw);
    assert.equal(r.ok, false, JSON.stringify(raw));
    assert.equal(r.reason, 'no-allowlist');
  }
});

test('an allowlisted user is authorised', () => {
  assert.deepEqual(senderAllowed('UCRAIG', 'UCRAIG'), { ok: true });
  assert.deepEqual(senderAllowed('UCRAIG', 'UOTHER,UCRAIG'), { ok: true });
  assert.deepEqual(senderAllowed('UCRAIG', ' UOTHER , UCRAIG , '), { ok: true });
});

test('anyone else in the workspace is refused', () => {
  const r = senderAllowed('UINTRUDER', 'UCRAIG');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-allowlisted');
});

test('a message with no user id is refused — it is not Craig', () => {
  for (const id of [undefined, null, '', 0, {}, []]) {
    const r = senderAllowed(id, 'UCRAIG');
    assert.equal(r.ok, false, JSON.stringify(id));
    assert.equal(r.reason, 'no-user-id');
  }
});

test('matching is exact — no prefixes, no case-folding', () => {
  assert.equal(senderAllowed('UCRAIG2', 'UCRAIG').ok, false, 'a longer id must not match');
  assert.equal(senderAllowed('ucraig', 'UCRAIG').ok, false, 'Slack ids are case-sensitive');
  assert.equal(senderAllowed('UCRAI', 'UCRAIG').ok, false, 'a prefix must not match');
});

test('parseAllowlist tolerates the way people actually write env vars', () => {
  assert.deepEqual(parseAllowlist('U1,U2'), ['U1', 'U2']);
  assert.deepEqual(parseAllowlist(' U1 , U2 ,'), ['U1', 'U2']);
  assert.deepEqual(parseAllowlist(''), []);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test('an array allowlist is accepted as-is', () => {
  assert.deepEqual(senderAllowed('U1', ['U1', 'U2']), { ok: true });
  assert.equal(senderAllowed('U3', ['U1', 'U2']).ok, false);
});

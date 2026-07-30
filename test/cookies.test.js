// test/cookies.test.js — the cookie parser must never throw, 2026-07-30.
//
// Three byte-identical copies of parseCookies (deck, gateway, dashboard) called
// decodeURIComponent unguarded. `decodeURIComponent('%')` throws URIError.
//
// On an express route that is survivable — express catches it and returns 500.
// The WebSocket upgrade path is raw Node: an exception inside the 'upgrade' event
// emit is an uncaughtException and TERMINATES THE PROCESS. And the parse happens
// before the token is compared, so no credential is needed: `Cookie: a=%` on an
// upgrade request killed jarvis-deck. Reachable by accident too —
// `document.cookie = 'x=%'` is legal and the deck client auto-reconnects, so one
// bad cookie in Craig's own browser would crash-loop the service he is watching.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCookies } from '../src/lib/cookies.js';

test('a bare percent no longer throws — THE crash', () => {
  // Proof the hazard is real, first.
  assert.throws(() => decodeURIComponent('%'), { name: 'URIError' });
  assert.doesNotThrow(() => parseCookies('a=%'));
  assert.deepEqual(parseCookies('a=%'), { a: '%' }, 'kept raw — it cannot match a token either way');
});

test('every malformed encoding a client might send is survivable', () => {
  for (const header of ['a=%', 'a=%zz', 'a=%e0%a4%a', 'a=100%', 'x=%C0%80', 'a=%%%', 'jarvis_deck_auth=%']) {
    assert.doesNotThrow(() => parseCookies(header), header);
  }
});

test('well-formed cookies still decode', () => {
  assert.deepEqual(parseCookies('name=hello%20world'), { name: 'hello world' });
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(' a = 1 ; b = 2 '), { a: '1', b: '2' });
});

test('a good cookie beside a broken one still parses', () => {
  // The realistic case: an auth cookie plus junk from some other tool.
  assert.deepEqual(parseCookies('junk=%; jarvis_deck_auth=abc123'), { junk: '%', jarvis_deck_auth: 'abc123' });
});

test('absent, empty and shapeless headers yield an empty object', () => {
  for (const header of [undefined, null, '', '   ', ';;;', 'novalue', '=novalue']) {
    assert.deepEqual(parseCookies(header), {}, JSON.stringify(header));
  }
});

test('a value containing = survives intact', () => {
  assert.deepEqual(parseCookies('token=abc=def=='), { token: 'abc=def==' });
});

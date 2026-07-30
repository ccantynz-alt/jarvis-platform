// The Command Deck's echo filter, extracted from the shipped HTML and run.
//
// This is the surface Craig actually uses (:8444). The filter here had the
// same defects the Gateway's did, plus one of its own: it returned TRUE — echo,
// discard — whenever every heard word was three letters or shorter. So "yes",
// "no" and "do it" were thrown away while Jarvis was mid-reply.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// CRLF-normalised: see the note in deck-boot-speech.test.js — a Windows
// checkout gives \r\n, and `.` never matches \r.
const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const m = html.match(/const isEcho = \(\(\) => \{[\s\S]*?\n {4}\}\)\(\);/);
assert.ok(m, 'could not find isEcho in command-deck.html — did the voice section move?');

// Rebuild the closure it reads from: the live stream element and the
// latest-reply panel are the "what Jarvis is saying right now" source.
const makeGuard = new Function('said', 'onScreen', `
  const streamEl = { textContent: onScreen };
  const $ = () => ({ textContent: '' });
  ${m[0]}
  return isEcho;
`);
const guard = (said, onScreen) => makeGuard(said, onScreen);

const REPLY = 'The Vapron deployment finished cleanly, sir, and the health score is back to ' +
  'ninety four. I have also restarted the gateway and the deck.';

test('a contiguous run of his own reply is caught', () => {
  assert.equal(guard('I have also restarted the gateway and the deck', REPLY), true);
});

test('the tail of his reply is caught', () => {
  assert.equal(guard('restarted the gateway and the deck', REPLY), true);
});

test('short commands are NEVER swallowed', () => {
  // The old filter returned true outright when every word was <= 3 letters.
  for (const said of ['yes', 'no', 'do it', 'stop', 'yes do it', 'and the rest']) {
    assert.equal(guard(said, REPLY), false, said);
  }
});

test('substring collisions do not count — "rest" is not "restarted"', () => {
  assert.equal(guard('and the rest of the score', REPLY), false);
});

test('his vocabulary in a different order is not an echo', () => {
  assert.equal(guard('deck gateway restarted the have I also', REPLY), false);
});

test('genuine speech fused with echo still gets through', () => {
  assert.equal(
    guard('and the deck but I want Zoobicon looked at first before anything else ships', REPLY),
    false,
  );
});

test('nothing on screen means nothing can be an echo', () => {
  assert.equal(guard('I have also restarted the gateway and the deck', ''), false);
});

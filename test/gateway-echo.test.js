// The Gateway's echo guard, tested against the code that actually ships.
//
// public/gateway.html is a standalone page with no build step, so there is
// nothing to import. Rather than copy the heuristic into the test (which would
// verify nothing — the copy could drift from the page the moment someone edits
// it), this extracts isSelfEcho straight out of the served HTML and runs it.
//
// What's being protected, in both directions:
//   - Jarvis's own words off the speaker tail must NEVER reach the brain;
//     that is the loop Craig hit.
//   - Craig's real speech must get through even when it arrives FUSED with
//     some echo. The 2026-07-26 transcript shows a 60% filter binning a whole
//     utterance and discarding his actual opinion. That failure is worse than
//     letting a bit of echo through, so the bar here is deliberately high.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// CRLF-normalised: see the note in deck-boot-speech.test.js — a Windows
// checkout gives \r\n, and `.` never matches \r.
const html = readFileSync(new URL('../public/gateway.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

function extract(re, label) {
  const m = html.match(re);
  assert.ok(m, `could not find ${label} in gateway.html — did the voice section move?`);
  return m[0];
}

const src = [
  extract(/const ECHO_WINDOW_MS\s+=\s+\d+;/, 'ECHO_WINDOW_MS'),
  extract(/const ECHO_RATIO\s+=\s+[\d.]+;/, 'ECHO_RATIO'),
  extract(/const ECHO_MIN_WORDS\s+=\s+\d+;/, 'ECHO_MIN_WORDS'),
  extract(/const echoWords = [^\n]+;/, 'echoWords'),
  extract(/function isSelfEcho\(said\) \{[\s\S]*?\n  \}/, 'isSelfEcho'),
].join('\n');

// Rebuild the closure the function relies on, with its state injectable.
const makeGuard = new Function('lastSpokenText', 'ageMs', `
  const lastSpeechEndAt = Date.now() - ageMs;
  ${src}
  return isSelfEcho;
`);

const REPLY = 'The Vapron deployment finished cleanly, sir, and the health score is back to ninety four.';
const guard = (said, spoken = REPLY, ageMs = 0) => makeGuard(spoken, ageMs)(said);

test('Jarvis hearing his own reply back is caught', () => {
  assert.equal(guard('the Vapron deployment finished cleanly sir and the health score is back to ninety four'), true);
});

test('the tail end of his reply is caught', () => {
  assert.equal(guard('health score is back to ninety four'), true);
});

test("Craig's genuine reply gets through", () => {
  assert.equal(guard('right, push that one to production then'), false);
});

test('genuine speech FUSED with echo still gets through', () => {
  // The 2026-07-26 regression: his real point arrived glued to the echo and a
  // 60% filter threw the whole thing away. It must survive.
  assert.equal(guard('and the health score is back to ninety four but I want Zoobicon looked at first before anything else ships today'), false);
});

test('speech arriving after the tail window is never treated as echo', () => {
  // Same words, but 4s later — that is Craig quoting Jarvis, not a speaker.
  assert.equal(guard('health score is back to ninety four', REPLY, 4000), false);
});

test('nothing spoken yet means nothing can be an echo', () => {
  assert.equal(guard('health score is back to ninety four', ''), false);
});

// ── The 2026-07-28 regression ───────────────────────────────────────────────
// The first version compared with spoken.includes(word) — a SUBSTRING check
// over the whole reply — and had no minimum length. Short commands built from
// common words scored 100% and were dropped in silence. Craig: "its listening
// now and not talking back i dont know if its working."

const CHATTY = 'The Vapron deployment finished cleanly, sir, and the health score is back to ' +
  'ninety four. I have also restarted the gateway and the deck.';

test('a short command is NEVER swallowed, whatever he last said', () => {
  for (const said of ['yes do it', 'stop', 'no not that one', 'and the rest', 'go on then']) {
    assert.equal(guard(said, CHATTY), false, said);
  }
});

test('substring collisions do not count — "rest" is not "restarted"', () => {
  // Every word here appears somewhere inside CHATTY as a substring, which is
  // what the broken version keyed on. In order, as whole words, they do not.
  assert.equal(guard('and the rest of the score', CHATTY), false);
});

test('words must match in Jarvis own order, not just be present', () => {
  // A genuine sentence reusing his vocabulary, scrambled — not an echo.
  assert.equal(guard('deck gateway restarted the have I also', CHATTY), false);
});

test('a contiguous run of his reply IS caught', () => {
  assert.equal(guard('I have also restarted the gateway and the deck', CHATTY), true);
});

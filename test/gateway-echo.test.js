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

const html = readFileSync(new URL('../public/gateway.html', import.meta.url), 'utf8');

function extract(re, label) {
  const m = html.match(re);
  assert.ok(m, `could not find ${label} in gateway.html — did the voice section move?`);
  return m[0];
}

const src = [
  extract(/const ECHO_WINDOW_MS\s+=\s+\d+;/, 'ECHO_WINDOW_MS'),
  extract(/const ECHO_RATIO\s+=\s+[\d.]+;/, 'ECHO_RATIO'),
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

test('short filler is not silently swallowed', () => {
  // Words of 3 letters or fewer are ignored by the ratio, leaving no evidence.
  // The guard must fall open (send it) rather than eat a real "yes"/"no".
  assert.equal(guard('yes do it'), false);
});

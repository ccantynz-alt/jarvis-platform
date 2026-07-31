// The Command Deck's echo filter, extracted from the shipped HTML and run.
//
// This is the surface Craig actually uses (:8444). The filter here had the
// same defects the Gateway's did, plus one of its own: it returned TRUE — echo,
// discard — whenever every heard word was three letters or shorter. So "yes",
// "no" and "do it" were thrown away while Jarvis was mid-reply.
//
// 2026-07-31: rewritten again, because the filter was still letting real echoes
// through. It scored a CONTIGUOUS run at a single offset, and speech-to-text
// drops and mangles words when it transcribes a speaker ("queued" → "cute",
// "asleep" → "a sleep"). One dropped word desynchronises every word after it,
// so a 50-word verbatim echo of Jarvis's own reply scored far under threshold
// and was sent to the brain as Craig's next turn. Longest common SUBSEQUENCE
// keeps the ordering requirement — which is what distinguishes an echo from
// coincidental shared vocabulary — while tolerating those gaps.
//
// The filter is now a BACKSTOP, not the defence: closeEar() shuts the mic on
// every platform while Jarvis speaks. This only has to catch the acoustic tail.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// CRLF-normalised: see the note in deck-boot-speech.test.js — a Windows
// checkout gives \r\n, and `.` never matches \r.
const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const consts = html.match(/const ECHO_WINDOW_MS[\s\S]*?const ECHO_MIN_WORDS *= *\d+;/);
assert.ok(consts, 'could not find the ECHO_* constants in command-deck.html');
const fn = html.match(/function isSelfEcho\(said, spokenText\) \{[\s\S]*?\n\}/);
assert.ok(fn, 'could not find isSelfEcho in command-deck.html — did the voice section move?');

const guard = new Function('said', 'onScreen', `
  ${consts[0]}
  ${fn[0]}
  return isSelfEcho(said, onScreen);
`);

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

// ── The regression this rewrite exists for ──────────────────────────────────
// Both of these are VERBATIM from memory KV `jarvis-conversation` on
// 2026-07-31: Jarvis's own replies, recorded as Craig's *user* turns after
// going out the speaker and back in the mic. The previous contiguous-run
// filter scored both below 0.8 and passed them to the brain.

test("2026-07-31: a mangled 50-word echo is caught (it was not)", () => {
  const spoken = "Nothing yet, sir — and that's telling in itself. It's been sitting queued about " +
    "three minutes and the PC hasn't picked it up. Nothing runs on that machine until the worker " +
    "on your end claims it, so either it's asleep, offline, or the worker service isn't running.";
  const heard = "nothing yet and that's telling itself it's been sitting cute about 3 minutes and " +
    "the PC hasn't picked it up nothing runs on that machine until the worker on your end claims " +
    "it so either it's a sleep offline on the worker service isn't running";
  assert.equal(guard(heard, spoken), true);
});

test('2026-07-31: a whole short reply echoed back is caught', () => {
  const spoken = "You trailed off there, sir — find out what's what? Give me the rest of it and I'll take a look.";
  const heard = "you trailed off this find out what's what give me the rest of it and I'll take a look";
  assert.equal(guard(heard, spoken), true);
});

test('a long genuine instruction sharing his topic is not an echo', () => {
  // The dangerous false positive: Craig talking ABOUT what Jarvis just said.
  // Long, on-topic, reuses vocabulary — but it is his own sentence.
  const spoken = "The PC hasn't picked the job up yet, sir. The worker claims it when it wakes.";
  const heard = "forget the worker for now and tell me why the machine keeps crashing in the first place";
  assert.equal(guard(heard, spoken), false);
});

// Which voice Marco speaks in, extracted from the shipped HTML and run.
//
// Craig, 2026-08-11: "we had a nice english male voice before, which free".
// He had. The deck picked it with:
//
//   /en-GB/.test(lang) && /male|daniel|arthur/i.test(name)
//
// and "Google UK English FEMALE" satisfies that, because "Female" CONTAINS
// "male". So on Chrome desktop the deck picked whichever of the two Google UK
// voices the browser enumerated first — while the code read as if it had
// deliberately chosen a male one. Nothing failed; it just sounded wrong.
//
// The fix is \bmale\b (no word boundary exists after "Fe", so it cannot match
// inside "Female") plus an explicit best-first list of the FREE British male
// voices on the platforms he actually uses.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// CRLF-normalised: a Windows checkout gives \r\n, and `.` never matches \r.
const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const prefs = html.match(/const VOICE_PREFS = \[[\s\S]*?\];/);
assert.ok(prefs, 'VOICE_PREFS not found in command-deck.html');
const fn = html.match(/function pickBritishMaleVoice\(voices = voiceCache, chosen = null\) \{[\s\S]*?\n\}/);
assert.ok(fn, 'pickBritishMaleVoice not found — did the voice section move?');

// 2026-08-27: the picker gained a NATURAL-tier pass (an enhanced voice beats a
// better-ranked compact one, whether or not its name is in VOICE_PREFS), so it
// now depends on these. They are EXTRACTED rather than re-declared here, so a
// change to what counts as "enhanced" cannot pass in the tests while failing on
// the device.
const tier = html.match(/const VOICE_TIER_RE =[\s\S]*?function voiceTier[^\n]*\n/);
assert.ok(tier, 'voiceTier not found — pickBritishMaleVoice depends on it');
const males = html.match(/const MALE_RE =[\s\S]*?const FEMALE_RE =[^\n]*\n/);
assert.ok(males, 'MALE_RE/FEMALE_RE not found — pickBritishMaleVoice depends on them');
const deps = tier[0] + males[0];

const pick = new Function('voices', `
  ${deps}
  ${prefs[0]}
  ${fn[0].replace('voices = voiceCache, chosen = null', 'voices, chosen = null')}
  return pickBritishMaleVoice(voices);
`);

// ── Voice settings sheet (2026-08-19, move 32): an explicit choice wins ──────
const pickChosen = new Function('voices', 'chosen', `
  ${deps}
  ${prefs[0]}
  ${fn[0].replace('voices = voiceCache, chosen = null', 'voices, chosen')}
  return pickBritishMaleVoice(voices, chosen);
`);

test('a voice chosen in the settings sheet beats the preference list', () => {
  const list = [{ name: 'Google UK English Male', lang: 'en-GB' }, { name: 'Daniel', lang: 'en-GB' }, { name: 'Samantha', lang: 'en-US' }];
  assert.equal(pickChosen(list, 'Daniel').name, 'Daniel');
});

test('a saved choice this device does not have falls through to the ruling', () => {
  const list = [{ name: 'Google UK English Male', lang: 'en-GB' }, { name: 'Samantha', lang: 'en-US' }];
  assert.equal(pickChosen(list, 'Microsoft Ryan Online (Natural) - English (United Kingdom)').name, 'Google UK English Male');
});

test('the utterance always carries a lang, en-GB when no voice could be named', () => {
  // The utterance is built in speakChunkAsync since 2026-08-27 — speakBrowserAsync
  // became the sentence-by-sentence driver above it. The RULE is unchanged and
  // still load-bearing: with an empty voice cache (iOS before the first gesture)
  // an utterance carrying neither voice nor lang gets the OS default, which is
  // the US voice Craig kept hearing.
  const fnSpeak = html.match(/function speakChunkAsync\(text\) \{[\s\S]*?\n\}/);
  assert.ok(fnSpeak, 'speakChunkAsync not found — did the voice section move?');
  assert.match(fnSpeak[0], /u\.lang = \(v && v\.lang\) \|\| 'en-GB'/);
});

test('speech is never emitted below full volume — loudness is the klaxon\'s job', () => {
  const fnSpeak = html.match(/function speakChunkAsync\(text\) \{[\s\S]*?\n\}/);
  assert.match(fnSpeak[0], /u\.volume = 1/);
});

test('an enhanced voice is left at its natural pitch — resampling one is what re-robots it', () => {
  const fnSpeak = html.match(/function speakChunkAsync\(text\) \{[\s\S]*?\n\}/);
  assert.match(fnSpeak[0], /enhanced \? 1\.0 : 0\.9/, 'pitch must follow the voice tier');
  assert.match(fnSpeak[0], /voiceSetting\('pitch', null\)/, 'an explicit choice must still win');
});

const v = (name, lang) => ({ name, lang });

// The real Chrome-on-Windows list, in the order Chrome actually returns it —
// Female BEFORE Male, which is what made this bite.
const CHROME_WIN = [
  v('Microsoft David - English (United States)', 'en-US'),
  v('Microsoft Zira - English (United States)', 'en-US'),
  v('Google UK English Female', 'en-GB'),
  v('Google UK English Male', 'en-GB'),
  v('Google US English', 'en-US'),
];

test('THE BUG: "Female" contains "male" — the naive test picks the wrong voice', () => {
  // Proof the old predicate was genuinely wrong, not a style preference.
  assert.equal(/male/i.test('Google UK English Female'), true, 'substring match is real');
  assert.equal(/\bmale\b/i.test('Google UK English Female'), false, 'the fix excludes it');
  assert.equal(/\bmale\b/i.test('Google UK English Male'), true, 'and still admits the real one');
});

test('Chrome desktop gets the male voice even though Female is listed first', () => {
  assert.equal(pick(CHROME_WIN).name, 'Google UK English Male');
});

test('iPad falls to Daniel, the classic British butler voice', () => {
  const IOS = [v('Samantha', 'en-US'), v('Karen', 'en-AU'), v('Daniel', 'en-GB'), v('Martha', 'en-GB')];
  assert.equal(pick(IOS).name, 'Daniel');
});

test('an enhanced variant wins over the plain one', () => {
  const withEnhanced = [v('Daniel', 'en-GB'), v('Daniel (Enhanced)', 'en-GB')];
  assert.equal(pick(withEnhanced).name, 'Daniel (Enhanced)');
  const natural = [v('Microsoft Ryan Online (Natural) - English (United Kingdom)', 'en-GB'), v('Daniel', 'en-GB')];
  assert.equal(pick(natural).name, 'Microsoft Ryan Online (Natural) - English (United Kingdom)');
});

test('with no British voice at all it degrades sanely rather than going mute', () => {
  const usOnly = [v('Microsoft Zira - English (United States)', 'en-US')];
  assert.equal(pick(usOnly).name, 'Microsoft Zira - English (United States)');
  // A voiceless browser must return null, never throw — speak() checks for null.
  assert.equal(pick([]), null);
  assert.equal(pick(undefined), null);
});

test('the gateway keeps the same rule — the two surfaces must not drift', () => {
  const gw = readFileSync(new URL('../public/gateway.html', import.meta.url), 'utf8');
  assert.match(gw, /google uk english male/, 'gateway lost the free desktop voice');
  assert.match(gw, /\\bmale\\b/, 'gateway still uses the substring test that matches "Female"');
});

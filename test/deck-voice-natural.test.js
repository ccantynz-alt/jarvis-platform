// The deck's voice-naturalness layer, extracted from the shipped HTML and run.
//
// Craig, 2026-08-27: "change the free generic voice so its more natural rather
// than robot." ElevenLabs stays OFF — that is a RULING, not a fault (see the
// VOICE section of CLAUDE.md). So naturalness has to come from three things we
// control, and each of them is tested here because each has a way of silently
// reverting to the robot:
//
//   1. WHICH free voice. Every platform ships a compact voice and a natural one
//      and defaults to the compact. Picking the wrong one is 90% of "robot".
//   2. WHAT we hand it. Marco writes for a screen; a speech engine reads
//      "**davenroe-api**" as "star star davenroe dash a p i star star".
//   3. HOW it is delivered. One long utterance is flat and breathless; one
//      sentence at a time with a real pause is most of the rest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// CRLF-normalised: a Windows checkout gives \r\n, and `.` never matches \r.
const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

function grab(re, what) {
  const m = html.match(re);
  assert.ok(m, `could not find ${what} in command-deck.html — did the voice section move?`);
  return m[0];
}

const src = [
  grab(/const VOICE_PREFS = \[[\s\S]*?\];/, 'VOICE_PREFS'),
  grab(/const VOICE_TIER_RE =[\s\S]*?function voiceTier[^\n]*\n/, 'voiceTier'),
  grab(/const MALE_RE =[\s\S]*?const FEMALE_RE =[^\n]*\n/, 'MALE_RE/FEMALE_RE'),
  grab(/function pickBritishMaleVoice\(voices[\s\S]*?\n\}/, 'pickBritishMaleVoice'),
  grab(/function voiceUpgradeHint\([\s\S]*?\n\}/, 'voiceUpgradeHint'),
  grab(/const SPEECH_FIXUPS = \[[\s\S]*?\n\];/, 'SPEECH_FIXUPS'),
  grab(/function humanizeForSpeech\([\s\S]*?\n\}/, 'humanizeForSpeech'),
  grab(/const SPEECH_CHUNK_MAX = \d+;/, 'SPEECH_CHUNK_MAX'),
  grab(/function splitForSpeech\([\s\S]*?\n\}/, 'splitForSpeech'),
].join('\n');

const api = new Function(`
  const voiceCache = [];
  ${src}
  return { voiceTier, pickBritishMaleVoice, voiceUpgradeHint, humanizeForSpeech, splitForSpeech, SPEECH_CHUNK_MAX };
`)();

const v = (name, lang = 'en-GB') => ({ name, lang });

// ── 1. Which voice ──────────────────────────────────────────────────────────

test('the natural tier is recognised by every name the platforms use for it', () => {
  for (const n of ['Daniel (Enhanced)', 'Daniel (Premium)', 'Microsoft Ryan Online (Natural) - English (United Kingdom)',
                   'Some Neural Voice', 'Siri Voice 4']) {
    assert.equal(api.voiceTier(n), 'enhanced', n);
  }
  for (const n of ['Daniel', 'Google UK English Male', 'Microsoft Hazel', '']) {
    assert.equal(api.voiceTier(n), 'standard', n);
  }
});

test('an enhanced form of a preferred voice beats the compact form of a better-ranked one', () => {
  const picked = api.pickBritishMaleVoice([
    v('Google UK English Male'),              // ranked first, but compact
    v('Microsoft Ryan Online (Natural) - English (United Kingdom)'),
  ]);
  assert.match(picked.name, /Natural/, 'the compact top-ranked voice won — this is the robot Craig hears');
});

// THE case this change exists for: a device offering a natural voice we never
// listed used to fall all the way through to a compact one.
test('ANY enhanced British voice beats a compact one, listed or not', () => {
  const picked = api.pickBritishMaleVoice([
    v('Google UK English Male'),
    v('Arthur (Premium)'),                    // not in VOICE_PREFS at all
  ]);
  assert.equal(picked.name, 'Arthur (Premium)');
});

test('among enhanced British voices a male one is preferred', () => {
  const picked = api.pickBritishMaleVoice([
    v('Martha (Enhanced)'),
    v('Oliver Male (Enhanced)'),
  ]);
  assert.equal(picked.name, 'Oliver Male (Enhanced)');
});

// 2026-08-11, and it must never come back: /male/ matches "Female".
test('an enhanced FEMALE voice is not mistaken for a male one', () => {
  const picked = api.pickBritishMaleVoice([v('Google UK English Female (Enhanced)')], null);
  assert.ok(!picked || !/Female/.test(picked.name) || picked.name === 'Google UK English Female (Enhanced)',
    'sanity');
  // With a male compact alternative present, the female enhanced must not win.
  const picked2 = api.pickBritishMaleVoice([
    v('Google UK English Female (Enhanced)'),
    v('Google UK English Male'),
  ]);
  assert.equal(picked2.name, 'Google UK English Male');
});

test('an explicit choice from the sheet still wins over everything', () => {
  const picked = api.pickBritishMaleVoice([v('Daniel (Enhanced)'), v('Google UK English Male')], 'Google UK English Male');
  assert.equal(picked.name, 'Google UK English Male');
});

test('a saved name the device has never heard of falls through instead of failing', () => {
  const picked = api.pickBritishMaleVoice([v('Daniel (Enhanced)')], 'A Voice From Another Phone');
  assert.equal(picked.name, 'Daniel (Enhanced)');
});

test('the upgrade hint names the actual menu path for the device in hand', () => {
  const ios = api.voiceUpgradeHint('iPhone Safari', false, { platform: 'iPhone' });
  assert.match(ios, /Spoken Content/);
  assert.match(api.voiceUpgradeHint('Windows Chrome', false, { platform: 'Win32' }), /Edge/);
  assert.match(api.voiceUpgradeHint('Android Chrome', false, { platform: 'Linux' }), /Google Speech Services/);
  assert.equal(api.voiceUpgradeHint('Windows Edg/120', false, { platform: 'Win32' }), '',
    'Edge already has the Natural voices — nothing to advise');
  assert.equal(api.voiceUpgradeHint('iPhone Safari', true, { platform: 'iPhone' }), '',
    'nothing to advise once an enhanced voice is in use');
});

// ── 2. What we hand it ──────────────────────────────────────────────────────

test('markdown is never read aloud', () => {
  const out = api.humanizeForSpeech('**davenroe-api** is down (`:8010`) — see *the log*');
  assert.doesNotMatch(out, /[*`]/);
  assert.match(out, /davenroe api is down/);
});

test('a URL becomes "a link" instead of being spelled out', () => {
  const out = api.humanizeForSpeech('Deployed to https://marco-demo.vapron.app/status now');
  assert.match(out, /a link/);
  assert.doesNotMatch(out, /https/);
});

test('an ISO timestamp is read as a time, not as a serial number', () => {
  const out = api.humanizeForSpeech('fleet-check 2026-08-27T18:04:30Z: HTTP 200');
  assert.match(out, /18:04/);
  assert.doesNotMatch(out, /2026-08-27T/);
});

test('a code block is summarised, never recited', () => {
  const out = api.humanizeForSpeech('Here:\n```\nconst x = 1;\n```\nthat is all');
  assert.doesNotMatch(out, /const x/);
  assert.match(out, /code omitted/);
});

test('emoji and box drawing do not become noises', () => {
  const out = api.humanizeForSpeech('🚨 ALERT ── vapron down ▓▓');
  assert.doesNotMatch(out, /[\u{1F300}-\u{1FAFF}]/u);
  assert.match(out, /ALERT/);
  assert.match(out, /vapron down/);
});

test('abbreviations and arrows are spoken as words', () => {
  const out = api.humanizeForSpeech('proposed → under_review, e.g. a code_fix, approx. 3 min');
  assert.match(out, / to /);
  assert.match(out, /for example/);
  assert.match(out, /approximately/);
  assert.match(out, /minutes/);
});

test('an email address is not dictated character by character', () => {
  assert.match(api.humanizeForSpeech('mail from marco@alecrae.com'), /an email address/);
});

test('ordinary prose is left alone', () => {
  const plain = 'The zoobicon repair job completed about eight hours ago.';
  assert.equal(api.humanizeForSpeech(plain), plain);
});

test('it never returns null or undefined, whatever it is given', () => {
  for (const bad of [null, undefined, '', 123, {}]) {
    assert.equal(typeof api.humanizeForSpeech(bad), 'string', String(bad));
  }
});

// ── 3. How it is delivered ──────────────────────────────────────────────────

test('a reply is spoken sentence by sentence, so the engine can breathe', () => {
  const parts = api.splitForSpeech('The deploy landed. Health is back to ninety five. Nothing else needs you.');
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^The deploy landed\.$/);
});

test('a very long sentence is broken at a clause, never mid-word', () => {
  const long = 'The fleet check ran across every platform and found that gatetest does not resolve, '
    + 'that voxlen is a parked page, that alecrae is answering normally, and that vapron is still degraded after two attempts.';
  const parts = api.splitForSpeech(long);
  assert.ok(parts.length > 1, 'a 200-character sentence was not split at all');
  for (const p of parts) {
    assert.ok(p.length <= api.SPEECH_CHUNK_MAX + 40, `chunk too long: ${p.length}`);
    assert.equal(p, p.trim(), 'a chunk must not start or end on whitespace');
    assert.ok(p.length > 0);
  }
  // Nothing is lost in the splitting — that would be a silently truncated alert.
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
});

test('a two-word sentence does not get a dramatic pause of its own', () => {
  const parts = api.splitForSpeech('Yes. The vapron deploy finished cleanly and health is back to ninety five.');
  assert.equal(parts.length, 1, 'a stray fragment should merge into its neighbour');
});

test('empty and whitespace input produce nothing to say, not an empty utterance', () => {
  for (const bad of ['', '   ', null, undefined]) {
    assert.deepEqual(api.splitForSpeech(bad), [], String(bad));
  }
});

test('the whole pipeline turns a real Marco line into speakable sentences', () => {
  const raw = '**Alert:** `davenroe-api` is down — see https://jarvis.example/ops at 2026-08-27T18:04:30Z. '
    + 'Self-heal has dispatched a repair, e.g. a restart.';
  const parts = api.splitForSpeech(api.humanizeForSpeech(raw));
  const all = parts.join(' ');
  assert.doesNotMatch(all, /[*`]|https|2026-08-27T/);
  assert.match(all, /davenroe api is down/);
  assert.match(all, /for example/);
  assert.ok(parts.length >= 2, 'two sentences should be spoken as two');
});

// ── The alert tone (2026-08-27) ─────────────────────────────────────────────
//
// Craig: "how to change the alert so its louder." Until now an alert arriving on
// an OPEN deck drew a banner and spoke — no attention-getting sound at all, at
// whatever the system volume happened to be. These test the control that fixes
// that, and in particular the way it managed to ship MUTED.

const alertSrc = [
  grab(/const ALERT_VOLUME_KEY = [\s\S]*?\n\}/, 'alertVolume'),
].join('\n');

function alertVolumeWith(stored) {
  return new Function('__stored', `
    const localStorage = { getItem: () => __stored };
    ${alertSrc}
    return alertVolume();
  `)(stored);
}

// THE bug, caught by the first screenshot of this control: it read
// "ALERT VOLUME 0%". Number(null) and Number('') are both 0, not NaN, so a
// range check of 0..1 accepts the phantom zero and every alert is silent on a
// device that has never touched the slider. Same shape as guardrail()'s
// allowZero defect on the box the same week: absence is not a deliberate zero.
test('an unset alert volume is LOUD, not muted', () => {
  assert.equal(alertVolumeWith(null), 0.85, 'unset must fall back, not read as 0');
  assert.equal(alertVolumeWith(''), 0.85, 'empty must fall back, not read as 0');
  assert.equal(alertVolumeWith(undefined), 0.85);
});

test('a deliberate zero still means muted — that is the point of the control', () => {
  assert.equal(alertVolumeWith('0'), 0);
});

test('a stored level is honoured, and nonsense falls back rather than screaming', () => {
  assert.equal(alertVolumeWith('0.5'), 0.5);
  assert.equal(alertVolumeWith('1'), 1);
  for (const bad of ['abc', '7', '-1', '1.5']) {
    assert.equal(alertVolumeWith(bad), 0.85, bad);
  }
});

test('an alert is louder and more insistent than a warning', () => {
  const fn = grab(/function alertKlaxon\([\s\S]*?\n\}/, 'alertKlaxon');
  assert.match(fn, /const reps = alert \? 3 : 1/, 'an alert must repeat');
  assert.match(fn, /alert \? 0\.9 : 0\.5/, 'an alert must be louder');
  assert.match(fn, /createDynamicsCompressor/, 'without a compressor, raising gain only clips');
  assert.match(fn, /closeEar/, 'the mic must not hear the klaxon and treat it as speech');
});

test('the tone plays BEFORE the words, and QA captures stay silent', () => {
  const fn = grab(/function showAlert\(level, title, speech\) \{[\s\S]*?\n\}/, 'showAlert');
  const klaxonAt = fn.indexOf('alertKlaxon');
  const speakAt = fn.indexOf('speak(speech');
  assert.ok(klaxonAt > 0 && speakAt > klaxonAt, 'the tone must turn his head before the sentence starts');
  assert.match(grab(/function alertKlaxon\([\s\S]*?\n\}/, 'alertKlaxon'), /voice'\) === '0'/,
    'headless screenshot captures must not make noise');
});

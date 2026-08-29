// Why Marco was silent on Craig's iPhone (2026-08-29).
//
// Craig, four times across three weeks: "im still not hearing marco speak from
// my iphone". Each previous fix was read out of the code, looked right, and was
// never seen to work on the device that was failing. This suite pins the two
// structural faults found by actually following the control flow, plus the
// reporting that makes the next round evidence rather than another guess.
//
// Both faults share a shape worth naming: the deck knew it was mute and said
// something reassuring instead. Principle 6 — a degraded mode must announce
// itself — applies to the deck's own voice most of all, because a silent
// assistant and a broken one are indistinguishable from the sofa.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const server = readFileSync(new URL('../src/deck-server.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const grab = (re, what) => { const m = html.match(re); assert.ok(m, `${what} not found — did the voice section move?`); return m[0]; };

// ── Fault 1: the EAR's absence muted the MOUTH ──────────────────────────────
//
// `voiceMode` is forced to 'off' when the browser has no SpeechRecognition —
// an INPUT api. speak() returned early on 'off'. So a device that cannot listen
// was also, silently and permanently, a device Marco could never speak from,
// and the only clue on screen was a pill reading "MIC OFF".

test('speak() no longer returns early just because this browser cannot LISTEN', () => {
  const fn = grab(/function speak\(text\) \{[\s\S]*?\n\}/, 'speak()');
  assert.doesNotMatch(fn, /voiceMode === 'off'\) return/,
    'speak() still mutes on a bare voiceMode check — a forced off silences the mouth');
  assert.match(fn, /voiceMode === 'off' && SR_AVAILABLE/,
    'a DELIBERATE off must still mute; a forced one must not');
});

test('SR_AVAILABLE is the ONE source of truth for "can this browser listen"', () => {
  assert.match(html, /const SR_AVAILABLE = qs\.get\('nosr'\) !== '1' &&\n\s*!!\(window\.SpeechRecognition \|\| window\.webkitSpeechRecognition\)/);
  // SRCls must derive from it, not re-ask the window — two answers to one
  // question is how the output gate and the input gate disagreed.
  assert.match(html, /const SRCls = SR_AVAILABLE \? \(window\.SpeechRecognition \|\| window\.webkitSpeechRecognition\) : null;/);
});

test('?nosr=1 makes the no-microphone case reachable in a capture', () => {
  // Chromium has webkitSpeechRecognition, so without this switch the branch
  // that matters cannot be screenshotted — which is exactly how it shipped
  // unverified four times.
  assert.match(html, /\?nosr=1 simulates a browser with no SpeechRecognition/);
});

test('the pill names which half is missing instead of claiming MIC OFF', () => {
  const fn = grab(/function updateVoiceState\(\) \{[\s\S]*?\n\}/, 'updateVoiceState()');
  assert.match(fn, /!SR_AVAILABLE/, 'no branch for a browser that never had a mic');
  assert.match(fn, /VOICE OUT ONLY/, 'the honest label is missing');
  // The forced case must be tested BEFORE the generic 'off' branch, or it can
  // never be reached — voiceMode is already 'off' by then.
  assert.ok(fn.indexOf('!SR_AVAILABLE') < fn.indexOf("voiceMode === 'off'"),
    'the SR_AVAILABLE branch must come first or it is dead code');
});

test('the pending-speech badge follows the same rule as speak()', () => {
  const fn = grab(/function updatePendingBadge\(\) \{[\s\S]*?\n\}/, 'updatePendingBadge()');
  assert.match(fn, /voiceMode === 'off' && SR_AVAILABLE/,
    'a device with a mouth but no ear must still be told it has speech waiting');
});

// ── Fault 2: the tap that promised to speak, deleted ────────────────────────
//
// primeTTS() scheduled pumpSpeech at +300ms to "flush anything that queued
// before the first tap", then called armVoice(), which cleared the queue
// synchronously. The badge on screen read "TAP TO HEAR". Tapping was the one
// gesture that guaranteed he never heard them.

test('the first tap keeps FRESH utterances and drops only stale ones', () => {
  const fn = grab(/function armVoice\(\) \{[\s\S]*?\n\}/, 'armVoice()');
  assert.doesNotMatch(fn, /console\.warn\([^)]*\);\n\s*speechQ\.length = 0;\n\s*updatePendingBadge/,
    'armVoice still drops the whole queue that the badge promised to speak');
  assert.match(fn, /SPEECH_STALE_MS/, 'age must decide what survives the tap, not the gesture');
  assert.match(fn, /speechQ\.filter/);
});

test('the queue carries a timestamp, or age cannot decide anything', () => {
  const fn = grab(/function speak\(text\) \{[\s\S]*?\n\}/, 'speak()');
  assert.match(fn, /speechQ\.push\(\{ text: t, at: Date\.now\(\) \}\)/);
  // Every producer must use the same shape — an unshifted bare string would
  // read back as `undefined` text and be silently skipped.
  const unshifts = html.match(/speechQ\.unshift\([^)]*\)/g) || [];
  assert.ok(unshifts.length >= 3, 'expected the enterBrowserVoice/enterBackupVoice unshifts');
  for (const u of unshifts) {
    assert.match(u, /\{|\.\.\./, `bare-string producer left behind: ${u}`);
  }
  const pump = grab(/async function pumpSpeech\(\) \{[\s\S]*?\n\}/, 'pumpSpeech()');
  assert.match(pump, /speechQ\.shift\(\)\.text/, 'the consumer must read .text off the entry');
});

test('SPEECH_STALE_MS keeps a missed reply but drops an abandoned greeting', () => {
  const m = html.match(/const SPEECH_STALE_MS = (\d+);/);
  assert.ok(m, 'SPEECH_STALE_MS not declared');
  const ms = Number(m[1]);
  assert.ok(ms >= 30000, 'too short — a reply he stepped away from would vanish');
  assert.ok(ms <= 300000, 'too long — a greeting from an abandoned tab would play late');
});

// ── The reporting that ends the guessing ────────────────────────────────────

test('the three ways an utterance can end are told apart', () => {
  const fn = grab(/function speakChunkAsync\(text\) \{[\s\S]*?\n\}/, 'speakChunkAsync()');
  assert.match(fn, /finish\('ended'\)/);
  assert.match(fn, /finish\('error:'/);
  assert.match(fn, /finish\('timeout'\)/);
  // The timeout case is the diagnosis on iOS: the engine accepted the utterance
  // and produced no sound. Sharing one handler made it indistinguishable from
  // a successful one, which is how "the code looks right" survived four rounds.
  assert.doesNotMatch(fn, /u\.onend = u\.onerror = finish;/);
});

test('the deck reports its real voice state to the box, at most twice a load', () => {
  assert.match(html, /function reportVoice\(when\)/);
  assert.match(html, /if \(voiceReportsSent >= 2\) return;/, 'a diagnostic must not become a telemetry pipe');
  assert.match(html, /'\/api\/voice-report'/);
  for (const field of ['srAvailable', 'voices', 'chosen', 'outcome', 'primed', 'standalone']) {
    assert.match(html, new RegExp(`\\b${field}:`), `report omits ${field} — the field that would settle it`);
  }
});

test('the report route stores a fixed field set, never arbitrary client JSON', () => {
  assert.match(server, /app\.post\('\/api\/voice-report'/);
  assert.match(server, /VOICE_REPORT_FIELDS/);
  assert.match(server, /VOICE_REPORT_KEEP/, 'unbounded growth in a KV row');
  // A failed diagnostic must never take the deck down with it.
  const route = server.match(/app\.post\('\/api\/voice-report'[\s\S]*?\n\}\);/);
  assert.ok(route, 'route not found');
  assert.match(route[0], /catch \{[^}]*\}/, 'the write is not wrapped');
});

test('no transcript text is ever sent in a voice report', () => {
  const fn = grab(/function reportVoice\(when\) \{[\s\S]*?\n\}/, 'reportVoice()');
  for (const leak of ['text:', 'transcript', 'said', 'utterance:', 'heard']) {
    assert.ok(!fn.includes(leak), `voice report leaks ${leak} — this is a capability probe, not a mic`);
  }
});

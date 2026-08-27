// The briefing panel had no voice (2026-08-27).
//
// Craig: the briefing "renders on screen but is never spoken aloud", while the
// VOICE settings sheet's test button speaks perfectly. Both halves were true,
// and the second half is what made it confusing — the voice path was healthy
// the whole time. /health reports tts:false (the standing TTS_DISABLED=1
// ruling), so /tts 503s `unconfigured`, speakOnce() routes to
// enterBrowserVoice() and the free Google UK English Male voice speaks. The
// settings-sheet test calls speak() directly, so it worked. Nothing was wrong
// with TTS, closeEar() or isSelfEcho() — those gate the MICROPHONE and the
// NEXT inbound utterance, and can never suppress an outbound speak().
//
// The panel simply never called speak(). Two independent halves of one break:
//
//   1. handleBriefing() (lib/conversation.js) returns {text, speech, data} and
//      has always computed a spoken summary line. deck-server.js forwarded only
//      the data:  send({ type: 'briefing', data: b.data })  — `speech` was
//      dropped on the floor and no client could have voiced it.
//   2. showBriefing() built innerHTML, wired its close button and returned. Its
//      sibling showAlert() ends with speak(speech || title); the briefing
//      handler was the one of the three that had no voice at all.
//
// Measured live against the running deck before the fix (raw CDP, speak()
// wrapped in the real browser): the {type:'briefing'} frame arrived at 28ms
// carrying `speech: undefined`, the panel opened with the full briefing on
// screen, and the only three speak() calls in the turn — at 3129ms, 3794ms and
// 4014ms — carried the brain's separate answer. Not one word of the briefing
// ever reached the speak function.
//
// So: the panel voices itself. The line is sent by the server AND derived
// client-side, so every path that can raise the panel is spoken — including
// ?demo-briefing=1, which a virtual-time screenshot can witness but a WS frame
// can never reach.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const server = readFileSync(new URL('../src/deck-server.js', import.meta.url), 'utf8');

// ── the spoken line, as a pure function lifted out of the shipped HTML ──────
const speechFn = html.match(/function briefingSpeech\(d\) \{[\s\S]*?\n\}/);
assert.ok(speechFn, 'briefingSpeech() not found — the briefing panel has lost its voice');
const briefingSpeech = new Function('d', `${speechFn[0]}; return briefingSpeech(d);`);

const FULL = {
  date: '2026-08-27T05:00:00.000Z',
  healthy: [{ name: 'zoobicon' }, { name: 'gatetest' }, { name: 'alecrae' }],
  attention: [{ name: 'vapron', issue: 'latency spikes' }],
  unaudited: ['davenroe', 'marcoreid'],
  openIssues: 3,
  jobs: [{ platform: 'vapron', task: 'self-heal' }],
};

test('the spoken line carries the counts that are on screen', () => {
  const line = briefingSpeech(FULL);
  assert.match(line, /3 platforms healthy/);
  assert.match(line, /1 needs attention/);
  assert.match(line, /2 not yet audited/);
  assert.match(line, /1 job running/);
  assert.match(line, /3 unresolved issues/);
});

test('counts are pluralised, so Marco never says "1 platforms healthy"', () => {
  const line = briefingSpeech({ healthy: [{ name: 'a' }], attention: [], unaudited: [], jobs: [{}, {}], openIssues: 1 });
  assert.match(line, /1 platform healthy/);
  assert.match(line, /2 jobs running/);
  assert.match(line, /1 unresolved issue\b/);
});

test('an empty briefing still says something rather than trailing off', () => {
  const line = briefingSpeech({ date: FULL.date, healthy: [], attention: [], unaudited: [], jobs: [], openIssues: 0 });
  assert.match(line, /0 platforms healthy/);
  assert.doesNotMatch(line, /undefined|NaN|\[object/);
});

test('a briefing with fields missing entirely does not throw', () => {
  const line = briefingSpeech({ date: FULL.date });
  assert.equal(typeof line, 'string');
  assert.doesNotMatch(line, /undefined|NaN/);
});

// ── showBriefing() itself, run against a stub DOM ────────────────────────────
// The panel must both RENDER and SPEAK. Before the fix it only rendered.
const showFn = html.match(/function showBriefing\(d, speech\) \{[\s\S]*?\n\}/);
assert.ok(showFn, 'showBriefing(d, speech) not found — did it stop accepting the spoken line?');

function runShowBriefing(d, speech, { discardReply = false } = {}) {
  const spoken = [];
  const box = { innerHTML: '', classList: { add() {}, remove() {}, contains: () => false }, onclick: null };
  const $ = () => box;
  const document = { addEventListener() {}, removeEventListener() {} };
  const speak = (t) => spoken.push(String(t));
  new Function('d', 'speech', '$', 'document', 'speak', 'discardReply', `
    ${speechFn[0]}
    ${showFn[0]}
    showBriefing(d, speech);
  `)(d, speech, $, document, speak, discardReply);
  return { spoken, html: box.innerHTML };
}

test('rendering the briefing panel also speaks it', () => {
  const { spoken, html: rendered } = runShowBriefing(FULL, null);
  assert.ok(rendered.includes('BRIEFING'), 'the panel must still render');
  assert.equal(spoken.length, 1, 'the panel rendered without speaking — the original bug');
  assert.match(spoken[0], /3 platforms healthy/);
});

test("the server's own spoken line wins over the derived one when it is sent", () => {
  const { spoken } = runShowBriefing(FULL, 'Good morning. Nine platforms healthy.');
  assert.deepEqual(spoken, ['Good morning. Nine platforms healthy.']);
});

test('a briefing arriving with no speech field still speaks — the pre-fix wire format', () => {
  // deck-server used to send {type:'briefing', data} and nothing else. An old
  // server, or any other producer, must still be voiced by the client.
  const { spoken } = runShowBriefing(FULL, undefined);
  assert.equal(spoken.length, 1);
  assert.match(spoken[0], /platforms healthy/);
});

test('an interrupted turn renders the briefing but stays silent', () => {
  // discardReply is the mic-tap interrupt (2026-07-24): text still appears,
  // nothing more is spoken. The panel must honour it like every other path.
  const { spoken, html: rendered } = runShowBriefing(FULL, null, { discardReply: true });
  assert.ok(rendered.includes('BRIEFING'), 'an interrupt must not blank the panel');
  assert.deepEqual(spoken, [], 'Marco kept talking through an interrupt');
});

// ── the wire: the spoken line has to survive the trip ───────────────────────
test('deck-server forwards the spoken line it already computed', () => {
  assert.match(server, /handleBriefing\(\)[\s\S]{0,160}type: 'briefing'[\s\S]{0,80}speech: b\.speech/,
    'deck-server is dropping handleBriefing()’s speech line again');
});

test('handleBriefing still produces a speech line for the server to forward', () => {
  const conv = readFileSync(new URL('../src/lib/conversation.js', import.meta.url), 'utf8');
  assert.match(conv, /export async function handleBriefing\(\)/);
  assert.match(conv, /return \{ text: msg, speech, data \}|speech,\s*data/,
    'handleBriefing must keep returning {text, speech, data}');
});

test('the deck WS handler passes the speech through to the panel', () => {
  assert.match(html, /m\.type === 'briefing' && m\.data\) showBriefing\(m\.data, m\.speech\)/,
    'the briefing frame is being rendered without its spoken line');
});

// ── the ruling stays ruled ──────────────────────────────────────────────────
test('the panel speaks through speak(), never its own audio path', () => {
  // speak() is the single funnel — it applies the /tts contract, the echo
  // guard (rememberSpoken) and closeEar(). A panel that reached for an audio
  // API directly would bypass all three.
  assert.doesNotMatch(showFn[0], /Audio|fetch\(|speechSynthesis/,
    'showBriefing must speak through speak(), not its own audio path');
  assert.match(showFn[0], /speak\(speech \|\| briefingSpeech\(d\)\)/);
});

test('a 503 of `unconfigured` is still a ruling, not a degradation', () => {
  // The standing TTS_DISABLED=1 ruling: /tts 503s `unconfigured`, which must go
  // quietly to the free Google voice. If this ever routed to enterBackupVoice()
  // the deck would announce a fault for the configuration Craig asked for
  // (2026-08-16) — and this briefing line would carry the warning every time.
  assert.match(html, /if \(reason === 'unconfigured'\) \{ enterBrowserVoice\(text\); return; \}/,
    'the unconfigured/backup distinction has been broken again');
});

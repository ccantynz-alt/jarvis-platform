// The deck's open-mic bounds, extracted from the shipped HTML and run.
//
// 2026-08-06: a deck tab sat in MIC LIVE mode for 14+ hours (the mode was
// persisted in localStorage, so it survived every reload) and transcribed
// 23 minutes of a private household conversation, sending every ~20s fragment
// to the brain and speaking a reply to each one. "stop it" got a polite
// "Stopping, sir." — and the mic stayed hot.
//
// Three bounds now exist, and this file pins all of them:
//   1. LIVE never survives a page load (boot maps a stored 'live' to 'wake',
//      and setVoiceMode never writes 'live' to localStorage).
//   2. LIVE expires after LIVE_MAX_MS while the tab is open.
//   3. In wake mode, the follow-up window stops re-arming after
//      FOLLOWUP_CHAIN_MAX consecutive turns that never said "Jarvis" —
//      an eavesdrop never says the name; a real conversation does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// CRLF-normalised: a Windows checkout gives \r\n, and `.` never matches \r.
const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

// ── 3. follow-up chain cap — extract the pure decision and run it ──────────
const consts = html.match(/const FOLLOWUP_CHAIN_MAX *= *\d+;/);
assert.ok(consts, 'could not find FOLLOWUP_CHAIN_MAX in command-deck.html');
const fn = html.match(/function mayRearmFollowUp\(mode, chain\) \{[\s\S]*?\n\}/);
assert.ok(fn, 'could not find mayRearmFollowUp in command-deck.html — did the voice section move?');

const mayRearm = new Function('mode', 'chain', `
  ${consts[0]}
  ${fn[0]}
  return mayRearmFollowUp(mode, chain);
`);
const CAP = Number(consts[0].match(/\d+/)[0]);

test('a fresh wake-word conversation keeps flowing', () => {
  assert.equal(mayRearm('wake', 0), true);
  assert.equal(mayRearm('wake', CAP - 1), true);
});

test('the chain closes at the cap — an eavesdrop cannot run forever', () => {
  assert.equal(mayRearm('wake', CAP), false);
  assert.equal(mayRearm('wake', CAP + 40), false);
});

test('voice off never re-arms', () => {
  assert.equal(mayRearm('off', 0), false);
});

test('live mode is not chain-capped (it is bounded by LIVE_MAX_MS instead)', () => {
  assert.equal(mayRearm('live', CAP + 1), true);
});

// ── 1. LIVE never survives a page load ─────────────────────────────────────
test('boot maps a persisted live mode back to wake', () => {
  assert.match(html, /if \(voiceMode === 'live'\) voiceMode = 'wake';/,
    'the boot-time live→wake mapping is gone — a reopened tab would come back with a hot mic');
});

test("setVoiceMode never persists 'live' to localStorage", () => {
  assert.match(html, /localStorage\.setItem\('jarvis_voice', mode === 'live' \? 'wake' : mode\)/,
    "setVoiceMode writes the raw mode again — 'live' would survive a reload");
});

// ── 2. LIVE expires while the tab is open ──────────────────────────────────
test('LIVE_MAX_MS exists and is a real bound', () => {
  const m = html.match(/const LIVE_MAX_MS *= *([\d* ]+);/);
  assert.ok(m, 'LIVE_MAX_MS is gone — live mode no longer expires');
  const ms = Function(`return (${m[1]});`)();
  assert.ok(ms > 0 && ms <= 60 * 60 * 1000,
    `LIVE_MAX_MS is ${ms} — an expiry over an hour is not a bound on an open mic`);
});

test('the watchdog actually enforces the live expiry', () => {
  assert.match(html, /voiceMode === 'live' && liveSince && Date\.now\(\) - liveSince > LIVE_MAX_MS/,
    'no watchdog check for live-mode expiry');
});

// chain resets: the name, a tap, and a physical interrupt each prove a human
test('every reset point for followChain is present', () => {
  const resets = html.match(/followChain = 0;/g) || [];
  assert.ok(resets.length >= 4,
    `expected followChain resets at wake-hit, barge-in, setVoiceMode and interruptSpeech — found ${resets.length}`);
  assert.match(html, /followChain\+\+/, 'nothing increments followChain — the cap can never fire');
});

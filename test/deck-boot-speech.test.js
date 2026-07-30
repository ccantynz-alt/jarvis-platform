// Nothing may be spoken before the mic is armed.
//
// Audio is locked until Craig's first tap, so any speak() before that sits in
// the queue and plays at the moment armVoice() opens the mic — Jarvis greeting
// himself down his own microphone. His deck reported it in his own words:
// "that's the boot chime bleeding back through again — I'm hearing my own
// greeting return down the mic... I'm already up and we're mid-conversation."
//
// These are static assertions over the shipped page rather than behavioural
// tests: the bug was a two-argument call, and that is exactly what to guard.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// Normalise line endings FIRST. On a Windows checkout git hands these files back
// as CRLF, and `.` in a JS regex does not match `\r` (it is a line terminator) —
// so the comment-stripping below silently did nothing and this suite failed on
// Craig's PC while passing on the box. A static assertion that only holds on one
// machine is worse than no assertion: it trains you to ignore a red run.
const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const script = html.slice(html.indexOf('<script'), html.lastIndexOf('</script>'));

// Boot-time addChat calls: everything after the "── Boot ──" banner runs
// immediately on load, before any user gesture can have unlocked audio.
const bootSection = script.slice(script.indexOf('// ── Boot ─'));

test('the boot greeting is text-only', () => {
  const calls = [...bootSection.matchAll(/addChat\((['"])JARVIS\1\s*,([\s\S]*?)\);/g)];
  assert.ok(calls.length > 0, 'expected at least one boot addChat — did the boot section move?');
  for (const c of calls) {
    assert.match(
      c[2], /,\s*null\s*$/,
      'a boot-time addChat must pass speechText=null; addChat speaks whenever ' +
      'speechText !== null, and a two-arg call passes undefined',
    );
  }
});

test('arming drops speech queued while audio was locked', () => {
  const arm = script.match(/function armVoice\(\) \{[\s\S]*?\n\}/);
  assert.ok(arm, 'armVoice not found');
  assert.match(arm[0], /speechQ\.length = 0/,
    'armVoice must clear the queue — playing it late is both stale and the source of the bleed');
});

test('arming attaches the analyser before opening the ear', () => {
  // Strip line comments first: these functions discuss startListening() in
  // prose above the call, and a naive indexOf matches the comment.
  const arm = script.match(/function armVoice\(\) \{[\s\S]*?\n\}/)[0]
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const attach = arm.indexOf('attachAnalyser()');
  const listen = arm.indexOf('startListening()');
  assert.notEqual(attach, -1, 'attachAnalyser() call not found in armVoice');
  assert.notEqual(listen, -1, 'startListening() call not found in armVoice');
  assert.ok(
    attach < listen,
    'echo cancellation comes from the getUserMedia stream in attachAnalyser; ' +
    'opening recognition first means the first utterance is captured without it',
  );
});

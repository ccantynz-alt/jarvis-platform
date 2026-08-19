// The live link on a phone (2026-08-19, audit move 29).
//
// Two faults, both in public/command-deck.html's WebSocket lifecycle:
//   1. "Live link established, sir. You are seeing real telemetry." was SPOKEN on
//      every onopen — on a phone whose VPN flaps or that sleeps and wakes, that
//      is the greeting every few minutes.
//   2. Nothing reacted to the page returning to the foreground: iOS kills the
//      socket in the background, and the deck then waited for the 15 s watchdog,
//      60 s of "idle", and the current backoff — up to ~105 s of RECONNECTING
//      after unlocking the phone.
//
// linkNotice() is the pure decision for (1); the static assertions cover (2).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

function extract(name) {
  const m = new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`).exec(html);
  assert.ok(m, `function ${name} not found in command-deck.html`);
  return new Function(`${m[0]}; return ${name};`)();
}
const linkNotice = extract('linkNotice');
const T = 1_700_000_000_000;

test('first connect of a page load: the greeting, spoken', () => {
  const n = linkNotice(false, 0, T);
  assert.match(n.text, /Live link established/);
  assert.equal(n.speech, undefined, 'undefined speech = addChat speaks the text');
});

test('a reconnect after a blip says nothing at all', () => {
  assert.equal(linkNotice(true, T - 20_000, T), null);
  assert.equal(linkNotice(true, 0, T), null);
});

test('a reconnect after a real gap: a QUIET chat line naming the gap', () => {
  const n = linkNotice(true, T - 5 * 60_000, T);
  assert.match(n.text, /Link restored after 5 minutes/);
  assert.equal(n.speech, null, 'null speech = addChat stays silent');
  assert.match(linkNotice(true, T - 61_000, T).text, /after 1 minute\./);
});

test('the greeting is no longer a bare two-argument addChat in onopen', () => {
  const onopen = html.slice(html.indexOf('sock.onopen = () => {'), html.indexOf('sock.onmessage'));
  assert.doesNotMatch(onopen, /addChat\(['"]MARCO['"],\s*['"]Live link established/);
  assert.match(onopen, /linkNotice\(/);
});

test('the page reconnects on foreground / bfcache restore / network return', () => {
  assert.match(html, /document\.addEventListener\('visibilitychange',\s*\(\)\s*=>\s*\{\s*if\s*\(!document\.hidden\)\s*nudgeLink\(\)/);
  assert.match(html, /window\.addEventListener\('pageshow'/);
  assert.match(html, /window\.addEventListener\('online',\s*nudgeLink\)/);
});

test('socket handlers are scoped to THEIR socket, so a superseded one cannot schedule a second connection', () => {
  assert.match(html, /const sock = ws;/);
  assert.match(html, /sock\.onclose = \(\) => \{\s*if \(sock !== ws\) return;/);
});

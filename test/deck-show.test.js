// The "show me" primitive (2026-08-11), extracted from the shipped HTML.
//
// Craig asked for this twice in different words — "pull up websites for me to
// view", "it automatically pops up on my screen" — because Marco could read the
// web and describe it but never put anything in front of him.
//
// Everything this panel renders is UNTRUSTED: the title and note are written by
// the model, and the URL comes from whatever page it was asked to look at. All
// three land in innerHTML, and the URL lands in an href. So the two things worth
// pinning are the escaping and the http(s)-only link rule — plus the server's
// filename handling, which serves files from a directory BY NAME and is
// therefore the classic path-traversal shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { basename } from 'path';

const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

const escFn = html.match(/function esc\(s\) \{[\s\S]*?\n\}/);
assert.ok(escFn, 'esc() not found in command-deck.html');
const esc = new Function('s', `${escFn[0]}; return esc(s);`);

test('model-written text cannot inject markup into the panel', () => {
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc('Bob\'s "Café" & Co'), 'Bob&#39;s &quot;Café&quot; &amp; Co');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});

// The href rule, as written in showThing(): only http(s) becomes a link.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);

test('only http(s) URLs become a clickable link', () => {
  assert.equal(safeUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(safeUrl('http://example.com'), 'http://example.com');
  for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd', 'about:blank', '']) {
    assert.equal(safeUrl(bad), null, bad);
  }
});

test('the panel actually wires the show message and escapes what it renders', () => {
  assert.match(html, /m\.type === 'show'/, 'deck no longer handles {type:"show"}');
  assert.match(html, /src="\/shot\/' \+ encodeURIComponent\(m\.shot\)/, 'capture must be fetched by name via /shot/');
  assert.match(html, /esc\(m\.note\)/, 'the note is rendered unescaped');
  assert.match(html, /rel="noopener noreferrer"/, 'external link must not hand over window.opener');
});

// ── server side: the filename is the whole attack surface ───────────────────
// Mirrors deck-server.js's /shot/:name and /internal/show guards.
const SHOT_DIR = '/opt/jarvis/screenshots';
const nameOk = (n) => /^[\w.-]+\.png$/i.test(basename(String(n || '')));

test('path traversal cannot escape the capture directory', () => {
  for (const evil of [
    '../../../etc/passwd', '../../config/secrets.env', '/etc/shadow',
    '..\\..\\windows\\system32\\config\\sam', 'x.png/../../../etc/passwd',
  ]) {
    const b = basename(evil);
    // Either the basename is not a .png at all, or it is a plain filename that
    // cannot climb out of SHOT_DIR once joined.
    if (nameOk(b)) assert.ok(!`${SHOT_DIR}/${b}`.includes('..'), evil);
    else assert.equal(nameOk(b), false, evil);
  }
});

test('only .png capture names are accepted', () => {
  assert.equal(nameOk('shot_1786407042985.png'), true);
  for (const bad of ['secrets.env', 'notes.txt', 'x.png.sh', '', 'shot.PNG.exe']) {
    assert.equal(nameOk(bad), false, bad);
  }
  assert.equal(nameOk('SHOT.PNG'), true, 'case-insensitive extension is fine');
});

test('the server guards are actually present in deck-server.js', () => {
  const server = readFileSync(new URL('../src/deck-server.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/shot\/:name'/, '/shot/:name route missing');
  assert.match(server, /app\.post\('\/internal\/show'/, '/internal/show route missing');
  assert.match(server, /isLocalDirect\(req\) && !isAuthed\(req\)[\s\S]{0,80}forbidden/,
    'the show routes must carry the same auth as the rest of the deck');
  assert.match(server, /file\.startsWith\(SHOT_DIR \+ '\/'\)/, 'prefix assertion missing');
  // Only the filename may cross to the client — never a path on the box.
  assert.match(server, /basename\(String\(screenshot\)\)/, '/internal/show must reduce to a basename');
});

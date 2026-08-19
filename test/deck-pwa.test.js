// PWA plumbing for the deck (2026-08-19, audit move 28).
//
// The manifest was behind the page's auth and the <link> carried no
// crossorigin="use-credentials", so browsers (which fetch manifests without
// cookies) got a 403: Chrome never offered a real install; iOS fell back to the
// apple-* meta tags with whatever URL it was on. And a phone off the tailnet got
// Safari's "server cannot be found" with no hint that Tailscale was the fix.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const html = read('../public/command-deck.html');
const manifest = JSON.parse(read('../public/deck.webmanifest'));
const sw = read('../public/sw.js');
const server = read('../src/deck-server.js');

test('manifest: installable shape — id, scope, start_url, standalone, icons, shortcuts', () => {
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(i => i.sizes === '512x512'));
  assert.ok(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length >= 2);
  for (const s of manifest.shortcuts) assert.match(s.url, /^\/\?view=(core|hud|org|flow|plat|ops)$/);
});

test('the manifest link sends credentials (belt) and the manifest route is public (braces)', () => {
  assert.match(html, /<link rel="manifest" href="\/deck\.webmanifest" crossorigin="use-credentials">/);
  const route = server.slice(server.indexOf("app.get('/deck.webmanifest'"), server.indexOf("app.get('/icons/:file'"));
  assert.doesNotMatch(route, /isAuthed/, 'manifest must not be behind the page auth');
  const icons = server.slice(server.indexOf("app.get('/icons/:file'"), server.indexOf("app.get('/sw.js'"));
  assert.doesNotMatch(icons, /isAuthed/, 'icons must not be behind the page auth');
  assert.match(icons, /\/\^deck-\\d\+\\\.png\$\//, 'icon filenames stay allow-listed');
});

test('service worker: parses, is registered by the page, and never caches the shell', () => {
  assert.doesNotThrow(() => new Function(sw));
  assert.match(html, /navigator\.serviceWorker\.register\('\/sw\.js'\)/);
  assert.match(sw, /req\.mode === 'navigate'/);
  assert.match(sw, /Open <b>Tailscale<\/b>/, 'the offline page names the fix');
  // Navigation responses are never put in the cache — only the STATIC list is.
  assert.doesNotMatch(sw, /caches\.open\([^)]*\)\.then\(c => c\.put\(req, r\.clone\(\)\)\)[\s\S]*mode === 'navigate'/);
  assert.match(sw, /STATIC\.includes\(url\.pathname\)/);
});

test('the worker is skipped for headless/QA renders', () => {
  assert.match(html, /if \('serviceWorker' in navigator && !WS_DISABLED && !SIM_MODE\)/);
});

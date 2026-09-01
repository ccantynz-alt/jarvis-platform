// The render leg's binary resolution + honest health (2026-08-30,
// docs/RENDER-AUDIT-2026-08-30.md).
//
// The incident this carries: /browser/render failed EVERY call for weeks —
// bare CHROMIUM_BIN name, then nothing verifying the binary at all — while
// /browser/health answered a static {status:'ok'}, checkShowMe reported
// "capture path healthy", npm test was green, and Craig was the only
// detector. No test in the repo touched browser-service or Chrome; this one
// pins the pure halves so that failure class cannot ship silently again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { resolveChrome, chromeStatus } from '../src/lib/browser-health.js';

// A fake filesystem: stat() succeeds only for paths in `files`.
const statFor = (files) => (p) => {
  if (files.includes(p)) return { isFile: () => true };
  const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e;
};

test('an absolute CHROMIUM_BIN is trusted as-is', () => {
  const env = { CHROMIUM_BIN: '/usr/bin/chromium', PATH: '/usr/bin' };
  assert.equal(resolveChrome(env, statFor([])), '/usr/bin/chromium');
});

test('a bare name resolves through PATH — the secrets.env shape that broke every render', () => {
  const env = { CHROMIUM_BIN: 'google-chrome', PATH: '/usr/local/bin:/usr/bin' };
  assert.equal(resolveChrome(env, statFor(['/usr/bin/google-chrome'])), '/usr/bin/google-chrome');
});

test('a bare name falls through to the known install locations', () => {
  const env = { CHROMIUM_BIN: 'chromium-browser', PATH: '/nowhere' };
  assert.equal(resolveChrome(env, statFor(['/usr/bin/chromium'])), '/usr/bin/chromium');
});

test('an unresolvable bare name comes back unchanged so chromeStatus can fail it loudly', () => {
  const env = { CHROMIUM_BIN: 'google-chrome', PATH: '/usr/bin' };
  const resolved = resolveChrome(env, statFor([]));
  assert.equal(resolved, 'google-chrome');
  const s = chromeStatus(resolved, statFor([]));
  assert.equal(s.ok, false);
  assert.match(s.reason, /no such file/);
});

test('chromeStatus is positive evidence: a real file passes, a missing one names itself', () => {
  assert.deepEqual(chromeStatus('/usr/bin/chromium', statFor(['/usr/bin/chromium'])), { ok: true, reason: null });
  const s = chromeStatus('/usr/bin/google-chrome', statFor([]));
  assert.equal(s.ok, false);
  assert.match(s.reason, /\/usr\/bin\/google-chrome/);
});

test('the health route actually consults chromeStatus and answers 503 when Chrome is broken', () => {
  // Source-level pin, same style as deck-show.test.js's server-guard checks:
  // the service file must wire the honest pieces, not reinvent a static 200.
  const text = readFileSync(new URL('../src/browser-service.js', import.meta.url), 'utf8');
  assert.match(text, /from '\.\/lib\/browser-health\.js'/, 'service must use the shared resolution logic');
  assert.match(text, /chromeStatus\(CHROME\)/, 'health must stat the binary');
  assert.match(text, /503/, 'a broken Chrome must be a non-200 health answer');
  assert.match(text, /deep/, 'the deep launch probe must exist for experience-check');
});

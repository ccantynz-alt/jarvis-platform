/**
 * Chrome resolution + honest launch-path health for browser-service.
 *
 * Extracted from browser-service.js (2026-08-30 render audit,
 * docs/RENDER-AUDIT-2026-08-30.md): the render leg is the only leg with a
 * hard external-binary dependency, and it failed invisibly for weeks because
 * /browser/health never looked at the binary. A check passes only on positive
 * evidence — something answered — never because nothing threw (LESSONS).
 */

import { statSync } from 'fs';

/**
 * Playwright's executablePath needs an ABSOLUTE path — unlike screenshot-
 * service.js, which spawn()s the same CHROMIUM_BIN and gets PATH resolution
 * for free. secrets.env shipped CHROMIUM_BIN=google-chrome (a bare name), so
 * /browser/render failed EVERY call with "executable doesn't exist at
 * google-chrome" while screenshot capture kept working — the brain simply had
 * no working eyes on the web. Resolve a bare name against PATH + the usual
 * install locations.
 *
 * env/stat are injectable so the regression tests can exercise every branch
 * without a real Chrome on the test machine.
 */
export function resolveChrome(env = process.env, stat = statSync) {
  const want = env.CHROMIUM_BIN || '/usr/bin/google-chrome';
  if (want.includes('/')) return want;                 // already a path — trust it
  const dirs = (env.PATH || '').split(':').filter(Boolean);
  const candidates = [
    ...dirs.map(d => `${d}/${want}`),
    `/usr/bin/${want}`, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/google-chrome',
  ];
  for (const c of candidates) { try { if (stat(c).isFile()) return c; } catch {} }
  return want; // nothing found — chromeStatus() below reports it loudly
}

/**
 * Positive evidence that the resolved binary exists as a file. This is the
 * cheap half of the health story (the expensive half — actually launching it —
 * lives behind /browser/health?deep=1). A bare name that resolveChrome()
 * failed to resolve fails here, per request AND per health probe, instead of
 * only at launch time inside a 502 nobody reads.
 */
export function chromeStatus(path, stat = statSync) {
  try {
    if (stat(path).isFile()) return { ok: true, reason: null };
    return { ok: false, reason: `${path} exists but is not a file` };
  } catch {
    return { ok: false, reason: `no such file: ${path}` };
  }
}

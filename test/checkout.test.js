/**
 * test/checkout.test.js — the guard that stops an audit inventing a score.
 *
 * Found 2026-07-30 by the code-health spine's config/deploy lens, with artifacts:
 * ZOOBICON_PATH=/var/www/zoobicon and ALECRAE_PATH=/var/www/alecrae, on a box
 * where /var/www does not exist. The dead path went to spawnSync as cwd, the
 * resulting 'spawnSync /bin/sh ENOENT' matched none of extractErrors()' patterns
 * so errors=[], the arithmetic gave 100-20-10 = 70 → 'warning', and the notifier
 * only speaks for 'critical'. Craig's flagship and AlecRae were audited every day
 * for weeks and the answer was fabricated, silently.
 *
 * The cases below are the ones that actually occurred, plus the near-miss that an
 * existsSync-only guard would have waved through.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutProblem, BUILD_MANIFESTS } from '../src/lib/checkout.js';

/** Describe a filesystem by listing what exists, rather than creating it. */
const fsWith = (paths) => ({
  exists: (p) => paths.includes(p.replace(/\\/g, '/')),
  isDir: (p) => paths.includes(p.replace(/\\/g, '/')) && !/\.\w+$/.test(p),
});

test('a path that does not exist is refused, and says so', () => {
  const problem = checkoutProblem({ path: '/var/www/alecrae' }, fsWith([]));
  assert.match(problem, /\/var\/www\/alecrae does not exist/);
});

test('a real checkout with a package.json passes', () => {
  const problem = checkoutProblem(
    { path: '/opt/alecrae' },
    fsWith(['/opt/alecrae', '/opt/alecrae/package.json']),
  );
  assert.equal(problem, null);
});

test('a directory that exists but holds no source is refused — the zoobicon case', () => {
  // /root/zoobicon exists (config/platforms.json points at it) and contains
  // nothing but a .claude folder. An existsSync-only guard passes this, the build
  // then fails for a reason nobody reads, and the score is invented anyway.
  const problem = checkoutProblem(
    { path: '/root/zoobicon' },
    fsWith(['/root/zoobicon', '/root/zoobicon/.claude']),
  );
  assert.match(problem, /no build manifest/);
  assert.match(problem, /not a usable checkout/);
});

test('a file where a directory should be is refused', () => {
  const problem = checkoutProblem(
    { path: '/root/notes.txt' },
    { exists: () => true, isDir: () => false },
  );
  assert.match(problem, /is not a directory/);
});

test('an unset path is refused rather than treated as the current directory', () => {
  // `cwd: undefined` means spawnSync inherits /opt/jarvis, so a missing config
  // value would have audited JARVIS instead of the platform and reported the
  // result under the platform's name.
  assert.equal(checkoutProblem({}, fsWith([])), 'no path configured');
  assert.equal(checkoutProblem({ path: '' }, fsWith([])), 'no path configured');
  assert.equal(checkoutProblem(undefined, fsWith([])), 'no path configured');
});

test('every supported stack on the estate counts as buildable', () => {
  // Rust and Python matter here: voxlen is Tauri, universal-ai-operator is
  // CrewAI/Python, and neither has a package.json at its root.
  for (const manifest of BUILD_MANIFESTS) {
    const problem = checkoutProblem(
      { path: '/root/thing' },
      fsWith(['/root/thing', `/root/thing/${manifest}`]),
    );
    assert.equal(problem, null, `${manifest} should count as a buildable checkout`);
  }
});

test('the real filesystem is used when no injection is given', () => {
  // Guards against the injection seam quietly becoming mandatory.
  assert.match(checkoutProblem({ path: '/definitely/not/here/at/all' }), /does not exist/);
});

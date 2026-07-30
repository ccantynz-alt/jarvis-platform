/**
 * Jarvis — src/lib/checkout.js
 *
 * One question, asked before any audit runs: is this platform's checkout
 * something a build could actually act on?
 *
 * Extracted from audit-runner.js so it can be tested. audit-runner.js exports
 * nothing and starts an express listener, so importing it from a test is not an
 * option — the same trap that made `import` of pc-worker.js kill the test runner.
 *
 * Why this function exists at all (2026-07-30, found by the code-health spine's
 * config/deploy lens, with artifacts): ZOOBICON_PATH=/var/www/zoobicon and
 * ALECRAE_PATH=/var/www/alecrae, and /var/www does not exist on this box. The
 * dead path went to spawnSync as cwd, so every daily audit recorded
 * build={ok:false, output:'spawnSync /bin/sh ENOENT'}; extractErrors() matched
 * nothing in that string, so errors=[]; the score came out to a tidy
 * 100-20-10 = 70 → 'warning'; and the notifier only speaks for 'critical'. Two
 * platforms, one of them the flagship, were audited daily for weeks and the
 * answer was a fabricated number, arrived at in silence.
 *
 * A wrong number that looks plausible is worse than no number, because it is
 * indistinguishable from a real one. This returns a reason string — never a
 * score — and the caller's job is to report that reason loudly.
 */

import { existsSync, statSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Files that mean "something here can be built or tested". An empty directory is
 * the specific trap zoobicon fell into: `/root/zoobicon` exists (so an
 * existsSync-only guard passes) but holds nothing except a `.claude` folder, and
 * the build then fails for a reason nobody reads.
 */
export const BUILD_MANIFESTS = [
  'package.json',       // node / bun
  'docker-compose.yml',
  'docker-compose.yaml', // same thing, other spelling — do not make a platform
  'compose.yml',         // invisible to the audit over a file extension
  'compose.yaml',
  'Dockerfile',         // `docker build .` is a real build even with no compose file
  'Cargo.toml',         // rust (voxlen's tauri side)
  'pyproject.toml',
  'requirements.txt',
  'go.mod',
  'Makefile',
];

/**
 * @param {{path?: string}} config  the platform's audit config
 * @param {{exists?: (p: string) => boolean, isDir?: (p: string) => boolean}} [fs]
 *        injectable for tests, so a case can be described without creating it
 * @returns {string|null} a human-readable reason it cannot be audited, or null
 *          when the checkout is usable
 */
export function checkoutProblem(config, fs = {}) {
  const exists = fs.exists || existsSync;
  const isDir = fs.isDir || ((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });

  const path = config?.path;
  if (!path) return 'no path configured';
  if (!exists(path)) return `${path} does not exist on this box`;
  if (!isDir(path)) return `${path} is not a directory`;

  if (!BUILD_MANIFESTS.some((f) => exists(join(path, f)))) {
    return `${path} contains no build manifest (looked for ${BUILD_MANIFESTS.slice(0, 3).join(', ')}…) — it is not a usable checkout`;
  }
  return null;
}

/**
 * Is there any source code in here at all?
 *
 * A different question from checkoutProblem() above, and it needs to be: that one
 * asks "could this be BUILT" (a manifest), which is right for the audit runner. The
 * code-health spine only READS code, so a directory of loose .py files with no
 * manifest is perfectly reviewable and must not be excluded.
 *
 * Written 2026-07-30 after watching the spine's own timer waste a sweep. It picked
 * `zoobicon` at /root/zoobicon — a directory containing nothing but a `.claude`
 * folder — logged "NOT a git checkout, no commit recorded", spent a review agent,
 * returned zero findings in 25 seconds, and then RECORDED THE PLATFORM AS SWEPT.
 * So Craig's flagship would have shown as reviewed, with a 20-hour cooldown before
 * anything looked again, having never been read. eligiblePlatforms() checked that
 * the path existed and stopped there — the same mistake, in a second place, that
 * the audit runner made with /var/www.
 *
 * Shallow on purpose: two levels is plenty to tell a repository from an empty
 * folder, and this runs on every sweep.
 */
export const SOURCE_RE = /\.(js|mjs|cjs|jsx|ts|tsx|py|rs|go|rb|php|java|kt|swift|sh|sql|html|css|scss|vue|svelte|toml|tf)$/i;
const SCAN_SKIP = new Set([
  'node_modules', '.git', 'venv', '.venv', 'env', 'dist', 'build', 'out',
  '.next', '__pycache__', 'target', 'vendor', '.turbo', 'coverage', '.claude',
]);

export function hasSource(dir, { readdir = readdirSync, depth = 2 } = {}) {
  let entries;
  try { entries = readdir(dir, { withFileTypes: true }); } catch { return false; }
  const subdirs = [];
  for (const e of entries) {
    const name = e.name;
    if (e.isDirectory?.()) {
      if (!SCAN_SKIP.has(name) && !name.startsWith('.')) subdirs.push(join(dir, name));
    } else if (SOURCE_RE.test(name)) {
      return true;
    }
  }
  if (depth <= 1) return false;
  return subdirs.some((d) => hasSource(d, { readdir, depth: depth - 1 }));
}

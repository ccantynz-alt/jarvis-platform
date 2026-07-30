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

import { existsSync, statSync } from 'fs';
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

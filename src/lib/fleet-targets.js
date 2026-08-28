/**
 * Jarvis — src/lib/fleet-targets.js
 *
 * WHICH URLs fleet-check probes, derived from THE registry.
 *
 * Why this exists (2026-08-28, Craig: "how do we keep jarvis/marco
 * synchronised with the platforms"): scripts/fleet-check.sh carried its own
 * hardcoded `FLEET=` list — the exact thing CLAUDE.md forbids ("the platform
 * registry is config/platforms.json; read it, never trust a list in a doc").
 * That list and the registry had drifted three ways at once:
 *
 *   - `marco-demo`, the first platform the build pipeline ever produced, was
 *     registered at birth on 2026-08-25 with a site_url — and never probed.
 *     Its platform_state row still read `unknown / health 0 / 2026-08-25T13:41`
 *     three days later. CLAUDE.md claimed "the fleet watches the newborn".
 *     The fleet had never once looked at it.
 *   - `gatetest-mcp` was probed but is not a registry key at all — a phantom
 *     platform_state row no config could explain.
 *   - `davenroe` was probed at www.davenroe.com while the registry declared
 *     davenroe.com. Two spellings of one claim, neither checked against the
 *     other.
 *
 * So: registered and watched are now the same word. Adding a platform to the
 * registry monitors it; there is no second list to remember.
 *
 * Preference is site_url THEN health_url, deliberately. fleet-check probes
 * "the platform's REAL public presence (the site the owner cares about), so
 * dashboard numbers match reality" — vapron carries both a public site and a
 * tailnet health endpoint, and preferring the health endpoint would quietly
 * turn the fleet's headline number for vapron into something no customer can
 * see. health_url is the fallback for things with no public face (jarvis).
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

/** A platform is watched unless it opts out or is not active. */
export function isWatched(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.monitor === false) return false;              // non-products: forks, scratch checkouts
  if (p.status && p.status !== 'active') return false; // retired/paused platforms are not faults
  return true;
}

const isProbeUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);

/**
 * @param {object} registry  the parsed config/platforms.json
 * @returns {{name: string, url: string, platform: string}[]}
 *   `name` is the platform_state row written; `platform` is the registry key
 *   it came from. They differ only for a declared extra probe (gatetest-mcp).
 */
export function fleetTargets(registry) {
  const platforms = (registry && registry.platforms) || {};
  const out = [];
  const seen = new Set();

  const push = (name, url, platform) => {
    // One row, one verdict per tick. A duplicate name would write two
    // conflicting statuses to the same row and the last one would win at
    // random — the platform_state last-writer-wins trap in miniature.
    if (!isProbeUrl(url) || seen.has(name)) return;
    seen.add(name);
    out.push({ name, url, platform });
  };

  for (const [name, p] of Object.entries(platforms)) {
    if (!isWatched(p)) continue;

    // A platform with more than one endpoint worth watching declares them
    // itself (`probes: { "<row>": "<url>" }`) rather than being special-cased
    // in the script. Declaring replaces the default — the platform's own site
    // must appear in the map if it should still be probed.
    if (p.probes && typeof p.probes === 'object' && !Array.isArray(p.probes)) {
      for (const [row, url] of Object.entries(p.probes)) push(row, url, name);
      continue;
    }

    push(name, p.site_url || p.health_url, name);
  }

  return out;
}

/** The `name|url` lines fleet-check.sh reads. Registry order, stable per tick. */
export function formatTargets(targets) {
  return targets.map(t => `${t.name}|${t.url}`).join('\n');
}

// CLI: `node src/lib/fleet-targets.js [registry.json]` — the shape fleet-check
// consumes. Exits non-zero on an unreadable or empty registry so the caller can
// shout instead of silently probing nothing (doctrine: fail loud and free).
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  const path = process.argv[2] || resolve(thisFile, '../../../config/platforms.json');
  let targets = [];
  try {
    targets = fleetTargets(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    process.stderr.write(`fleet-targets: cannot read ${path}: ${e.message}\n`);
    process.exit(2);
  }
  if (!targets.length) {
    process.stderr.write(`fleet-targets: registry ${path} declares no probeable platform\n`);
    process.exit(3);
  }
  process.stdout.write(formatTargets(targets) + '\n');
}

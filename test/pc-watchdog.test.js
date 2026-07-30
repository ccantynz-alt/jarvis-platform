// test/pc-watchdog.test.js — the PC worker's off-box watchdog, 2026-07-30.
//
// Craig's PC already talks to the gateway every 10 seconds from outside the
// fleet, which makes it the lowest-latency box-death detector available. It is
// needed because the GitHub Actions watchdog asks for every 5 minutes and
// measurably gets about once an hour.
//
// The risk is not missing an outage, it is crying wolf: a failed claim usually
// means his wifi dropped or tailscale restarted, not that the box died. Blaming
// the box for his own network would be the alert that teaches him to ignore
// alerts, so the three-way classification is what actually matters here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutage } from '../src/pc-worker.js';

test('nothing wrong when the gateway answers', () => {
  assert.equal(classifyOutage({ gatewayOk: true, publicOk: false, internetOk: false }), 'ok',
    'a working gateway settles it — the other probes do not matter');
});

test('no internet from this PC blames nothing — it is our end', () => {
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: false, internetOk: false }), 'local');
});

test('internet fine, public port dead = the box really is down', () => {
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: false, internetOk: true }), 'box-down');
});

test('public port answers but the gateway does not = tailnet or service, box alive', () => {
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: true, internetOk: true }), 'tailnet');
});

test('a dead public port with no internet is still LOCAL, never box-down', () => {
  // The dangerous misread: both probes fail because the PC is offline, and we
  // announce a box death that never happened.
  assert.equal(classifyOutage({ gatewayOk: false, publicOk: false, internetOk: false }), 'local');
});

// ── Importing this module must never end the importing process (2026-07-30) ───
// The missing-token check was at module scope with a process.exit(1) beside it,
// so `import { classifyOutage } from '../src/pc-worker.js'` — the line at the top
// of this very file — killed the test runner on any machine without a worker
// token. It passed on Craig's PC, which has one in config/pc-worker.env, and
// failed on the box, which is where deployments get verified. Same family as the
// module-scope `loop()` call fixed earlier the same day: importing a program
// should not run it.

test('importing pc-worker.js with no token configured exits cleanly', async () => {
  const { spawnSync } = await import('child_process');
  const os = await import('os');
  const { pathToFileURL } = await import('url');
  const path = await import('path');

  const url = pathToFileURL(path.resolve('src/pc-worker.js')).href;
  const env = { ...process.env };
  delete env.JARVIS_WORKER_TOKEN;

  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(url)}); console.log('IMPORTED');`], {
    // cwd away from the repo so config/pc-worker.env is not picked up either —
    // the loader reads it relative to process.cwd().
    cwd: os.tmpdir(), env, encoding: 'utf8', timeout: 30_000,
  });

  assert.equal(r.status, 0, `import should not exit non-zero (stderr: ${(r.stderr || '').trim()})`);
  assert.match(r.stdout || '', /IMPORTED/, 'and the module body should finish evaluating');
});

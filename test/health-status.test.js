// test/health-status.test.js — who may clear an outage flag, 2026-07-30.
//
// platform_state.status has two writers that mean different things by it:
// fleet-check.sh writes 'error' when the public URL stops answering (the signal
// self-heal acts on), audit-runner writes 'healthy' when a build and its tests
// pass. Last writer wins, so an audit landing during an outage used to erase the
// very flag the repair depends on — silently, with the site still down.
//
// This is the function that decides that, so it is tested directly rather than
// through a service that opens SQLite at import.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuditStatus, jobWritesPlatformHealth } from '../src/lib/health-status.js';

const up = [{ url: 'https://x', status: 200, ok: true }];
const down = [{ url: 'https://x', status: 503, ok: false }];

test('a passing build does NOT clear an outage flag — the bug', () => {
  const r = resolveAuditStatus({ existingStatus: 'error', reportStatus: 'healthy', http: null });
  assert.equal(r.status, 'error');
  assert.equal(r.preserved, true);
  assert.match(r.reason, /never probed/);
});

test('a probe that proves the site is up DOES clear it', () => {
  const r = resolveAuditStatus({ existingStatus: 'error', reportStatus: 'healthy', http: up });
  assert.equal(r.status, 'healthy');
  assert.equal(r.preserved, false);
  assert.match(r.reason, /proved the site is up/);
});

test('a probe that fails keeps the outage flag', () => {
  const r = resolveAuditStatus({ existingStatus: 'error', reportStatus: 'healthy', http: down });
  assert.equal(r.status, 'error');
  assert.equal(r.preserved, true);
});

test('a partly-failing probe is not proof of health', () => {
  const r = resolveAuditStatus({
    existingStatus: 'error', reportStatus: 'healthy',
    http: [{ ok: true }, { ok: false }],
  });
  assert.equal(r.status, 'error', 'every probed URL must answer, not just one');
});

test('an empty probe array is not proof of anything', () => {
  const r = resolveAuditStatus({ existingStatus: 'error', reportStatus: 'healthy', http: [] });
  assert.equal(r.status, 'error');
});

test('the audit still reports its own bad news unchanged', () => {
  for (const reportStatus of ['critical', 'warning']) {
    const r = resolveAuditStatus({ existingStatus: 'error', reportStatus, http: up });
    assert.equal(r.status, reportStatus, 'a failing build is never upgraded by a passing probe');
    assert.equal(r.preserved, false);
  }
});

test('with no outage on record the audit writes what it found', () => {
  for (const existingStatus of ['healthy', 'warning', 'unknown', null]) {
    const r = resolveAuditStatus({ existingStatus, reportStatus: 'healthy', http: null });
    assert.equal(r.status, 'healthy', `existing=${existingStatus}`);
    assert.equal(r.preserved, false);
  }
});

test('malformed probe rows cannot fake proof of health', () => {
  for (const http of [[null], [undefined], [{}], ['200']]) {
    const r = resolveAuditStatus({ existingStatus: 'error', reportStatus: 'healthy', http });
    assert.equal(r.status, 'error', JSON.stringify(http));
  }
});

// ── The third writer: orchestrator's per-job outcome (2026-08-10) ───────────
//
// A refused PC verb marked the whole machine down. The harvester's hourly
// harvest.list hit a PC worker running older code, was refused as an unknown
// verb, and each refusal wrote craig-pc status:'error' — which self-heal then
// alerted on every 5 minutes at `alert` level (exempt from push dedupe AND the
// hourly cap). 235 phone pushes in 48 hours, about a machine that was fine.

test('a real platform job may write health', () => {
  assert.equal(jobWritesPlatformHealth({ platform: 'gluecron', runtime: 'claude' }), true);
  assert.equal(jobWritesPlatformHealth({ platform: 'gluecron' }), true, 'runtime defaults to a claude job');
});

test('a typed PC action NEVER writes health — the 2026-08-10 flood', () => {
  assert.equal(jobWritesPlatformHealth({ platform: 'craig-pc', runtime: 'action' }), false);
  // the exact row that caused it: a refused harvest verb
  assert.equal(jobWritesPlatformHealth({ platform: 'craig-pc', runtime: 'action', status: 'failed' }), false);
});

test('a role-agent job never writes health (a draft post is not uptime)', () => {
  assert.equal(jobWritesPlatformHealth({ platform: 'davenroe', agent: 'social-media-davenroe' }), false);
  assert.equal(jobWritesPlatformHealth({ platform: 'davenroe', agent: 'site-medic-davenroe', runtime: 'claude' }), false);
});

test('a missing row cannot write health', () => {
  assert.equal(jobWritesPlatformHealth(null), false);
  assert.equal(jobWritesPlatformHealth(undefined), false);
});

// Internal auth boundary on the loopback control plane (2026-08-19, move 11).
//
// :9200/:9205 bind loopback, which stops the internet but not co-tenant
// processes on the shared box. A shared token — held by every Jarvis service,
// not by a co-tenant — gates the three sensitive mutations (approve proposal,
// write finding, dispatch job) while leaving reads and benign writes open.

import test from 'node:test';
import assert from 'node:assert/strict';
import { installInternalAuth, internalGuard, internalAuthConfigured } from '../src/lib/internal-http.js';

function res() {
  return { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const req = (headers = {}) => ({ method: 'POST', path: '/x', headers, socket: { remoteAddress: '127.0.0.1' } });

test('with no token set the guard fails OPEN (a rollout cannot brick the fleet)', () => {
  delete process.env.JARVIS_INTERNAL_TOKEN;
  assert.equal(internalAuthConfigured(), false);
  let called = false;
  internalGuard(req(), res(), () => { called = true; });
  assert.equal(called, true);
});

test('with a token set, a request WITHOUT it is refused', () => {
  process.env.JARVIS_INTERNAL_TOKEN = 'secret-xyz';
  const r = res();
  let called = false;
  internalGuard(req({}), r, () => { called = true; });
  assert.equal(called, false);
  assert.equal(r.code, 403);
  delete process.env.JARVIS_INTERNAL_TOKEN;
});

test('with a token set, the matching header passes', () => {
  process.env.JARVIS_INTERNAL_TOKEN = 'secret-xyz';
  let called = false;
  internalGuard(req({ 'x-jarvis-internal': 'secret-xyz' }), res(), () => { called = true; });
  assert.equal(called, true);
  delete process.env.JARVIS_INTERNAL_TOKEN;
});

test('a wrong token is refused', () => {
  process.env.JARVIS_INTERNAL_TOKEN = 'secret-xyz';
  const r = res();
  internalGuard(req({ 'x-jarvis-internal': 'guessed' }), r, () => {});
  assert.equal(r.code, 403);
  delete process.env.JARVIS_INTERNAL_TOKEN;
});

test('the outgoing patch injects the header for loopback :9200/:9205 only', async () => {
  process.env.JARVIS_INTERNAL_TOKEN = 'tok-123';
  const seen = [];
  globalThis.fetch = async (input, init) => { seen.push({ url: String(input), h: new Headers(init?.headers || {}) }); return { ok: true }; };
  installInternalAuth();
  await globalThis.fetch('http://127.0.0.1:9200/memory/kv');
  await globalThis.fetch('http://127.0.0.1:9205/dispatch', { method: 'POST' });
  await globalThis.fetch('https://example.com/api', { method: 'POST' });   // external — untouched
  await globalThis.fetch('http://127.0.0.1:9211/browser/search', { method: 'POST' }); // other Jarvis port — untouched
  assert.equal(seen[0].h.get('x-jarvis-internal'), 'tok-123');
  assert.equal(seen[1].h.get('x-jarvis-internal'), 'tok-123');
  assert.equal(seen[2].h.get('x-jarvis-internal'), null);
  assert.equal(seen[3].h.get('x-jarvis-internal'), null);
  delete process.env.JARVIS_INTERNAL_TOKEN;
});

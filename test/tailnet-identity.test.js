import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowlist, tailnetIdentity } from '../src/lib/tailnet-identity.js';

const CRAIG = 'ccantynz@gmail.com';
const viaProxy = (extra = {}) => ({ 'x-forwarded-for': '100.111.46.68', ...extra });

test('parseAllowlist: comma/space separated, trimmed, lower-cased, empties dropped', () => {
  assert.deepEqual(parseAllowlist(' Ccantynz@Gmail.com, other@x.io  third@y.z '),
    ['ccantynz@gmail.com', 'other@x.io', 'third@y.z']);
  assert.deepEqual(parseAllowlist(''), []);
  assert.deepEqual(parseAllowlist(undefined), []);
});

test('the 2026-08-19 incident: the iPhone, identified by Tailscale, is let in', () => {
  // Exactly the headers behind "[deck] 403 for 100.111.46.68 (ccantynz@gmail.com)".
  assert.equal(tailnetIdentity(viaProxy({ 'tailscale-user-login': CRAIG }), [CRAIG]), CRAIG);
});

test('login match is case-insensitive', () => {
  assert.equal(tailnetIdentity(viaProxy({ 'tailscale-user-login': 'CCantynz@Gmail.COM' }), [CRAIG]), CRAIG);
});

test('a different tailnet user is refused', () => {
  assert.equal(tailnetIdentity(viaProxy({ 'tailscale-user-login': 'stranger@example.com' }), [CRAIG]), null);
});

test('tagged nodes (no user login) fall through to the token path', () => {
  assert.equal(tailnetIdentity(viaProxy(), [CRAIG]), null);
  assert.equal(tailnetIdentity(viaProxy({ 'tailscale-user-login': '' }), [CRAIG]), null);
});

test('empty allowlist = feature off, even with a perfect header', () => {
  assert.equal(tailnetIdentity(viaProxy({ 'tailscale-user-login': CRAIG }), []), null);
});

test('a request that did not come through the serve proxy is never identity-authed', () => {
  // No X-Forwarded-For: that is a raw loopback call (or something pretending to
  // be one); isLocalDirect() owns that decision, not this function.
  assert.equal(tailnetIdentity({ 'tailscale-user-login': CRAIG }, [CRAIG]), null);
});

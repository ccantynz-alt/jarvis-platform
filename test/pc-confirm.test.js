// Server-side gate for mutating PC actions (2026-08-19, audit move 37).
//
// `/pc/action` enqueued any verb it was given; mutating ones were gated only in
// the conversational layer, so a prompt-injected fleet agent with loopback
// access was unconfirmed RCE on Craig's PC. A token bound to {verb, args},
// short-lived and single-use, minted only by processes holding the shared
// secret (deck/gateway, NOT spawned agents), closes it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mintConfirm, verifyConfirm } from '../src/lib/pc-confirm.js';

const S = 'shared-secret-abc';
const T = 1_700_000_000_000;

test('a freshly minted token verifies for the same verb+args', () => {
  const tok = mintConfirm(S, 'shell', { command: 'Restart-Service Spooler' }, { now: T });
  assert.equal(verifyConfirm(S, tok, 'shell', { command: 'Restart-Service Spooler' }, { now: T + 1000 }).ok, true);
});

test('argument order and absent-vs-empty do not change the binding', () => {
  const tok = mintConfirm(S, 'process.kill', { name: 'notepad', pid: '' }, { now: T });
  assert.equal(verifyConfirm(S, tok, 'process.kill', { pid: null, name: 'notepad' }, { now: T + 1 }).ok, true);
});

test('a token for one command does NOT authorise a different one', () => {
  const tok = mintConfirm(S, 'shell', { command: 'Get-Date' }, { now: T });
  assert.equal(verifyConfirm(S, tok, 'shell', { command: 'Remove-Item C:\\ -Recurse' }, { now: T + 1 }).reason, 'bad-signature');
});

test('a token for one verb does NOT authorise another verb', () => {
  const tok = mintConfirm(S, 'service.restart', { name: 'Spooler' }, { now: T });
  assert.equal(verifyConfirm(S, tok, 'service.stop', { name: 'Spooler' }, { now: T + 1 }).reason, 'bad-signature');
});

test('a token minted under a different secret is refused (an agent cannot forge one)', () => {
  const tok = mintConfirm('agent-guessed-secret', 'shell', { command: 'x' }, { now: T });
  assert.equal(verifyConfirm(S, tok, 'shell', { command: 'x' }, { now: T + 1 }).reason, 'bad-signature');
});

test('an expired token is refused', () => {
  const tok = mintConfirm(S, 'shell', { command: 'x' }, { now: T, ttlMs: 60_000 });
  assert.equal(verifyConfirm(S, tok, 'shell', { command: 'x' }, { now: T + 61_000 }).reason, 'expired');
});

test('missing / malformed tokens are refused, never accepted', () => {
  assert.equal(verifyConfirm(S, '', 'shell', {}, { now: T }).reason, 'missing');
  assert.equal(verifyConfirm(S, 'a.b', 'shell', {}, { now: T }).reason, 'malformed');
  assert.equal(verifyConfirm(S, 'a.notanumber.c', 'shell', {}, { now: T }).reason, 'malformed');
});

test('with no secret configured the gate fails CLOSED, both minting and verifying', () => {
  assert.equal(mintConfirm('', 'shell', {}, { now: T }), '');
  assert.equal(verifyConfirm('', 'anything', {}, { now: T }).reason, 'no-secret');
});

test('the verifier exposes the nonce so the caller can enforce single-use', () => {
  const tok = mintConfirm(S, 'shell', { command: 'x' }, { now: T });
  const v = verifyConfirm(S, tok, 'shell', { command: 'x' }, { now: T + 1 });
  assert.ok(v.nonce && typeof v.nonce === 'string');
});

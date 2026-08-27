/**
 * webpush.test.js — proof the encryption is REAL, not merely well-formed.
 *
 * This is the test that matters for this module, and it is the one that is easy
 * to skip: it is trivial to assert that encryptPayload() returns a Buffer of
 * about the right length, and such a test passes just as happily when the
 * ciphertext is garbage that Apple's push service will reject with a bare 400
 * at 3am. So the main case here does what the phone does — it DECRYPTS, with
 * the subscription's own private key, and checks the plaintext comes back.
 *
 * Same reasoning for the VAPID header: a DER-encoded ES256 signature is
 * accepted by node, looks correct, and is rejected by every push service. The
 * only way to know is to verify it the way they do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKeyPairSync, createPublicKey, diffieHellman,
  hkdfSync, randomBytes, createDecipheriv, verify as verifyWith,
} from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVapid, vapidHeader, encryptPayload, sendWebPush } from '../src/lib/webpush.js';

const b64u = (b) => Buffer.from(b).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

/** Stand in for a browser: make a subscription the way the Push API does. */
function fakeSubscription() {
  const kp = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = kp.publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return {
    sub: {
      endpoint: 'https://web.push.apple.com/fake-endpoint',
      keys: { p256dh: b64u(raw), auth: b64u(randomBytes(16)) },
    },
    privateKey: kp.privateKey,
    publicRaw: raw,
  };
}

/** What the browser's push machinery does with the bytes we send (RFC 8291). */
function decrypt(body, { privateKey, publicRaw, authSecret }) {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const senderPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);

  const senderJwk = {
    kty: 'EC', crv: 'P-256',
    x: b64u(senderPublic.subarray(1, 33)),
    y: b64u(senderPublic.subarray(33, 65)),
  };
  const shared = diffieHellman({
    privateKey,
    publicKey: createPublicKey({ key: senderJwk, format: 'jwk' }),
  });
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), publicRaw, senderPublic]);
  const prk = Buffer.from(hkdfSync('sha256', shared, authSecret, prkInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const tag = ciphertext.subarray(ciphertext.length - 16);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]);
  return plain.subarray(0, plain.length - 1).toString('utf8');   // strip the 0x02 delimiter
}

test('the payload a phone receives is the payload we sent', () => {
  const { sub, privateKey, publicRaw } = fakeSubscription();
  const payload = JSON.stringify({ level: 'alert', title: 'davenroe-api is down', view: 'plat' });
  const body = encryptPayload(payload, sub.keys);
  const out = decrypt(body, { privateKey, publicRaw, authSecret: unb64u(sub.keys.auth) });
  assert.equal(out, payload);
});

test('every message uses a fresh salt and ephemeral key', () => {
  const { sub } = fakeSubscription();
  const a = encryptPayload('same text', sub.keys);
  const b = encryptPayload('same text', sub.keys);
  assert.notEqual(a.subarray(0, 16).toString('hex'), b.subarray(0, 16).toString('hex'), 'salt reused');
  assert.notEqual(a.subarray(21, 86).toString('hex'), b.subarray(21, 86).toString('hex'), 'ephemeral key reused');
});

test('the aes128gcm header is exactly what the spec describes', () => {
  const { sub } = fakeSubscription();
  const body = encryptPayload('x', sub.keys);
  assert.equal(body.readUInt32BE(16), 4096, 'record size');
  assert.equal(body.readUInt8(20), 65, 'key length byte');
  assert.equal(body.readUInt8(21), 4, 'uncompressed point marker');
});

test('a malformed subscription is rejected here, not inside a 3am alert', () => {
  const { sub } = fakeSubscription();
  assert.throws(() => encryptPayload('x', { p256dh: sub.keys.p256dh, auth: b64u(randomBytes(8)) }), /16 bytes/);
  assert.throws(() => encryptPayload('x', { p256dh: b64u(randomBytes(20)), auth: sub.keys.auth }), /65-byte/);
});

test('the VAPID signature verifies as raw r||s, the way a push service checks it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vapid-'));
  try {
    const vapid = loadVapid(join(dir, 'vapid.json'));
    const header = vapidHeader('https://web.push.apple.com/abc', vapid);
    const m = /^vapid t=([\w-]+\.[\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    assert.ok(m, `header shape: ${header}`);

    const [, signingInput, sig, key] = m;
    assert.equal(key, vapid.publicKey, 'k= must be the key subscriptions were made with');
    assert.equal(unb64u(sig).length, 64, 'ES256 must be raw r||s (64 bytes), not DER');

    const raw = unb64u(vapid.publicKey);
    const pub = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) },
      format: 'jwk',
    });
    assert.ok(
      verifyWith('sha256', Buffer.from(signingInput), { key: pub, dsaEncoding: 'ieee-p1363' }, unb64u(sig)),
      'signature does not verify',
    );

    const claims = JSON.parse(unb64u(signingInput.split('.')[1]).toString());
    assert.equal(claims.aud, 'https://web.push.apple.com', 'aud is the ORIGIN, not the endpoint');
    assert.ok(claims.exp - Math.floor(Date.now() / 1000) <= 24 * 3600, 'exp must be within 24h');
    assert.match(claims.sub, /^mailto:|^https:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the VAPID keypair is stable across loads — it is baked into every subscription', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vapid-'));
  try {
    const a = loadVapid(join(dir, 'vapid.json'));
    const b = loadVapid(join(dir, 'vapid.json'));
    assert.equal(a.publicKey, b.publicKey);
    assert.equal(a.privateKeyPem, b.privateKeyPem);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('404 and 410 mark a subscription gone; other failures do not', async () => {
  const { sub } = fakeSubscription();
  const dir = mkdtempSync(join(tmpdir(), 'vapid-'));
  const vapid = loadVapid(join(dir, 'vapid.json'));
  const orig = global.fetch;
  try {
    for (const [status, gone] of [[404, true], [410, true], [500, false], [429, false]]) {
      global.fetch = async () => ({ ok: false, status });
      const r = await sendWebPush(sub, 'hi', { vapid });
      assert.equal(r.ok, false);
      assert.equal(!!r.gone, gone, `status ${status}`);
    }
    global.fetch = async () => ({ ok: true, status: 201 });
    assert.equal((await sendWebPush(sub, 'hi', { vapid })).ok, true);
  } finally {
    global.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a network failure returns, it does not throw at the caller raising the alarm', async () => {
  const { sub } = fakeSubscription();
  const dir = mkdtempSync(join(tmpdir(), 'vapid-'));
  const vapid = loadVapid(join(dir, 'vapid.json'));
  const orig = global.fetch;
  try {
    global.fetch = async () => { throw new Error('ECONNRESET'); };
    const r = await sendWebPush(sub, 'hi', { vapid });
    assert.equal(r.ok, false);
    assert.match(r.error, /ECONNRESET/);
  } finally {
    global.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the collapse topic is trimmed to what a push service accepts', async () => {
  const { sub } = fakeSubscription();
  const dir = mkdtempSync(join(tmpdir(), 'vapid-'));
  const vapid = loadVapid(join(dir, 'vapid.json'));
  const orig = global.fetch;
  let seen;
  try {
    global.fetch = async (_url, opts) => { seen = opts.headers; return { ok: true, status: 201 }; };
    await sendWebPush(sub, 'hi', { vapid, topic: 'a/very+long topic name that goes well past the limit' });
    assert.ok(seen.Topic.length <= 32);
    assert.match(seen.Topic, /^[A-Za-z0-9_-]+$/);
  } finally {
    global.fetch = orig;
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * webpush.js — the alert that reaches Craig's iPhone and iPad through the deck
 * he already has on his home screen (2026-08-27).
 *
 * Why this exists next to push.js rather than instead of it:
 *
 *   ntfy (push.js) is a fine dumb pipe and it stays. But it needs a SECOND app
 *   installed, subscribed to a topic whose name is the only credential, and it
 *   has been in KNOWN DEBT #1 for a month for exactly one reason — nobody could
 *   confirm a device ever actually buzzed. Every notification it sends is also
 *   a dead end: a line of text with nowhere to tap.
 *
 *   The Command Deck is ALREADY installed as a PWA on his phone and iPad (move
 *   31). iOS 16.4+ delivers Web Push to a home-screen PWA. So the surface he
 *   already opens can wake him — no app store, no topic name, no shared secret
 *   that leaks by being read aloud. And because we control both ends, a push
 *   can carry a DESTINATION: tapping "3 findings need review" opens the deck
 *   ON the OPS tab, not at a wall of text.
 *
 * Doctrine notes:
 *   - Rule 5 (no competitor dependencies) is satisfied with room to spare: no
 *     web-push npm package, no SDK. RFC 8291 (message encryption) and RFC 8292
 *     (VAPID) are implemented here against node:crypto alone — ECDH P-256,
 *     HKDF-SHA256, AES-128-GCM, ES256. That is ~80 lines of standard, versus a
 *     dependency in the path of the one channel that has to work at 3am.
 *   - Failure is returned, never thrown at the caller. push.js swallows it the
 *     same way it swallows an ntfy failure — notification plumbing must never
 *     take down the thing raising the alarm.
 *   - `gone: true` on 404/410 is load-bearing: a push service tells you exactly
 *     once that a subscription is dead, and a sender that ignores it keeps a
 *     stale endpoint forever and cannot tell "nothing delivered" from "nothing
 *     to deliver". push-subs.js prunes on that flag.
 */

import {
  createPublicKey, createPrivateKey, generateKeyPairSync, diffieHellman,
  hkdfSync, randomBytes, createCipheriv, sign as signWith,
} from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');

// ── keys ─────────────────────────────────────────────────────────────────────

/**
 * The VAPID identity — one keypair for this deck, forever.
 *
 * It must be STABLE: the public key is baked into every subscription a browser
 * has ever created, so regenerating it silently invalidates every device that
 * subscribed. Kept in config/vapid.json (0600, gitignored) exactly like
 * config/deck.token, and minted on first use rather than being another thing
 * Craig has to set up before anything works.
 */
export function loadVapid(file = '/opt/jarvis/config/vapid.json') {
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      if (j.privateKeyPem && j.publicKey) return j;
    } catch { /* fall through and re-mint */ }
  }
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  const out = {
    publicKey: b64u(raw),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    created: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
  return out;
}

/** Raw uncompressed P-256 point (65 bytes) → a KeyObject we can do ECDH with. */
function pointToKey(raw) {
  const b = Buffer.from(raw);
  if (b.length !== 65 || b[0] !== 4) throw new Error('expected a 65-byte uncompressed P-256 point');
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(b.subarray(1, 33)), y: b64u(b.subarray(33, 65)) },
    format: 'jwk',
  });
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────────

/**
 * The Authorization header proving to Apple/Google/Mozilla that this box is the
 * same sender the subscription was created for.
 *
 * `sub` must be a mailto: or https: the push service can complain to. Ours is
 * marco@alecrae.com — Marco's own mailbox, which he can actually read.
 */
export function vapidHeader(endpoint, vapid, { subject = 'mailto:marco@alecrae.com', hours = 12 } = {}) {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + Math.min(hours, 23) * 3600;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp, sub: subject }));
  const input = `${head}.${body}`;
  // dsaEncoding matters and is the classic silent failure here: node signs DER
  // by default, JWS wants raw r||s. A DER signature is accepted by node, looks
  // fine locally, and is rejected by every push service with a bare 401.
  const sig = signWith('sha256', Buffer.from(input), {
    key: createPrivateKey(vapid.privateKeyPem),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${input}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// ── payload encryption (RFC 8291, aes128gcm) ─────────────────────────────────

/**
 * Encrypt a payload to one subscription's keys.
 *
 * The push service NEVER sees the content — this is end-to-end between the box
 * and the browser's service worker, which is the only reason it is acceptable
 * to put a real headline ("davenroe-api is down") into a notification that
 * transits Apple's infrastructure.
 */
export function encryptPayload(payload, { p256dh, auth }) {
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (authSecret.length !== 16) throw new Error('auth secret must be 16 bytes');

  const eph = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ephJwk = eph.publicKey.export({ format: 'jwk' });
  const ephPublic = Buffer.concat([Buffer.from([4]), unb64u(ephJwk.x), unb64u(ephJwk.y)]);

  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: pointToKey(uaPublic) });

  // PRK: the auth secret is the salt here, and the info string binds the two
  // public keys so a captured ciphertext cannot be replayed to another device.
  const prkInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, ephPublic]);
  const prk = Buffer.from(hkdfSync('sha256', shared, authSecret, prkInfo, 32));

  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', prk, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);  // 0x02 = last record
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);       // record size
  header.writeUInt8(65, 20);            // length of the key that follows
  return Buffer.concat([header, ephPublic, body]);
}

// ── send ─────────────────────────────────────────────────────────────────────

/**
 * Deliver one notification to one device.
 *
 * `topic` is the collapse key: a push service replaces an undelivered message
 * carrying the same topic instead of queueing both. That is what stops a phone
 * that was in a pocket for an hour from producing eight buzzes the moment it
 * unlocks — it is the last line of the same defence push.js's dedupe is.
 *
 * `urgency` is how hard the device is allowed to work for it. 'high' wakes a
 * sleeping phone; 'normal' may wait for the next radio wake. An alert is worth
 * the battery, an info-level digest is not.
 */
export async function sendWebPush(sub, payload, { vapid, ttl = 3600, urgency = 'normal', topic = null, timeoutMs = 8000 } = {}) {
  try {
    const body = encryptPayload(typeof payload === 'string' ? payload : JSON.stringify(payload), sub.keys);
    const headers = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Authorization: vapidHeader(sub.endpoint, vapid),
    };
    // Topic must be ≤32 URL-safe base64 chars by spec; a longer one is a 400
    // from the push service, so it is trimmed here rather than at each caller.
    if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);

    const r = await fetch(sub.endpoint, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) return { ok: true, status: r.status };
    // 404/410 are the push service saying this subscription is permanently
    // dead (app deleted, permission revoked). Anything else may be transient.
    return { ok: false, status: r.status, gone: r.status === 404 || r.status === 410 };
  } catch (e) {
    return { ok: false, error: e.message, gone: false };
  }
}

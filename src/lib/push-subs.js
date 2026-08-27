/**
 * push-subs.js — which devices are listening, and the fan-out to them.
 *
 * Storage is memory-server KV (`push-devices`), not a new table, and that is a
 * deliberate choice rather than laziness: this is a handful of rows that change
 * when Craig installs the deck on a new device — perhaps five times a year —
 * and KV is the same SQLite file with the same backup, the same durability and
 * no migration to get wrong on the most-read database on the box (Rule 7's
 * whole point is that a schema change is the risky move, and there is nothing
 * here that wants querying).
 *
 * Keyed by endpoint, because that is what the browser gives back on
 * re-subscribe: the same device re-registering must UPDATE its row, not add a
 * second one, or every alert arrives twice on the same phone.
 *
 * Pruning is not optional (see webpush.js's `gone` flag). A subscription dies
 * silently when the PWA is deleted or permission is revoked, and the only
 * notice you ever get is a single 404/410 on the next send. Keeping the dead
 * row means every future alert reports a partial failure forever, which is
 * indistinguishable from the channel being broken — the exact ambiguity that
 * left the ntfy leg unverified for a month.
 */

import { sendWebPush, loadVapid } from './webpush.js';

const MEMORY = 'http://127.0.0.1:9200';
const KEY = 'push-devices';

// Swappable for tests, exactly like push.js's — the suites mock global fetch
// and count calls, so the KV hop has to be replaceable without a live :9200.
let kv = {
  async get(key) {
    try {
      const r = await fetch(`${MEMORY}/memory/kv/${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      return j && j.value ? JSON.parse(j.value) : null;
    } catch { return null; }
  },
  async set(key, value) {
    try {
      await fetch(`${MEMORY}/memory/kv`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value: JSON.stringify(value) }), signal: AbortSignal.timeout(2500),
      });
      return true;
    } catch { return false; }
  },
};

/** Test seam: install an in-memory store. */
export function _setKv(stub) { kv = stub; }

export async function listDevices() {
  const v = await kv.get(KEY);
  return Array.isArray(v?.devices) ? v.devices : [];
}

async function writeDevices(devices) {
  return kv.set(KEY, { devices, updated: new Date().toISOString() });
}

/**
 * Is this shape actually a push subscription?
 *
 * Checked here rather than trusted from the request body because a malformed
 * one does not fail at registration — it fails much later, inside the AES-GCM
 * setup of the first real alert, at which point the failure looks like a
 * crypto bug in the middle of an incident.
 */
export function validSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string') return false;
  if (!/^https:\/\//.test(sub.endpoint)) return false;
  const k = sub.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string') return false;
  try {
    return Buffer.from(k.p256dh, 'base64url').length === 65
        && Buffer.from(k.auth, 'base64url').length === 16;
  } catch { return false; }
}

/** Register (or refresh) one device. Returns the stored row. */
export async function addDevice(sub, { label = 'device', ua = '' } = {}) {
  if (!validSubscription(sub)) throw new Error('invalid subscription');
  const devices = await listDevices();
  const now = new Date().toISOString();
  const existing = devices.find(d => d.endpoint === sub.endpoint);
  const row = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    label: String(label || 'device').slice(0, 40),
    ua: String(ua || '').slice(0, 200),
    created: existing?.created || now,
    lastOk: existing?.lastOk || null,
    fails: 0,
  };
  await writeDevices([...devices.filter(d => d.endpoint !== sub.endpoint), row]);
  return row;
}

export async function removeDevice(endpoint) {
  const devices = await listDevices();
  const left = devices.filter(d => d.endpoint !== endpoint);
  if (left.length !== devices.length) await writeDevices(left);
  return devices.length - left.length;
}

/**
 * Send one notification to every registered device.
 *
 * Returns per-device outcomes rather than a bare boolean so the caller — and
 * the health check that watches this channel — can say "2 of 3 phones got it",
 * which is the sentence that was missing when nobody could tell whether the
 * device leg worked at all.
 */
export async function deliverWebPush(payload, { ttl = 3600, urgency = 'normal', topic = null } = {}) {
  const devices = await listDevices();
  if (!devices.length) return { sent: 0, devices: 0, reason: 'no-devices', results: [] };

  let vapid;
  try { vapid = loadVapid(); }
  catch (e) { return { sent: 0, devices: devices.length, reason: 'no-vapid-key', error: e.message, results: [] }; }

  const results = await Promise.all(devices.map(async (d) => {
    const r = await sendWebPush(d, payload, { vapid, ttl, urgency, topic });
    return { endpoint: d.endpoint, label: d.label, ...r };
  }));

  // Persist the outcome: prune what the push service says is gone, and count
  // consecutive failures so a device that is merely offline is not dropped.
  const now = new Date().toISOString();
  const kept = [];
  for (const d of devices) {
    const r = results.find(x => x.endpoint === d.endpoint);
    if (r?.gone) continue;
    kept.push(r?.ok ? { ...d, lastOk: now, fails: 0 } : { ...d, fails: (d.fails || 0) + 1 });
  }
  if (kept.length !== devices.length || results.some(r => r.ok || r.error || r.status)) {
    await writeDevices(kept);
  }

  const sent = results.filter(r => r.ok).length;
  return { sent, devices: devices.length, pruned: devices.length - kept.length, results };
}

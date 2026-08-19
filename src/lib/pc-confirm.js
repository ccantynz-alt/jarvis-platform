/**
 * pc-confirm.js — a server-side gate for MUTATING PC actions (2026-08-19,
 * audit move 37).
 *
 * THE HOLE THIS CLOSES. `/pc/action` on the orchestrator (loopback :9205)
 * enqueues whatever verb it is given. Read-only verbs are fine — they change
 * nothing. But `shell`, `service.restart`, `process.kill` etc. are gated ONLY
 * in the conversational layer: the brain can merely PREVIEW them, and the
 * confirmed run happens after Craig says "yes" in resolveDispatchGate. The
 * orchestrator endpoint itself never checked that a human confirmed — so any
 * process with loopback access could POST a mutating action directly. Every
 * dispatched fleet agent runs as root with loopback access and treats
 * untrusted web/repo text as input; a prompt injection was therefore
 * unconfirmed RCE on Craig's PC. This is exactly the "boundaries are
 * credentials and server-side gates, not prompts" rule (CLAUDE.md Rule 5).
 *
 * THE DESIGN. A shared HMAC secret (`JARVIS_PC_CONFIRM_SECRET`) is held by the
 * processes that legitimately confirm a mutation — the deck and the gateway,
 * where the human "yes" is classified — and by the orchestrator, which
 * verifies. It is STRIPPED from every spawned agent's environment
 * (claude-auth.js profileEnv, the one choke point for all CLI spawns), so a
 * fleet agent cannot mint one. The confirmation gate mints a token bound to
 * the exact {verb, args}, short-lived and single-use; the orchestrator refuses
 * any mutating action whose token is missing, forged, expired, replayed, or
 * bound to different arguments. Read-only verbs need no token and are
 * unaffected.
 *
 * PURE (no fs/net/clock beyond an injected `now`). Tests: test/pc-confirm.test.js.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_TTL_MS = 2 * 60_000; // a confirmed action runs within two minutes

// Canonical, order-independent serialisation of args so the token binds to the
// SAME logical arguments regardless of key order or absent-vs-empty noise.
function canonicalArgs(args) {
  const o = args && typeof args === 'object' ? args : {};
  const keys = Object.keys(o).filter(k => o[k] !== undefined && o[k] !== null && o[k] !== '').sort();
  return JSON.stringify(keys.map(k => [k, String(o[k])]));
}

function payloadString(verb, args, nonce, exp) {
  return `${verb}\n${canonicalArgs(args)}\n${nonce}\n${exp}`;
}
function sign(secret, s) {
  return createHmac('sha256', secret).update(s).digest('base64url');
}

/**
 * Mint a confirmation token for a mutating {verb, args}. Returns '' if no
 * secret is configured — the orchestrator then decides whether to fail closed
 * (it does) so an unconfigured secret is a hard stop, never an open door.
 */
export function mintConfirm(secret, verb, args, { now = Date.now(), ttlMs = DEFAULT_TTL_MS, nonce } = {}) {
  if (!secret) return '';
  const exp = now + ttlMs;
  const n = nonce || `${now.toString(36)}${Math.trunc(now % 1000).toString(36)}${verb.length}`; // deterministic-ish; uniqueness comes from exp+verb+args, replay guard is single-use
  const mac = sign(secret, payloadString(verb, args, n, exp));
  return `${n}.${exp}.${mac}`;
}

/**
 * Verify a token against the claimed {verb, args}. Pure — replay (single-use)
 * is enforced by the caller tracking spent nonces, since that needs state.
 * @returns {{ok: boolean, reason: string|null, nonce: string|null, exp: number|null}}
 */
export function verifyConfirm(secret, token, verb, args, { now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: 'no-secret', nonce: null, exp: null };
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing', nonce: null, exp: null };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed', nonce: null, exp: null };
  const [nonce, expStr, mac] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp)) return { ok: false, reason: 'malformed', nonce: null, exp: null };
  const want = sign(secret, payloadString(verb, args, nonce, exp));
  const a = Buffer.from(mac);
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature', nonce, exp };
  if (now > exp) return { ok: false, reason: 'expired', nonce, exp };
  return { ok: true, reason: null, nonce, exp };
}

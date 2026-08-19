/**
 * internal-http.js — an authentication boundary on the loopback control plane
 * (2026-08-19, audit move 11).
 *
 * THE HOLE. memory-server (:9200) and orchestrator (:9205) bind loopback only,
 * which stops the internet but NOT other processes on this shared box —
 * AlecRae, the Gluecron container, GateTest, the whole Coolify stack all run
 * here. Every one of them could POST to :9200/:9205 and rewrite a code
 * finding, APPROVE a governance proposal, or enqueue a full-permission agent
 * job. Loopback is a network boundary, not an authentication one.
 *
 * THE FIX, in two halves that live together so they cannot drift:
 *
 *   1. OUTGOING (installInternalAuth): every Jarvis service loads secrets.env
 *      and therefore holds JARVIS_INTERNAL_TOKEN; a co-tenant does not. This
 *      wraps the process's global fetch so any request to loopback :9200/:9205
 *      carries `X-Jarvis-Internal: <token>`. One import per service entrypoint
 *      covers all of that service's call sites (and its libs') — there is no
 *      central HTTP client to route through otherwise.
 *
 *   2. INCOMING (internalGuard): an Express middleware the two servers mount on
 *      their SENSITIVE mutating routes (approve a proposal, write a finding,
 *      dispatch a job). A request without the matching token is refused. GETs
 *      and benign writes (kv, notifications, session/repair logs) stay open, so
 *      shell scripts and read paths are unaffected — the blast radius is
 *      exactly the three actions the audit named.
 *
 * Fails OPEN when the token is unset (deploy the code first, set the token
 * second, so a rollout can never brick the fleet mid-deploy); fails CLOSED for
 * a guarded route the moment the token exists.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { readFileSync } from 'fs';

const HEADER = 'x-jarvis-internal';

// The env var wins; a box process launched without it (a hand-run script) falls
// back to reading it ONCE from secrets.env, so "did this process get the env"
// stops being a way to accidentally lock a legit caller out. Cached; a
// missing/unreadable file just means "no token" (the guard then fails open).
let secretsToken; // undefined = not yet read
function token() {
  if (process.env.JARVIS_INTERNAL_TOKEN) return process.env.JARVIS_INTERNAL_TOKEN;
  if (secretsToken === undefined) {
    try {
      const path = process.env.JARVIS_SECRETS_PATH || '/opt/jarvis/config/secrets.env';
      const m = /^JARVIS_INTERNAL_TOKEN=(.+)$/m.exec(readFileSync(path, 'utf8'));
      secretsToken = m ? m[1].trim() : '';
    } catch { secretsToken = ''; }
  }
  return secretsToken;
}
/** Tests only: clear the cached secrets.env fallback so env changes take effect. */
export function _resetTokenCache() { secretsToken = undefined; }

// Loopback Jarvis control-plane ports that get the header injected.
const GUARDED_PORTS = new Set(['9200', '9205']);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

let installed = false;
/** Wrap global fetch so loopback :9200/:9205 requests carry the internal token. */
export function installInternalAuth() {
  if (installed) return;
  installed = true;
  const real = globalThis.fetch;
  if (typeof real !== 'function') return;
  globalThis.fetch = function patchedFetch(input, init) {
    const t = token();
    if (t) {
      try {
        const url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
        if (LOOPBACK.has(url.hostname) && GUARDED_PORTS.has(url.port)) {
          init = { ...(init || {}) };
          const h = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {});
          if (!h.has(HEADER)) h.set(HEADER, t);
          init.headers = h;
        }
      } catch { /* not a parseable URL — leave the call untouched */ }
    }
    return real.call(this, input, init);
  };
}

function tokenOk(provided) {
  const t = token();
  if (!t) return true;                 // fail OPEN when unconfigured (see header)
  if (!provided) return false;
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(t).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Express guard for a sensitive mutating route. A caller without the matching
 * internal token gets 403. Loopback callers that ARE Jarvis carry it via the
 * outgoing patch; a co-tenant process does not have the token at all.
 */
export function internalGuard(req, res, next) {
  if (tokenOk(req.headers[HEADER])) return next();
  console.warn(`[internal-auth] refused ${req.method} ${req.path} from ${req.socket?.remoteAddress || '?'} — no internal token`);
  return res.status(403).json({ error: 'internal token required for this action' });
}

/** For tests / diagnostics: is a boundary token configured at all? */
export function internalAuthConfigured() { return !!token(); }

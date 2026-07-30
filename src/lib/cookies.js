/**
 * cookies.js — one cookie parser that cannot throw.
 *
 * There were three byte-identical copies of this (deck-server, gateway-server,
 * dashboard-server) and all three called `decodeURIComponent(value)` unguarded.
 * `decodeURIComponent('%')` throws `URIError: URI malformed`.
 *
 * On an express route a synchronous throw is survivable — express catches it and
 * returns 500. The WebSocket upgrade path is NOT a route:
 *
 *     server.on('upgrade', (req, socket, head) => { const cookies = parseCookies(req.headers.cookie); … })
 *
 * runs inside Node's 'upgrade' event emit, where an exception is an
 * uncaughtException and terminates the process. And the parse happens BEFORE the
 * token is compared, so no credential is needed: any tailnet client sending
 * `Cookie: a=%` on an upgrade request kills jarvis-deck. With Restart=always it
 * comes back and can be killed again.
 *
 * Worse, it is reachable by accident: `document.cookie = 'x=%'` is legal in a
 * browser, and the deck client auto-reconnects — so one bad cookie in Craig's own
 * browser would crash-loop the service he is looking at.
 *
 * (Found 2026-07-30 by the code-health spine, auth-session lens.)
 *
 * A malformed value is kept RAW rather than dropped: a cookie we cannot decode
 * still cannot match a token, so the auth outcome is identical, and keeping it
 * means a debug log shows what actually arrived.
 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    if (!name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;   // undecodable — cannot match a token either way
    }
  }
  return out;
}

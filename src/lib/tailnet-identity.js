/**
 * tailnet-identity.js — let Tailscale's own identity unlock a tailnet-only
 * surface, instead of a second password typed on a phone.
 *
 * 2026-08-19. The deck is reachable ONLY through `tailscale serve` (the
 * listener is loopback). Tailscale already authenticates every request on that
 * path: the serve proxy looks the peer up (whois) and injects
 * `Tailscale-User-Login` / `Tailscale-User-Name`, overwriting anything the
 * client sent. The deck READ that header — to print it in the 403 log line —
 * and then refused the request anyway because the phone had no deck cookie:
 *
 *     [deck] 403 for 100.111.46.68 (ccantynz@gmail.com)   ×10 in 14 days
 *
 * 100.111.46.68 is Craig's iPhone. "I still can't use it on my mobile phone"
 * was, for the deck, a second credential that lived in a file on the box.
 *
 * Policy: an allowlisted tailnet login, arriving THROUGH the proxy, is
 * authenticated. "Through the proxy" = `X-Forwarded-For` is present, which is
 * exactly the signal `isLocalDirect()` already uses to tell a serve hop from a
 * raw loopback call. A raw loopback caller can forge the header — but a raw
 * loopback caller is ALREADY trusted in full by `isLocalDirect()`, so this adds
 * no new trust: the threat model is unchanged, the phone just stops being
 * locked out of a door the network already opened.
 *
 * Tagged nodes (fleet boxes, Craig's PC under tag:server) carry no user login,
 * so they keep using the token/cookie path. Empty allowlist = feature off.
 *
 * Pure. Tests: test/tailnet-identity.test.js.
 */

/** Parse `DECK_TAILNET_USERS` / similar: comma or whitespace separated logins. */
export function parseAllowlist(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Return the matching login when Tailscale identifies the request as an
 * allowlisted user, else null.
 *
 * @param {object} headers  Node's lower-cased req.headers
 * @param {string[]} allowlist  from parseAllowlist()
 */
export function tailnetIdentity(headers = {}, allowlist = []) {
  if (!allowlist.length) return null;
  // Must have come through the serve proxy — a direct loopback request has no
  // forwarded-for, and is handled (and trusted) by isLocalDirect() instead.
  if (!headers['x-forwarded-for']) return null;
  const login = String(headers['tailscale-user-login'] || '').trim().toLowerCase();
  if (!login) return null;
  return allowlist.includes(login) ? login : null;
}

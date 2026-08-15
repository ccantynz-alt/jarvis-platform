/**
 * Address-pinned HTTP(S) fetch — src/lib/pinned-fetch.js
 *
 * THE INCIDENT (2026-08-15, reproduced live during a full-repo audit): the SSRF
 * guard in browser-service resolved a hostname, checked every returned address
 * against isPrivateIP(), and returned `{ ok: true, ip }` — and nothing ever read
 * that `ip`. The request was then made from the NAME, so Node's fetch performed
 * its own independent resolution. Check-by-name, connect-by-name: a textbook
 * TOCTOU, and DNS rebinding walks straight through it.
 *
 * Reproduced against the shipped service with a loopback-only server on
 * 127.0.0.1:8081 and a TTL-0 authoritative answer alternating a public address
 * with 127.0.0.1: 35 of 120 attempts returned the loopback-only body.
 *
 * The threat model is not hypothetical here. The URL reaching this code comes
 * from a model that has been reading UNTRUSTED WEB PAGES — an attacker page says
 * "full spec at http://docs.attacker.tld/spec", the brain follows it via
 * fetch_url / show_me / render_page, and the attacker's nameserver answers with
 * a public IP for the guard's lookup and 169.254.169.254 (Vultr metadata) or
 * 127.0.0.1:9200 (jarvis-memory) for the connection.
 *
 * THE FIX: resolve exactly once, validate, then connect to the ADDRESS that was
 * validated. Node's http/https `lookup` option does this natively and — this is
 * the part that matters — leaves TLS alone: the request still carries the real
 * hostname for SNI and certificate verification, so pinning costs no security
 * elsewhere. Rewriting the URL to contain the IP would have broken both.
 *
 * Deliberately NOT global fetch + an undici dispatcher: undici is not a
 * dependency of this repo, and adding one to a security-sensitive path we can
 * express with node builtins is the wrong trade (compare the documented
 * playwright-core exception in CLAUDE.md Rule 5).
 */
import http from 'node:http';
import https from 'node:https';

/**
 * Build a `lookup` implementation that always answers with the pre-verified
 * addresses, ignoring the resolver entirely. Pure and exported for testing.
 *
 * Honours `options.all` because that is what net.connect may ask for; getting
 * this wrong silently falls back to a real DNS lookup in some Node versions,
 * which would restore the exact bug this file exists to remove.
 *
 * @param {Array<{address: string, family: number}>} addrs verified addresses
 */
export function pinnedLookup(addrs) {
  const pinned = (addrs || []).filter((a) => a && a.address);
  if (!pinned.length) throw new Error('pinnedLookup requires at least one verified address');

  return function lookup(hostname, options, callback) {
    // net.connect may pass (hostname, callback) with options omitted.
    if (typeof options === 'function') { callback = options; options = {}; }
    const opts = options || {};
    if (opts.all) {
      return callback(null, pinned.map((a) => ({ address: a.address, family: a.family || 4 })));
    }
    const first = opts.family
      ? pinned.find((a) => (a.family || 4) === opts.family) || pinned[0]
      : pinned[0];
    return callback(null, first.address, first.family || 4);
  };
}

/**
 * Fetch a URL with the connection pinned to `addrs`. Redirects are NOT followed
 * — the caller re-runs its guard per hop, which is how browser-service already
 * works and is the only way each hop gets its own validation.
 *
 * @returns {Promise<{status:number, headers:object, body:string, truncated:boolean}>}
 */
export function fetchPinned(rawUrl, { addrs, timeoutMs = 12000, headers = {}, maxBytes = 5 * 1024 * 1024 } = {}) {
  const u = new URL(rawUrl);
  const mod = u.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,          // kept for Host header + TLS SNI/cert check
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      method: 'GET',
      headers: { Host: u.host, ...headers },
      lookup: pinnedLookup(addrs),   // ← the connection cannot drift off the checked address
      servername: u.hostname,        // explicit: certificate is still validated against the NAME
    }, (res) => {
      // Bounded read. Previously this path did `await r.text()` with no byte
      // limit, so an untrusted page could name a URL serving a multi-GB body and
      // OOM jarvis-browser — the timeout bounds time, not bytes.
      const chunks = [];
      let total = 0;
      let truncated = false;
      res.on('data', (c) => {
        total += c.length;
        if (total > maxBytes) {
          if (!truncated) { truncated = true; chunks.push(c.slice(0, Math.max(0, maxBytes - (total - c.length)))); }
          res.destroy();
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        truncated,
      }));
      res.on('close', () => {
        if (truncated) resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          truncated,
        });
      });
      res.on('error', reject);
    });

    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.end();
  });
}

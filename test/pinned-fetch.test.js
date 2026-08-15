/**
 * Regression tests for address pinning in the SSRF-guarded fetch path.
 *
 * THE INCIDENT (2026-08-15, reproduced live during a full-repo audit):
 * browser-service's guard() resolved a hostname, checked every address against
 * isPrivateIP(), and returned `{ ok: true, ip }` — and grep showed nothing ever
 * read that `ip`. The request was then issued from the NAME, so Node's fetch did
 * its own resolution. Check-by-name, connect-by-name.
 *
 * Reproduced against the shipped service: a loopback-only server on
 * 127.0.0.1:8081 plus a TTL-0 answer alternating public/127.0.0.1 returned the
 * loopback-only body on 35 of 120 attempts.
 *
 * It matters because the URL arrives from a model that has been reading
 * untrusted web pages — the attacker chooses the hostname AND controls its
 * nameserver, so it can answer public for the check and 169.254.169.254 or
 * 127.0.0.1:9200 for the connection.
 *
 * These tests pin the lookup contract, which is where the fix lives. The live
 * end-to-end proof needs a network and belongs on the box (Rule 2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { pinnedLookup, fetchPinned } from '../src/lib/pinned-fetch.js';

test('the lookup answers with the verified address, never the resolver', () => {
  const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }]);
  let got;
  lookup('anything.test', {}, (err, address, family) => { got = { err, address, family }; });
  assert.equal(got.err, null);
  assert.equal(got.address, '93.184.216.34');
  assert.equal(got.family, 4);
});

test('THE REBIND: the hostname is irrelevant — the pin decides', () => {
  // The attacker's second answer never gets a chance to be asked for.
  const lookup = pinnedLookup([{ address: '93.184.216.34', family: 4 }]);
  for (const host of ['rebind.test', 'docs.attacker.tld', 'localhost', 'metadata.google.internal']) {
    let address;
    lookup(host, {}, (_e, a) => { address = a; });
    assert.equal(address, '93.184.216.34', `${host} must not reach a fresh resolution`);
  }
});

test('options.all is honoured, because net.connect may ask for it', () => {
  // Getting this wrong silently falls back to a real DNS lookup in some Node
  // versions — which would restore the exact bug this file removes.
  const addrs = [{ address: '1.2.3.4', family: 4 }, { address: '5.6.7.8', family: 4 }];
  const lookup = pinnedLookup(addrs);
  let out;
  lookup('x.test', { all: true }, (_e, res) => { out = res; });
  assert.deepEqual(out, addrs);
});

test('the callback-as-second-argument form is supported', () => {
  const lookup = pinnedLookup([{ address: '1.2.3.4', family: 4 }]);
  let address;
  lookup('x.test', (_e, a) => { address = a; });
  assert.equal(address, '1.2.3.4');
});

test('a family preference picks a matching pinned address', () => {
  const lookup = pinnedLookup([{ address: '1.2.3.4', family: 4 }, { address: '::1234', family: 6 }]);
  let v6;
  lookup('x.test', { family: 6 }, (_e, a) => { v6 = a; });
  assert.equal(v6, '::1234');
});

test('refusing to build a lookup with no verified addresses', () => {
  // Fail loudly rather than silently falling back to the system resolver, which
  // is precisely the behaviour being removed.
  assert.throws(() => pinnedLookup([]), /at least one verified address/);
  assert.throws(() => pinnedLookup(null), /at least one verified address/);
  assert.throws(() => pinnedLookup([{ family: 4 }]), /at least one verified address/);
});

test('end to end: the connection lands on the pinned address, not the name', async (t) => {
  // A real socket, on loopback, proving the pin is actually applied by node's
  // http stack rather than merely computed.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`host-header:${req.headers.host}`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;

  // A hostname that does not resolve anywhere. Without the pin this throws
  // ENOTFOUND; with it, the socket goes to the verified address and the Host
  // header still carries the original name (so vhosts and TLS SNI keep working).
  const out = await fetchPinned(`http://nonexistent.invalid:${port}/`, {
    addrs: [{ address: '127.0.0.1', family: 4 }],
    timeoutMs: 5000,
  });
  assert.equal(out.status, 200);
  assert.match(out.body, /host-header:nonexistent\.invalid:/,
    'the Host header must keep the real name — that is what preserves TLS validation');
});

test('the body is byte-bounded, so a huge response cannot OOM the service', async (t) => {
  // The old path did `await r.text()` with no limit: an untrusted page could
  // name a URL serving a multi-GB body, and the 12s timeout bounds time only.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 40; i++) res.write(chunk);   // ~2.5MB
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const out = await fetchPinned(`http://x.invalid:${server.address().port}/`, {
    addrs: [{ address: '127.0.0.1', family: 4 }],
    timeoutMs: 5000,
    maxBytes: 100 * 1024,
  });
  assert.ok(out.body.length <= 100 * 1024, `body was ${out.body.length} bytes`);
  assert.equal(out.truncated, true);
});

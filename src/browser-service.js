/**
 * Jarvis Browser — src/browser-service.js  (loopback :9211)
 *
 * Gives Jarvis controlled eyes on the web: search, fetch (no-JS), and a
 * Playwright render (screenshot + DOM + links). Every outbound request is
 * SSRF-guarded (private/loopback/link-local/cloud-metadata/tailnet addresses
 * are hard-blocked, always), time-limited, and written to an append-only audit
 * log. Callers (the agent tools) wrap returned page text as UNTRUSTED data so
 * the brain treats site content as data, never as instructions.
 *
 * Endpoints (JSON):
 *   GET  /browser/health
 *   POST /browser/search   { query, count? }        -> { results:[{title,url,snippet}] }
 *   POST /browser/fetch    { url }                   -> { status, finalUrl, title, text, contentType }
 *   POST /browser/render   { url, fullPage? }        -> { status, finalUrl, title, text, links, screenshot }
 */

import express from 'express';
import { chromium } from 'playwright-core';
import dns from 'dns/promises';
import net from 'net';
import { appendFileSync, mkdirSync } from 'fs';
import { resolveChrome, chromeStatus } from './lib/browser-health.js';

const PORT = 9211;
const CHROME = resolveChrome();
const NAV_TIMEOUT = 15000;
// How long to let a page SETTLE before photographing it (2026-08-11). A
// client-rendered app has painted nothing at `domcontentloaded` — the first
// real capture show_me put on Craig's screen was DavenRoe's "Loading…"
// spinner. networkidle is the right signal, but it is bounded because a page
// that polls or holds a websocket open never reaches it at all, and a picture
// arriving late is a worse failure than a picture arriving slightly early.
const SETTLE_TIMEOUT = 6000;
const SETTLE_MS = 900;
const FETCH_TIMEOUT = 12000;
const MAX_TEXT = 6000;           // chars of page text handed back to the brain
const MAX_LINKS = 40;
const MAX_REDIRECTS = 5;
const MAX_CONCURRENT_RENDER = 2;
const SHOT_DIR = '/opt/jarvis/screenshots';
const AUDIT = '/opt/jarvis/logs/browser-audit.jsonl';

mkdirSync(SHOT_DIR, { recursive: true });
mkdirSync('/opt/jarvis/logs', { recursive: true });

const app = express();
app.use(express.json({ limit: '256kb' }));

// Loopback only — this service is called by the agent tools on 127.0.0.1.
app.use((req, res, next) => {
  const ip = req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  return res.status(403).json({ error: 'loopback only' });
});

function audit(entry) {
  try { appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); }
  catch { /* audit is best-effort, never blocks a request */ }
}

// ── SSRF guard ───────────────────────────────────────────────────────────────
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 127) return true;                         // loopback
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;            // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT / tailnet)
    return false;
  }
  if (net.isIPv6(ip)) {
    const lo = ip.toLowerCase();
    if (lo === '::1' || lo === '::') return true;
    if (lo.startsWith('fe80')) return true;             // link-local
    if (lo.startsWith('fc') || lo.startsWith('fd')) return true; // ULA
    if (lo.startsWith('::ffff:')) return isPrivateIP(lo.split(':').pop()); // v4-mapped
    return false;
  }
  return true; // unknown format → refuse
}

const BLOCKED_HOST = /(^|\.)(localhost|internal|local|lan|home|corp|intranet)$/i;

// Parse + scheme + DNS check. Returns { ok, ip } or { blocked, reason }.
async function guard(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return { blocked: true, reason: 'invalid URL' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { blocked: true, reason: `scheme ${u.protocol} not allowed` };
  const host = u.hostname;
  if (BLOCKED_HOST.test(host)) return { blocked: true, reason: `blocked host ${host}` };
  if (net.isIP(host)) {
    if (isPrivateIP(host)) return { blocked: true, reason: `private address ${host}` };
    return { ok: true, ip: host, url: u };
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { return { blocked: true, reason: `DNS lookup failed for ${host}` }; }
  for (const a of addrs) if (isPrivateIP(a.address)) return { blocked: true, reason: `${host} resolves to private ${a.address}` };
  return { ok: true, ip: addrs[0]?.address, url: u };
}

const clip = (s, n = MAX_TEXT) => { s = (s || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s; };

// ── /browser/fetch — no-JS fetch with per-hop SSRF re-check on redirects ─────
app.post('/browser/fetch', async (req, res) => {
  const t0 = Date.now();
  let url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    let hops = 0;
    while (hops++ <= MAX_REDIRECTS) {
      const g = await guard(url);
      if (g.blocked) { audit({ action: 'fetch', url, blocked: g.reason }); return res.status(400).json({ error: 'blocked', reason: g.reason }); }
      const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { 'User-Agent': 'JarvisBrowser/1.0' } });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = new URL(r.headers.get('location'), url).href; continue; }
      const ct = r.headers.get('content-type') || '';
      let body = await r.text();
      let title = null;
      if (/html/i.test(ct)) {
        title = (body.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
        body = body.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
      }
      audit({ action: 'fetch', url, status: r.status, ms: Date.now() - t0 });
      return res.json({ status: r.status, finalUrl: url, title, contentType: ct, text: clip(body) });
    }
    audit({ action: 'fetch', url, error: 'too many redirects' });
    return res.status(400).json({ error: 'too many redirects' });
  } catch (e) {
    audit({ action: 'fetch', url, error: e.message });
    return res.status(502).json({ error: e.message });
  }
});

// ── /browser/render — Playwright: screenshot + DOM + links ───────────────────
let browser = null, renderInFlight = 0, launching = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  // Memoise the LAUNCH, not just the result (2026-07-30, found by the
  // code-health spine's concurrency lens). Two renders arriving while no browser
  // existed both failed the isConnected() check and both awaited their own
  // chromium.launch(); the second assignment overwrote the first, leaving a live
  // Chromium with no handle to close it. On a box that also runs AlecRae,
  // Gluecron, GateTest and Coolify, a leaked browser is a Rule 4 problem — and
  // this file already carries a comment about 22 leaked gatetest processes.
  if (launching) return launching;
  launching = chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  }).then((b) => { browser = b; return b; }).finally(() => { launching = null; });
  return launching;
}

app.post('/browser/render', async (req, res) => {
  const t0 = Date.now();
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'url required' });
  const g = await guard(url);
  if (g.blocked) { audit({ action: 'render', url, blocked: g.reason }); return res.status(400).json({ error: 'blocked', reason: g.reason }); }
  if (renderInFlight >= MAX_CONCURRENT_RENDER) return res.status(429).json({ error: 'renderer busy, try again' });
  renderInFlight++;
  let ctx;
  try {
    const b = await getBrowser();
    ctx = await b.newContext({ userAgent: 'JarvisBrowser/1.0', viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    // Block any sub-request (and any redirect hop — Playwright's network
    // interception sees each hop as its own request) that targets a
    // private/loopback/metadata/tailnet address.
    //
    // SECURITY FIX (2026-07-26): this used to only check literal IP addresses
    // and a fixed hostname-suffix list — a hostname whose DNS record simply
    // points at 127.0.0.1/169.254.169.254/10.x/etc sailed through untouched,
    // since net.isIP() is false for a domain name. The initial URL got the
    // real DNS-resolving guard() check (below, before page.goto), but nothing
    // after that did. Now every request on this page — main navigation,
    // redirects, and subresources alike — gets the same guard() used by
    // /browser/fetch, so a rebinding hostname can't sneak a request to an
    // internal address through the render path.
    await page.route('**', async (route) => {
      const g = await guard(route.request().url()).catch(() => ({ blocked: true, reason: 'guard threw' }));
      if (g.blocked) return route.abort();
      return route.continue();
    });
    const resp = await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
    // See SETTLE_* above: wait for the network to go quiet so a client-rendered
    // page has actually painted, then a short settle for fonts/images. Both are
    // best-effort — a timeout here means "photograph it as it is", never fail.
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const title = await page.title().catch(() => null);
    const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    const links = await page.evaluate((max) => Array.from(document.querySelectorAll('a[href]')).slice(0, max)
      .map(a => ({ text: (a.innerText || '').trim().slice(0, 80), href: a.href })).filter(l => l.href.startsWith('http')), MAX_LINKS).catch(() => []);
    const file = `${SHOT_DIR}/render-${Date.now()}.png`;
    await page.screenshot({ path: file, fullPage: !!req.body?.fullPage }).catch(() => {});
    const finalUrl = page.url();
    audit({ action: 'render', url, finalUrl, status: resp?.status(), ms: Date.now() - t0 });
    res.json({ status: resp?.status() ?? null, finalUrl, title, text: clip(text), links, screenshot: file });
  } catch (e) {
    audit({ action: 'render', url, error: e.message });
    res.status(502).json({ error: e.message });
  } finally {
    renderInFlight--;
    if (ctx) await ctx.close().catch(() => {});
  }
});

// ── /browser/search — keyless DuckDuckGo (swap in a keyed provider later) ─────
app.post('/browser/search', async (req, res) => {
  const t0 = Date.now();
  const query = String(req.body?.query || '').trim();
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 6, 1), 10);
  if (!query) return res.status(400).json({ error: 'query required' });
  try {
    // Optional upgrade path: if BRAVE_SEARCH_KEY is set, use Brave's clean JSON API.
    if (process.env.BRAVE_SEARCH_KEY) {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        { headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_KEY, 'Accept': 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
      if (r.ok) {
        const j = await r.json();
        const results = (j.web?.results || []).slice(0, count).map(x => ({ title: x.title, url: x.url, snippet: x.description }));
        audit({ action: 'search', query, provider: 'brave', n: results.length, ms: Date.now() - t0 });
        return res.json({ provider: 'brave', results });
      }
    }
    // Keyless fallback: DuckDuckGo HTML endpoint.
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 JarvisBrowser/1.0' }, signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    // A blocked search is a failure, not an empty result set (2026-07-30, found
    // by the code-health spine). DuckDuckGo answers a rate-limited or blocked
    // scraper with 403/429 and an HTML page containing no `result__a` links, so
    // the parser below found nothing and this returned `{results: []}` with HTTP
    // 200 — the brain was told "there are no results for that", which it has no
    // way to distinguish from a genuine miss, and would answer Craig accordingly.
    if (!r.ok) {
      audit({ action: 'search', query, provider: 'duckduckgo', error: `HTTP ${r.status}` });
      return res.status(502).json({ error: `duckduckgo returned HTTP ${r.status}`, provider: 'duckduckgo' });
    }
    const html = await r.text();
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html)) && results.length < count) {
      let href = m[1];
      const dd = href.match(/uddg=([^&]+)/); if (dd) href = decodeURIComponent(dd[1]); // unwrap DDG redirect
      const title = m[2].replace(/<[^>]+>/g, '').trim();
      if (href.startsWith('http') && title) results.push({ title, url: href, snippet: '' });
    }
    // Zero results from a 200 page is the other quiet failure: this is a scraper
    // against someone else's HTML, so a class rename upstream turns every search
    // into "nothing found" indefinitely. Distinguish it in the audit log rather
    // than waiting to notice the brain has stopped being able to look things up.
    if (results.length === 0) {
      console.warn(`[browser] duckduckgo returned 200 but no parsable results for "${query.slice(0, 60)}" — check the result__a selector`);
      audit({ action: 'search', query, provider: 'duckduckgo', n: 0, unparsable: html.length, ms: Date.now() - t0 });
    } else {
      audit({ action: 'search', query, provider: 'duckduckgo', n: results.length, ms: Date.now() - t0 });
    }
    res.json({ provider: 'duckduckgo', results });
  } catch (e) {
    audit({ action: 'search', query, error: e.message });
    res.status(502).json({ error: e.message });
  }
});

// Honest health (2026-08-30, docs/RENDER-AUDIT-2026-08-30.md). This was a
// static 200 that never touched Chrome, so a service whose binary was missing
// answered {status:'ok'} forever while every render 502'd — the tts:true-
// while-every-synthesis-503'd class, on a different journey. Now: the binary
// is stat'd on every probe, and ?deep=1 actually launches Chrome (memoised —
// the launch is the same warm browser renders reuse, so a deep probe also
// pre-warms the render path). Chrome unlaunchable → 503. metrics-collector
// only checks the PORT is listening, so an honest 503 here cannot start an
// alert storm; experience-check is the consumer that acts on it.
app.get('/browser/health', async (req, res) => {
  const stat = chromeStatus(CHROME);
  let chromeOk = stat.ok, chromeError = stat.reason, chromeVersion = null;
  if (chromeOk && req.query.deep !== undefined) {
    try { chromeVersion = (await getBrowser()).version(); }
    catch (e) { chromeOk = false; chromeError = e.message; }
  }
  res.status(chromeOk ? 200 : 503).json({
    status: chromeOk ? 'ok' : 'degraded', service: 'jarvis-browser',
    chrome: CHROME, chromeOk, chromeError, chromeVersion, renderInFlight,
  });
});

app.listen(PORT, '127.0.0.1', () => console.log(`[jarvis-browser] loopback :${PORT} — search/fetch/render, SSRF-guarded, audit→${AUDIT}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await browser?.close(); } catch {} process.exit(0); });

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

const PORT = 9211;
const CHROME = process.env.CHROMIUM_BIN || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 15000;
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
let browser = null, renderInFlight = 0;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  return browser;
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
    // Block any sub-request that targets a private/loopback/metadata address.
    await page.route('**', async (route) => {
      try {
        const rh = new URL(route.request().url()).hostname;
        if (BLOCKED_HOST.test(rh) || (net.isIP(rh) && isPrivateIP(rh))) return route.abort();
      } catch { return route.abort(); }
      return route.continue();
    });
    const resp = await page.goto(url, { timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600); // let the above-the-fold settle
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
    audit({ action: 'search', query, provider: 'duckduckgo', n: results.length, ms: Date.now() - t0 });
    res.json({ provider: 'duckduckgo', results });
  } catch (e) {
    audit({ action: 'search', query, error: e.message });
    res.status(502).json({ error: e.message });
  }
});

app.get('/browser/health', (_req, res) => res.json({ status: 'ok', service: 'jarvis-browser', chrome: CHROME, renderInFlight }));

app.listen(PORT, '127.0.0.1', () => console.log(`[jarvis-browser] loopback :${PORT} — search/fetch/render, SSRF-guarded, audit→${AUDIT}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await browser?.close(); } catch {} process.exit(0); });

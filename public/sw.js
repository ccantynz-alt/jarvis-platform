/* MARCO Command Deck — service worker (2026-08-19, audit move 28).
 *
 * Deliberately minimal. The deck is a live WebSocket surface; caching its shell
 * would show a stale, dead deck with no explanation. What a phone needs instead
 * is an honest answer when the deck cannot be reached — which, on this
 * tailnet-only origin, almost always means "Tailscale is off on this device".
 *
 *   - navigations: network first; on failure, a deck-branded page that says so
 *     and offers RETRY (instead of Safari's "server cannot be found")
 *   - icons + manifest: cache-first (they never change without a new filename)
 *   - everything else (/api, /tts, /shot, WebSocket): untouched
 */
const VERSION = 'deck-sw-v1';
const STATIC = ['/deck.webmanifest', '/icons/deck-192.png', '/icons/deck-512.png', '/icons/deck-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});

const OFFLINE_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>MARCO — off the tailnet</title>
<style>body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#04060c;color:#d7e7f0;font-family:'IBM Plex Mono',ui-monospace,monospace;text-align:center;padding:24px;box-sizing:border-box}
h1{font-size:20px;letter-spacing:6px;color:#00e5ff;margin:14px 0 6px;font-weight:500}p{color:#8fb3c4;max-width:32em;line-height:1.6;margin:8px auto}
button{margin-top:18px;background:rgba(8,14,24,.8);color:#00e5ff;border:1px solid rgba(0,229,255,.5);border-radius:3px;padding:12px 22px;font:inherit;letter-spacing:2px;min-height:44px}
.dot{width:14px;height:14px;border-radius:50%;background:#ffb547;margin:0 auto;box-shadow:0 0 18px #ffb547}</style></head>
<body><div><div class="dot"></div><h1>MARCO</h1>
<p><b style="color:#ffb547">The deck can't be reached.</b></p>
<p>This address only exists on the tailnet. Open <b>Tailscale</b> on this device, make sure it's connected, then retry.</p>
<button onclick="location.reload()">RETRY</button>
<p style="font-size:11px;color:#40606f;margin-top:22px">If Tailscale is on and this persists, the box itself is unreachable — the off-box watchdog will have pushed an alert.</p>
</div></body></html>`;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(req, { signal: ctl.signal });
        clearTimeout(t);
        return r;
      } catch {
        return new Response(OFFLINE_HTML, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
      }
    })());
    return;
  }
  if (STATIC.includes(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) caches.open(VERSION).then(c => c.put(req, r.clone())).catch(() => {});
      return r;
    })));
  }
});

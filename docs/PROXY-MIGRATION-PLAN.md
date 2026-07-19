# Proxy Migration Plan — Consolidate 66.42.121.161 → Vapron's Proxy

**Status:** PLAN ONLY — no execution authorized. Awaiting Craig's go-ahead per move.
**Roadmap refs:** Move #4 (consolidate proxy layer, 4→1), Move #18 (migrate off Coolify → Vapron proxy, endgame of #4).
**Prepared:** 2026-07-19, via read-only investigation of 66.42.121.161 (`vultr`) and 149.28.119.158 (`mail.vapron.ai`, Vapron's box, tailnet 100.89.227.39).
**Scope:** This plan covers Move #18 only — replacing Coolify's Traefik as the proxy software fronting the apps that currently live on box 161. It does **not** cover Move #19 ("roll remaining platforms onto Vapron"), which is a much larger, separate migration of actual app *hosting* onto Vapron/158. Apps stay physically on 161 for this plan; only the proxy in front of them changes.

---

## 0. Corrections to CLAUDE.md doctrine (doctrine drift found)

CLAUDE.md's account of the proxy layer is mostly accurate but has real gaps. Corrections, so the next reader doesn't re-discover these:

1. **Coolify manages exactly one live app, and it isn't live through Coolify.** Coolify's Postgres (`applications` table) has a single row: `zoobicon.com:main-v9klj1r6...`, but its `fqdn` is the auto-generated `*.sslip.io` preview URL, not `zoobicon.com`. **`zoobicon.com` and `www.zoobicon.com` are actually Vercel-hosted** (confirmed: `Server: Vercel`, 307 → `www.zoobicon.com`, A record `216.150.1.1`). The Coolify "app" is dead cruft — it isn't in Traefik's routing at all beyond its own throwaway subdomain. Coolify's UI/DB/realtime stack is managing nothing real.
2. **Real routing bypasses Coolify's UI entirely.** All four live domains route via **hand-written Traefik file-provider YAML** dropped into `/data/coolify/proxy/dynamic/` by past Jarvis/Claude sessions (`gluecron.yaml`, `alecrae.yaml`, `gatetest-web.yaml`, `gatetest-mcp.yaml`), not via Coolify's docker-label provider. This is good news for migration: there's no Coolify project/app config to untangle, just four small static YAML files whose `Host()` rules and backend targets can be read 1:1 into the replacement.
3. **`bookaride` is also Vercel-hosted**, not on box 161 despite `platforms.json` listing `server: 66.42.121.161, path: /root/bookaride`, and despite Vapron's own `vapron-customer-router.service` comment claiming `bookaride.co.nz` is one of the domains it serves. Confirmed: `bookaride.co.nz` → A `216.150.1.193`, `www.bookaride.co.nz` → CNAME to `*.vercel-dns-*.com`. **Three sources of truth disagree about where bookaride lives** (Jarvis registry says 161, Vapron docs imply 158, DNS says Vercel) — flagged as separate doctrine-drift cleanup, out of scope here but worth a session.
4. **`gluecron-caddy-1` container on 161 is dead weight, not a second proxy layer.** It's a leftover Caddy container (bind-mounted `/opt/gluecron/Caddyfile`) from what its own file header calls "the metal-box deploy (45.76.171.37)" — a different box. It publishes no host ports and its logs show it endlessly failing ACME renewal (`network is unreachable` — no route to `acme-v02.api.letsencrypt.org`). It is not part of any live request path. Safe to ignore for this migration; flagged as a cleanup candidate.
5. **Stray clones on 161:** `/root/Vapron`, `/root/vapron-real`, `/root/vapron` exist alongside the canonical `/opt/vapron`-style layout used on 158. Not touched by this plan; flagged for Craig.
6. **CLAUDE.md's "4 front doors" is best read as:** (1) Coolify's Traefik on 161, (2) Coolify's own web UI/realtime on 161, (3) `tailscale serve` on 161 for Jarvis's own services, (4) Vapron's own Caddy+bun-gateway front door already running on 158. Move #4's "4→1" endgame is making Vapron's proxy (today's #4) the *only* front door across the whole estate — this plan is the first concrete slice of that (replacing #1 on 161), not the whole thing.

---

## 1. Verified current state — box 161 (66.42.121.161)

### 1.1 What's bound to :80/:443 today

```
0.0.0.0:80   → docker-proxy (coolify-proxy container, traefik:v3.6)
0.0.0.0:443  → docker-proxy (coolify-proxy container, traefik:v3.6)   [also 443/udp for HTTP/3 attempt]
0.0.0.0:6001/6002 → coolify-realtime
0.0.0.0:8000 → coolify (web UI, published as 8080→8000)
0.0.0.0:8080 → traefik dashboard (published by Coolify)
```

`coolify-proxy` is a Docker container; its 80/443 bind goes through Docker's userland `docker-proxy`, which binds `INADDR_ANY` (0.0.0.0) regardless of what IP you'd prefer — **this is the actual mechanical cause of the documented tailscale-serve-can't-use-443 gotcha** (see §5).

### 1.2 Live domains that depend on Coolify's Traefik (real customer-facing, must migrate)

Read from `/data/coolify/proxy/dynamic/*.yaml` (Traefik file provider) and confirmed live with direct `curl --resolve … 66.42.121.161` (bypassing DNS/CDN) — all returned 200 (mcp.gatetest.ai and api.alecrae.com 404 at `/`, which is expected/correct — they're API-only, no root route):

| Domain(s) | DNS today | Backend | Config file | Notes |
|---|---|---|---|---|
| `gluecron.com`, `www.gluecron.com` | direct A → 161 | `gluecron-gluecron-1:3000` (Docker network `gluecron_default`) | `gluecron.yaml` | Highest-profile product site. Has an `autoheal` sidecar — history of instability (CLAUDE.md documents a prior outage from a Traefik two-network hang). Do last, most carefully. |
| `gatetest.ai`, `www.gatetest.ai` | direct A → 161 | `10.0.1.1:3000` (host bridge, systemd `gatetest-web`) | `gatetest-web.yaml` | Craig's own product; moderate traffic. |
| `mcp.gatetest.ai` | direct A → 161 | `10.0.1.1:8787` (host, systemd) | `gatetest-mcp.yaml` | Remote MCP endpoint — lowest real-user traffic, best canary. |
| `alecrae.com`, `www.alecrae.com`, `mail.alecrae.com` | **Cloudflare-proxied** (A → `104.21.34.220`/`172.67.209.190`) | `10.0.1.1:4200` (host, Next.js) | `alecrae.yaml` | CF sits in front; origin is still 161's Traefik (confirmed live via `--resolve`). Cloudflare zone settings are outside SSH reach — Craig needs to confirm CF isn't proxying to some *other* origin before we touch anything (§8). |
| `api.alecrae.com` | Cloudflare-proxied | `10.0.1.1:4100` (host, Bun API) | `alecrae.yaml` | AlecRae's own frontend calls this via CSP `connect-src` — a live app depends on this staying up in real time. |

### 1.3 Confirmed NOT dependent on Coolify's Traefik (no action needed)

| Domain | Actual host | Evidence |
|---|---|---|
| `zoobicon.com`, `www.zoobicon.com` | **Vercel** | `Server: Vercel`, 307 → www, A `216.150.1.1` |
| `bookaride.co.nz`, `www.bookaride.co.nz` | **Vercel** | A `216.150.1.193`/`.16.193`, www CNAME → `vercel-dns-*.com` |
| `mail.vapron.ai` | **Already on Vapron/158** | A → `149.28.119.158` directly |
| `www.marcoreid.com`, `marcoreid.com` | Vercel | `Server: Vercel` |
| `www.davenroe.com`, `davenroe.com` | Vercel | `Server: Vercel` |

### 1.4 Resource headroom on 161

`free -h`: 7.7Gi total, ~4.2Gi "available" (3.9Gi is reclaimable buff/cache). 78G free disk. 4 vCPU. Enough headroom to run a lightweight Caddy + bun-gateway pair alongside the existing stack (Vapron's own sizing docs budget ~512M–1G high-water per service).

---

## 2. Verified Vapron proxy capability — box 158 (149.28.119.158)

### 2.1 What each relevant service actually does (read from unit files + source + docs, not assumed)

- **`vapron-bun-gateway.service`** — a real, general-purpose HTTP/HTTPS reverse proxy (Hono/Bun, `~1,900` lines across `index.ts`/`vhost.ts`/`proxy.ts`/`config.ts`/`certs.ts`/`upstream.ts`). Two modes, switched by one env flag (`GATEWAY_BEHIND_PROXY`):
  - **Standalone** (flag unset — historically the default): terminates TLS itself on :80/:443 via `CAP_NET_BIND_SERVICE` (no root needed), own ACME client, own cert dir (`/var/lib/vapron-gateway/certs/`).
  - **Behind-Caddy** (flag=1, **current production mode on 158 as of today**, confirmed: `systemctl is-active caddy` → active, `ss -tlnp` shows `caddy` on 158's :80/:443, `bun` not on those ports): Caddy does TLS+HTTP/3, forwards plain HTTP to bun-gateway on loopback `:8090`.
  - **Crucially, it already has a static, non-database-driven routing table for exactly this use case**: `/etc/vapron-gateway/config.json` has a `"custom"` array — `{label, hosts[], port}` — that proxies arbitrary hostnames straight to a loopback port, with the same WAF/rate-limit/security-header middleware as Vapron's own named services (`services/bun-gateway/src/vhost.ts` → `makeCustomApp()`). **This is functionally identical to what the Traefik dynamic YAML files on 161 do today.** Config.json today already lists `alecrae` (→:4100), `alecrae-web` (→:4200), and `bookaride` (→:8101) entries — evidently a prior, never-completed attempt at exactly this migration. Verified these entries are **not currently live**: TLS handshakes to 158 for `alecrae.com` fail (on-demand-TLS cert-allow gate rejects it — it isn't a registered tenant domain), and 158 has no vhost for it in the rendered `/etc/caddy/Caddyfile`. Treat this config as **stale/aspirational, not evidence of a working migration** — but it does prove the plumbing exists and has been exercised before.
- **`vapron-customer-router.service`** — loopback-only (`127.0.0.1:8080`), reads Host header, looks up a Turso/libSQL DB (`project_domains`/`projects.port`) for **Vapron's own multi-tenant hosting customers**, forwards to their instance. This is Vapron's *product* data-plane, not a general Traefik replacement — it's scoped to domains registered in Vapron's own tenant DB via the customer dashboard. **Not directly applicable to box 161's apps** unless AlecRae/GateTest/Gluecron were actually onboarded as Vapron hosting customers (Move #19 territory, out of scope here).
- **`vapron-tunnel-edge.service`/`vapron-tunnel-origin.service`** (BLK-019) — a reverse-tunnel pair for exposing an origin that sits behind NAT/no-public-IP to a public edge. The unit file's own comment says both daemons currently run **colocated on this single box** as a loopback proof-of-concept, "not yet proven across real network hops" in production. **Box 161 already has its own public IP** and doesn't need tunneling to reach the internet — this component is irrelevant to migrating 161's proxy and should not be pulled into this plan.
- **`vapron-edge-runtime.service`** — a V8-isolate runtime for running *customer* serverless functions (Vapron's own product feature). Unrelated to reverse-proxying.
- **Caddy front door** (`docs/CADDY_FRONT_DOOR_CUTOVER.md`, ACTIVE since 2026-06-13) — thin, stock Caddy binary, terminates TLS/HTTP2/HTTP3, static vhosts from `infra/bare-metal/Caddyfile.template` for platform domains, **on-demand TLS** (mints a cert on first handshake, gated by a synchronous `cert-allow` HTTP callback) for tenant subdomains/custom domains. Has a documented, tested rollback path (flip `GATEWAY_BEHIND_PROXY=0`, stop Caddy) — this pattern (thin static TLS front door, hot-reloadable, with an explicit rollback runbook) is exactly the shape we want to replicate on 161.

### 2.2 Verdict: is Vapron's proxy a real Traefik replacement, or product-only plumbing?

**Both, and it matters which piece you use.** The **low-level piece** (Caddy for TLS + bun-gateway `"custom"` static host→port list) is simple, small, already production-proven for Vapron's own platform domains (vapron.ai, api.vapron.ai, etc. all serve real 200s today), and is a legitimate, low-risk Traefik replacement for a **static** list of domains like the five on 161. The **high-level piece** (customer-router, tenant DB, on-demand TLS cert-allow, dashboard-driven domain onboarding/rollback/promote) is Vapron's actual hosting *product* — and a fresh, independently-verified 171-agent production-readiness audit dated **today, 2026-07-19** (`/opt/vapron/docs/PRODUCTION_READINESS_AUDIT_2026_07_19.md`, 349 findings after dedup) found real, severe bugs in exactly that layer — e.g. the dashboard's Rollback/Promote buttons flip a DB flag but never call the real route-swap ("production traffic keeps serving the previous build" while the UI shows success), and the custom-domain verification poller has zero production callers so a domain can get stuck in `verifying-txt` forever.

**Recommendation: use only the low-level piece (Caddy + bun-gateway static `"custom"` config) for this migration. Do not route box-161 domains through Vapron's tenant DB / customer-router / on-demand-TLS / dashboard system.** That system is mid-flight product work with known-broken pieces; box 161's four production domains should not become collateral damage to Vapron's own product bugs.

---

## 3. Recommended target architecture

**Option A (recommended): install Vapron's Caddy + bun-gateway pair locally on box 161**, statically configured for the four real domains, replacing `coolify-proxy` (Traefik). Apps stay exactly where they are (`gluecron-gluecron-1:3000` on the Docker network, `10.0.1.1:{3000,4100,4200,8787}` on the host bridge). This mirrors box 158's own proven pattern and needs no cross-box networking, no tunnel daemons, no changes to Vapron's tenant DB.

**Option B (rejected for this plan): route 161's domains through box 158's existing edge via the BLK-019 tunnel.** Architecturally this is the "true" single-front-door endgame for the whole estate, but it requires: DNS repointing every domain to 158's IP, a tunnel-origin daemon on 161 per app, and depends on tunnel infrastructure that is explicitly documented as an unproven, loopback-only proof-of-concept. This is Move #19-shaped work (roll platforms onto Vapron), not Move #18 (swap the proxy software). Revisit as a later, separate plan once Option A has proven stable and the tunnel daemons have real cross-box mileage.

### 3.1 Why a "strangler fig," not a big-bang cutover

All five domains resolve to the **same IP** (66.42.121.161) and therefore share the **same socket** (`:80`/`:443`). You cannot migrate them one at a time at the DNS level — whoever owns the socket serves *all* of them. Two honest options:

- **(a) Single flip:** stop `coolify-proxy`, start the new stack bound to 80/443 with all five domains pre-configured, verify, rollback = reverse the two commands (~10–20s each way). Simple, but one outage window covers all five domains at once, and if domain #4 has a config bug you find out live.
- **(b) Strangler fig (recommended):** put the **new** Caddy on :80/:443 from the start, but give it a catch-all rule that reverse-proxies anything *not yet migrated* back to Traefik (moved to an internal-only port, e.g. `127.0.0.1:18443`/`18080`). Then migrate one hostname at a time by adding it to Caddy's real vhost list and removing it from the fallback — each step is a **config reload, not a service swap**, individually verifiable and individually reversible without touching the socket again. The only "risky" event is the one-time swap of who owns the public socket, and even that has a same-second rollback.

This plan uses (b). It costs slightly more setup effort but matches Craig's ask ("staged, reversible... verify each stage before proceeding").

---

## 4. Staged migration plan

### Stage 0 — Build and dry-run the shadow stack (zero production risk)

1. On 161, install Caddy (stock binary, matches 158's "no xcaddy" approach) and copy `services/bun-gateway` from the Vapron repo (or install as a standalone systemd unit modeled directly on `vapron-bun-gateway.service`).
2. Configure `config.json`'s `"custom"` array with the four real entries, pointed at 161's *actual* backends:
   ```json
   { "label": "gatetest-mcp", "hosts": ["mcp.gatetest.ai"], "port": 8787 },
   { "label": "gatetest-web", "hosts": ["gatetest.ai", "www.gatetest.ai"], "port": 3000 },
   { "label": "alecrae-api",  "hosts": ["api.alecrae.com"], "port": 4100 },
   { "label": "alecrae-web",  "hosts": ["alecrae.com", "www.alecrae.com", "mail.alecrae.com"], "port": 4200 },
   { "label": "gluecron-web", "hosts": ["gluecron.com", "www.gluecron.com"], "port": "???" }
   ```
   Note: `gluecron`'s backend is a **Docker container on the `gluecron_default` network** (`gluecron-gluecron-1:3000`), not a host-bridge port like the others. bun-gateway proxies to a loopback port, so either (i) publish `gluecron-gluecron-1:3000` to a loopback host port (`127.0.0.1:3010:3000` in its compose file — a one-line, reversible change to `gluecron`'s *own* compose, not Traefik's config) or (ii) join the new proxy process to the `gluecron_default` Docker network so it can reach the container by name. (i) is simpler and matches the pattern already used for the other three apps (host-bridge ports).
3. Bind Caddy + bun-gateway to **alternate ports only** (e.g. `18080`/`18443`) — Traefik keeps 80/443 untouched.
4. **Verify every domain against the shadow stack**, exactly like the earlier investigation curls:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' --resolve gluecron.com:18443:66.42.121.161 https://gluecron.com:18443/
   # repeat for all 5 hostnames — expect the same status codes Traefik gives today
   ```
5. **Rollback:** none needed — nothing production-facing has changed. Just stop the shadow services.
6. **Exit criteria to proceed:** all five domains return matching status codes on the shadow stack, TLS certs issue cleanly (Let's Encrypt via HTTP-01 — confirm rate limits aren't hit; Traefik already holds valid certs for these names, so LE issuance for the same names on a different ACME account/path should be fine but worth a dry run first, see §7).

### Stage 1 — The one risky event: swap the public socket, with instant rollback

1. Reconfigure Traefik (in Coolify's `docker-compose.yml` for `coolify-proxy`, a config file, not touching co-tenant *apps*) to publish `18080:80`/`18443:443` internally instead of `80:80`/`443:443`. Restart just that one container.
   - **Verify:** all five domains still return 200/404-as-expected via `curl --resolve … :18443:66.42.121.161`.
   - **Rollback:** revert the compose port mapping, restart `coolify-proxy` — back to today's state in under a minute.
2. Reconfigure the shadow Caddy+bun-gateway to bind the *real* `80`/`443`, with a catch-all fallback that reverse-proxies any host **not** in its explicit vhost list to `127.0.0.1:18443` (Traefik's new home). At this point every one of the five domains is still being served — just via one extra hop through the new front door to old Traefik, since none have been added to Caddy's real vhost list yet.
   - **Verify:** `curl -I https://gluecron.com/` (real public request, no `--resolve` trick) for all five domains — should be indistinguishable from before Stage 1 started.
   - **Rollback:** stop the new Caddy/bun-gateway, restore Traefik's `80:80`/`443:443` publish, restart `coolify-proxy`. Same one-minute rollback as step 1.
3. **Exit criteria:** 15–30 minutes of the fallback-through-new-front-door path with zero error-rate increase (check each app's own health endpoint / access logs), confirmed by Craig before continuing.

### Stage 2 — Migrate `mcp.gatetest.ai` (lowest risk: single API endpoint, no browser traffic, easy to test)

1. Add `mcp.gatetest.ai` → `:8787` to Caddy/bun-gateway's real vhost list (config reload, `systemctl reload` — no restart, no dropped connections per the hot-reload design already built into `vapron-bun-gateway.service`'s `ExecReload=/bin/kill -HUP $MAINPID`).
2. Remove it from the "not yet migrated" set so it no longer falls through to old Traefik.
3. **Verify:** `curl -s -o /dev/null -w '%{http_code}\n' https://mcp.gatetest.ai/` (expect same 404-at-root as before) + hit a real MCP tool call if one exists + check GateTest's own logs for the request landing correctly.
4. **Rollback (this stage only):** remove the vhost entry, reload — instantly falls back through to Traefik again. No socket change, no other domain affected.

### Stage 3 — Migrate `gatetest.ai` + `www.gatetest.ai`

Same mechanism as Stage 2. Verify with a real browser check of the homepage (screenshot via Jarvis's own `jarvis-screenshot` service per CLAUDE.md Rule 2 — "rendered UI is proven by looking at it") plus a couple of internal page loads. Rollback identical in shape to Stage 2.

### Stage 4 — Migrate `api.alecrae.com`

Higher stakes: AlecRae's own web frontend calls this live (CSP `connect-src https://api.alecrae.com`). Verify with `curl https://api.alecrae.com/health` (AlecRae's deploy script already treats this exact health check as its own go/no-go signal — reuse it) **and** load `alecrae.com` in a browser and confirm no console/network errors against the API before calling this stage done. Rollback identical in shape.

### Stage 5 — Migrate `alecrae.com` + `www.alecrae.com` + `mail.alecrae.com`

Verify with a full page-load screenshot + confirm `Content-Security-Policy` header still matches, since it's a Next.js app with an explicit CSP that would be very sensitive to a proxy dropping/mangling headers. Rollback identical in shape.

### Stage 6 — Migrate `gluecron.com` + `www.gluecron.com` (do last, most carefully)

Highest-profile, has a documented prior outage (the two-network Traefik hang, CLAUDE.md Gotchas). Recommend an explicit low-traffic maintenance window even though the mechanism is the same trivial vhost-list edit as the other stages, purely because this is the one Craig is most likely to hear about if it goes wrong. Verify with: homepage screenshot, `gluecron-autoheal` container logs (confirm it doesn't restart anything post-cutover), and a real login/health-check flow if one exists. Rollback identical in shape.

### Stage 7 — Soak, then decommission the fallback path and Traefik

1. Run for an agreed soak period (recommend 48–72h) with all five domains served directly by the new stack and the "fall through to Traefik" rule now unused (verify via Traefik's own access logs showing zero requests in the soak window).
2. Remove the fallback rule from Caddy (nothing left to fall through to).
3. Stop and remove `coolify-proxy` (Traefik) container. **Do not** touch `coolify`/`coolify-db`/`coolify-redis`/`coolify-realtime` in this same step — treat the Coolify UI/DB stack's decommission as a separate decision (§7), since move #4's "4→1" also implies eventually removing it, but it's zero-risk to leave dormant a while longer and isn't blocking anything.
4. Update `CLAUDE.md`'s "PORTS ON THIS BOX" table and Gotchas section in the same commit (Rule 0), and flip Move #4/#18 in `docs/ROADMAP.md` + `config/roadmap.json` with a `notify()` per Rule 0's extension.

### Stage 8 (optional, separate go/no-go) — Reclaim standard :443 for Jarvis's own tailnet services

See §5 below. This is a genuine possible side-benefit, not a required part of the migration, and should be validated empirically (not assumed) after Stage 7, then executed as its own small, separately-reversible change.

---

## 5. The tailscale :443 constraint — does this migration lift it?

**Likely yes, but must be verified, not assumed — and only if Caddy is deployed as a native systemd process bound to an explicit IP, not left to bind `0.0.0.0`.**

The documented failure (`tailscale serve` can't get `:443` because `bind: address already in use`) is almost certainly caused by **Docker's userland `docker-proxy`**, which — regardless of what you'd prefer — publishes container ports on `INADDR_ANY` (`0.0.0.0`), claiming *every* interface including the tailscale interface's IP. A **natively-run Caddy** (systemd, no Docker, exactly how it runs on 158) can be told to bind an *explicit* address in its global config (e.g. the box's public IP, `66.42.121.161`, not the wildcard), which on Linux coexists cleanly with a separate process binding the tailscale interface's own IP (`100.109.131.122`) on the same port 443 — because the more specific bind takes precedence for its own interface and the wildcard bind never needed to claim it in the first place. Removing `docker-proxy` from the equation (which this migration does, by construction) removes the actual root cause.

**Recommendation:** after Stage 7 is stable, as a standalone low-risk experiment, explicitly bind the new Caddy to the box's public IP only, then test `tailscale serve --https=443` for one Jarvis service (start with `jarvis-dashboard`, lowest-stakes) and confirm with a real `curl https://jarvis.tailbd6217.ts.net/health` per the "verify, don't trust `serve status`" lesson already baked into the Gotchas doc. If it works, migrating `gateway`/`deck`/`dashboard` off `8443`/`8444`/`8445` onto standard `:443` is a nice simplification (no more non-standard ports to remember, PWA/bookmark URLs get cleaner) — but it's genuinely optional, touches Craig's own daily-use tools (voice interface), and should be its own small change with its own rollback, done well after the core migration has proven stable, not bundled into the same maintenance window.

---

## 6. Domain migration order (summary table)

| Order | Domain(s) | Traffic/stakes | Why this position |
|---|---|---|---|
| 1 | `mcp.gatetest.ai` | Lowest — API-only, dev/agent tool | Best canary: easy to verify, no browser/UI surface, no customer-visible failure mode |
| 2 | `gatetest.ai` + www | Low–moderate | Craig's own product, no third-party dependents found |
| 3 | `api.alecrae.com` | Moderate–high | Live app depends on it in real time (CSP `connect-src`), but has its own health check to reuse |
| 4 | `alecrae.com` + www + mail | Moderate–high | Browser-facing, CSP-sensitive; do after the API leg is proven |
| 5 | `gluecron.com` + www | Highest | Most customer-facing, documented outage history — last, with a maintenance window |
| 6 | Fallback removal + Traefik decommission | — | Only after a soak period with zero Traefik hits |
| 7 (optional) | tailscale serve → standard :443 | — | Separate decision, after core migration is stable |

---

## 7. Things NOT confident about — need Craig's direct input before ANY execution

1. **DNS/Cloudflare control.** `alecrae.com`/`mail.alecrae.com`/`api.alecrae.com` are Cloudflare-proxied. No Cloudflare API token was found on either box (only `.env.example` placeholders), so this plan could not directly confirm Cloudflare's origin/zone configuration — everything about "CF forwards to 161" is inferred from consistent 200 responses when hitting 161 directly with the right Host header, not confirmed via CF's own DNS records. **Craig needs to confirm** CF isn't secretly pointed at some other origin, and needs to be the one who can act on CF if a zone-level change is ever needed (this plan doesn't require one, but worth surfacing).
2. **Zero-downtime vs accepted maintenance window.** This plan is designed to be near-zero-downtime (config reloads, not service restarts, for every per-domain stage), with one brief internal reshuffle in Stage 1 that's invisible to the public if done right. But Craig should say explicitly whether he wants a formal announced maintenance window regardless (especially for Stage 6/gluecron.com), or is comfortable with the "quiet, reversible steps" approach this plan defaults to.
3. **Is Vapron's proxy actually the piece Craig wants to depend on for production traffic tonight, given the fresh production-readiness audit?** This plan deliberately scopes usage to the small, mature, already-proven low-level piece (Caddy TLS + bun-gateway static custom-host proxying) and explicitly avoids the higher-level product surface with known bugs. Craig should confirm he's comfortable with that scoping — it's a real, meaningful subset of "Vapron's proxy," but it is not the full self-service hosting product.
4. **What happens to Coolify's UI/DB/realtime stack.** Traffic-wise it's already dead weight (one orphaned app), but removing it entirely is a separate decision from removing Traefik — Craig may still want the Coolify UI around for future one-click deploys, or may want it gone as part of "4→1." This plan leaves that as an open, later call (Stage 7 step 3 note).
5. **The stray `bookaride` doctrine mismatch and the dead `gluecron-caddy-1` container / stray `/root/vapron*` clones** — none of these block this migration, but they're real drift worth a separate cleanup session; flagging so they don't get silently assumed "handled" by this plan.
6. **LetsEncrypt rate limits.** Issuing fresh certs for the same five hostnames on a new ACME client while Traefik's existing certs (in `/data/coolify/proxy/acme.json`) are still valid hasn't been tested — worth a dry run with LE's staging environment first, or reusing/exporting the existing cert material, to avoid an avoidable rate-limit surprise mid-migration.
7. **`gluecron` backend port publish.** Stage 0 step 2 proposes a one-line change to `gluecron`'s own `docker-compose.yml` (publish `127.0.0.1:3010:3000`) so the new proxy can reach it without joining its Docker network. This is a change to Gluecron's *own* config (not Traefik's), technically outside "don't touch co-tenant config" in the strictest reading — flagging explicitly rather than assuming it's fine, since Rule 4 exists for a reason.

---

### Critical Files for Implementation

- `/data/coolify/proxy/dynamic/gluecron.yaml`, `alecrae.yaml`, `gatetest-web.yaml`, `gatetest-mcp.yaml` (on 161) — source of truth for exact current `Host()` rules and backend targets to replicate
- `/data/coolify/proxy/docker-compose.yml` (on 161) — Traefik's own container definition; the Stage 1 port-remap edit happens here
- `/opt/vapron/services/bun-gateway/src/{index.ts,vhost.ts,config.ts,proxy.ts}` (on 158) — the reverse-proxy code to install/adapt on 161
- `/etc/vapron-gateway/config.json` and `/etc/systemd/system/vapron-bun-gateway.service` (on 158) — config + unit templates to copy and adapt for 161
- `/opt/vapron/infra/bare-metal/Caddyfile.template` and `docs/CADDY_FRONT_DOOR_CUTOVER.md` (on 158) — the proven Caddy-front-door pattern and its own tested rollback runbook to mirror
- `/opt/jarvis/CLAUDE.md` and `docs/ROADMAP.md` / `config/roadmap.json` (this repo) — must be updated in the same commit as any real execution, per Rule 0

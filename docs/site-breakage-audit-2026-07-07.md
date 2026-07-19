# Site-Breakage Root-Cause Audit — vultr (66.42.121.161)

**Date:** 2026-07-07 09:1x UTC
**Author:** Jarvis (read-only stability audit for Craig)
**Method:** read-only only — `journalctl`, `systemctl`, `docker logs/inspect/stats`, `ss`, `free`, `df`, `dmesg`. No restarts, no config changes, no deploys, no writes except this file.

---

## Bottom line (verdict)

**The box itself is NOT the problem.** It is not melting down, not OOMing, and not crash-looping.
Hard evidence:

- **Zero OOM kills in the entire journal history** (Jul 05 → now). `journalctl -k | grep -i oom` → nothing; `dmesg` → nothing.
- **Zero automatic restarts** on every relevant systemd service (`NRestarts=0` for all `jarvis-*`, `alecrae-*`, `gatetest-mcp`).
- **Zero docker restarts** — `RestartCount=0` and `OOMKilled=false` on every container.
- **Resources are idle:** 5.6 GiB RAM available of 7.7 GiB; swap 466 MiB of 5.3 GiB; disk 44% (81 GB free). Heaviest container is `coolify` at 178 MiB. Nothing is near a limit.
- **Fleet health probe is steady, not flapping:** 46 consecutive 10-minute samples are *byte-identical* —
  `jarvis=200 zoobicon=200 vapron=200 gluecron=200 alecrae=503 marcoreid=200 davenroe=200 bookaride=200 voxlen=200 gatetest=000 gatetest-mcp=200`.

So "the sites keep breaking" is **plumbing, deploy automation, and external-hosting blind spots** — not the server crashing. The two things that ARE down right now (alecrae, gatetest) are down for *known, external, non-box* reasons. Below, ranked by how much they actually explain the breakage Craig feels.

**Important distinction — "actually broke" vs "currently down for a known external reason":**
- *Currently down, external, expected:* `alecrae=503` (Cloudflare Pages / off-box origin), `gatetest=000` (site never deployed).
- *Actually caused instability on the box:* the gluecron auto-deploy loop (1,927 failures) and the alecrae-api Redis reconnect loop (850k+ errors) — noise/churn engines that degrade everything around them.
- *Fragile but currently holding:* gluecron's multi-network Traefik route and hand-written proxy override.

---

## Ranked root causes

### 1. External-hosting blind spots — the sites break where the box cannot see or heal them  `SEVERITY: HIGH`

Several "sites" are not served from this box at all. When they break, nothing on this box logs it, alerts on it, or can fix it — which is exactly the "randomly broken, no idea why" experience.

**Evidence — enumeration of where each platform actually lives:**

| Platform | Served from | On this box? | Current status |
|---|---|---|---|
| gluecron.com | `gluecron-gluecron-1` container → Coolify Traefik | **Yes** | 200 |
| zoobicon | Coolify container :3000 (`v9klj…` sslip route) | **Yes** | 200 |
| gatetest-mcp | systemd `gatetest-mcp` :8787 → Traefik | **Yes** | 200 |
| jarvis-* | systemd :9200–9207 (internal) | **Yes** | up |
| **alecrae.com / mail.alecrae.com** | **Cloudflare Pages** + `api.alecrae.com` origin on a **different box (149.28.119.158)** | **No** | **503** |
| **gatetest.ai** | not deployed anywhere | No | **000** |
| **marcoreid, davenroe** | **Vercel** | No | 200 |
| **vapron** | old box `149.28.119.158` (migration pending) | No | 200 |
| **bookaride, voxlen** | external | No | 200 |

- **alecrae = 503 is entirely off-box.** `/opt/alecrae/infrastructure/cloudflare/wrangler.toml` shows it is a **Cloudflare Pages** app (`pages_build_output_dir = apps/web/.next`), API at `https://api.alecrae.com`. `/opt/alecrae/scripts/box-deploy.sh` says it deploys to box **149.28.119.158**, not this one. The `alecrae-api`/`alecrae-web` units running here on `127.0.0.1:4100/:4200` are a **different, private origin** — they are *not* what the public hits, so restarting them here would not fix the 503. No `cloudflared`/tunnel exists on this box (`/etc/cloudflared` absent, no `cloudflared` process), so there is no path from Cloudflare to these local services anyway.
- **gatetest.ai = 000** because the site was never deployed (confirmed by MORNING-REPORT-2026-07-07 §1: "GateTest site still isn't deployed"). Traefik's ACME failures for `gatetest.ai` are a *symptom* of "no site behind the domain," not a cert bug.

**Affects:** alecrae, gatetest.ai, marcoreid, davenroe, vapron, bookaride, voxlen.
**Fix:** External monitoring for every off-box domain (the `jarvis-fleet-check` timer already does this — keep/extend it and alert on non-200). Fix the alecrae public origin at Cloudflare Pages / `api.alecrae.com` (off-box work). Decide the consolidation strategy (Vapron) so there aren't 4 proxy/hosting systems each with its own invisible failure mode.

---

### 2. Deploy automation that fails in a tight loop — gluecron auto-deploy  `SEVERITY: HIGH (historical churn), now dormant`

**Evidence:**
- `gluecron-update.service` failed **1,927 times** across journal history:
  ```
  auto-update.sh: fatal: could not read Username for 'https://github.com': No such device or address
  gluecron-update.service: Main process exited, code=exited, status=128/n/a
  ```
- Its timer fired **every 60 seconds** (`OnUnitActiveSec=60s`, `OnBootSec=2min`, unit `Description=Run Gluecron auto-deploy every minute`). Every minute it tried `git pull` on `/opt/gluecron`, failed on missing git credentials, and logged a failure.
- The timer is now **disabled** (`gluecron-update.timer  disabled`), which is why gluecron is currently stable at 200.

Two distinct fragilities here:
1. **Broken git credentials** → the auto-deploy could never succeed (1,927 consecutive failures = journal noise + a dead "self-updating" promise).
2. **The design itself is dangerous:** a 60-second pull-and-rebuild cadence means that whenever it *does* authenticate, it rebuilds/restarts the gluecron container roughly every minute → route churn, transient 502s, and container recreation on the multi-network setup below. A working version of this timer would break gluecron.com *more*, not less.

**Related — gluecron is not Coolify-managed and its Traefik route is hand-wired:**
- `com.docker.compose.project.config_files=/root/gluecron/docker-compose.yml,/root/gluecron/docker-compose.traefik.yml` — the Traefik labels live in a **hand-written override file**, not in Coolify. If a redeploy runs `docker compose up` without the override, gluecron loses its route entirely.

**Affects:** gluecron.com.
**Fix:** Keep `gluecron-update.timer` disabled, or if auto-deploy is wanted: (a) fix git creds (deploy key / credential helper), (b) trigger on webhook/new-commit — never a blind 60s loop, (c) bring gluecron under Coolify management so the Traefik route is generated, not hand-maintained.

---

### 3. alecrae-api Redis mis-wiring — a live infinite reconnect loop  `SEVERITY: MEDIUM–HIGH (ongoing)`

**Evidence:**
- `error: connect ECONNREFUSED 127.0.0.1:6379` appears **850,118 times** in the journal (~5/sec, continuous). Still firing now:
  ```
  Jul 07 09:17:09 vultr bun[1733]: [webhook-worker] Worker error: connect ECONNREFUSED 127.0.0.1:6379
  ```
- PID 1733 = **alecrae-api** (`/usr/local/bin/bun run apps/api/src/index.ts`, the :4100 service).
- `/opt/alecrae/.env` has `REDIS_URL=redis://127.0.0.1:6379`.
- **Nothing listens on host `:6379`.** `ss -tlnp | grep 6379` → nothing. The only Redis is `coolify-redis`, which lives on the `coolify` **docker network**, not host loopback — alecrae-api (a host process) cannot reach it there.

Consequences: the alecrae `webhook-worker` is permanently broken (whatever it drives — queues/webhooks — never runs); it burns CPU spinning (contributes to the load-avg 2.64 seen with an otherwise idle box); and it has bloated the journal to **3.9 GB**, which shortens how far back *all* diagnostics can see. This is a real, ongoing malfunction even though the health probe still shows the box "up."

**Affects:** alecrae background/webhook features (and box-wide log/CPU hygiene).
**Fix:** Point `REDIS_URL` at a Redis alecrae-api can actually reach (run a local redis, or use the coolify-redis address reachable from the host), or disable the webhook-worker if Redis isn't needed. This is safe, on-box, and stops ~850k log lines/day.

---

### 4. Multi-network Traefik route — fragile but currently mitigated  `SEVERITY: MEDIUM (latent)`

This is the classic "container on 2 docker networks → Traefik picks the wrong one → hang/502" pattern.

**Evidence:**
- `coolify-proxy` (Traefik) is on **one** network: `coolify` only.
- `gluecron-gluecron-1` is on **two**: `coolify=10.0.1.5` **and** `gluecron_default=10.0.2.2`.
- **Currently mitigated** by an explicit label: `traefik.docker.network=coolify`, so Traefik correctly targets `10.0.1.5`. Confirmed: no `dial tcp` / `connection refused` / 502/503/504 backend errors in Traefik logs over 168h.

Why it still matters: the mitigation is one hand-written label in the manual `docker-compose.traefik.yml`. If that override is dropped on a redeploy (see cause #2), Traefik can start resolving gluecron on `10.0.2.2` (the `gluecron_default` net it can't reach) → the exact "app is healthy but the route hangs" breakage. This is very likely the mechanism behind past gluecron outages.

**Affects:** gluecron.com (potential).
**Fix:** Ensure the `traefik.docker.network=coolify` label is guaranteed on every deploy (Coolify management does this automatically), or attach gluecron to a single shared proxy network.

---

### 5. Loopback-bound services unreachable by containerised Traefik  `SEVERITY: LOW (mostly by-design here)`

**Evidence (`ss -tlnp`):**
- `alecrae-api` → `127.0.0.1:4100`, `alecrae-web` → `127.0.0.1:4200` (bound loopback, `HOST=127.0.0.1` in units).
- `gatetest-mcp` → `*:8787` (all interfaces) **correctly**, with a matching ufw rule `8787/tcp ALLOW IN 10.0.1.0/24 # gatetest-mcp: traefik->host service` — so Traefik-in-container reaches it via the host on the coolify subnet. This one is wired right.
- jarvis services on `127.0.0.1:9200–9207` (internal, correct) — note `9206` is on `0.0.0.0` (publicly exposed) which is worth a glance but is not a stability issue.

For alecrae the loopback binding is moot for public traffic (its public path is Cloudflare Pages / off-box), so this is not currently *causing* the 503 — but it's why "the local alecrae is up" and "alecrae.com is 503" are both true at once, which is a confusing footgun.

**Fix:** None urgent. If alecrae is ever meant to be Traefik-fronted from this box, it must bind to `0.0.0.0` with a ufw allow like gatetest-mcp, not `127.0.0.1`.

---

### 6. Backups silently failing — gluecron-backup  `SEVERITY: MEDIUM (data-loss risk, not site breakage)`

**Evidence:** `gluecron-backup.service` is the **only** unit in `systemctl --failed`. It fails **every night at 00:00**:
```
Jul 07 00:00:04 backup.sh: service "postgres" is not running
gluecron-backup.service: Failed with result 'exit-code' (status=1)
```
The backup script expects a `postgres` compose service that isn't running in the gluecron stack (only `gluecron-gluecron-1` is up; gluecron likely uses an external DB). So nightly DB backups have been silently no-op'ing. Doesn't break the live site, but it's an unguarded data-loss risk.
**Fix:** Point the backup at the real database (external DB connection string), or delete the dead timer if backups are handled elsewhere.

---

### 7. Ruled out — things that look scary but aren't the cause

- **Traefik ACME "errors" are scanner noise, not cert breakage.** Over 168h Traefik logged only 20 ACME lines (10× "Cannot retrieve the ACME challenge", 5× "missing token", 5× "Unable to get token") with fake challenge tokens like `index.php` and `*` — these are internet scanners probing `/.well-known/acme-challenge/index.php`, not real Let's Encrypt validations. Real certs are valid: `gluecron=200` over HTTPS in every fleet-check sample. The `www.gluecron.com` / `www.gatetest.ai` "missing token" entries are low-impact (www DNS not pointed here / site not deployed).
- **screenshot-to-code** exited 137 on **Jul 02** (`RestartPolicy=no`, `OOMKilled=false`), is not restarting, and consumes nothing. It's simply off — not a source of ongoing breakage.
- **The Jul-06 08:39 reboot** (uptime 1 day) shows **no kernel panic and no OOM** in the pre-reboot logs — just the usual redis/gluecron error spam, then a clean boot. Likely hypervisor/host maintenance or a manual reboot; a single event, not a recurring crash.

---

## Top 3 things to fix (prioritised)

1. **Fix the alecrae-api Redis wiring (cause #3).** Point `REDIS_URL` at a reachable Redis or disable the `webhook-worker`. Highest bang-for-buck: it's on-box, safe, stops a live ~850k-lines/day reconnect loop, frees CPU, and un-bloats the 3.9 GB journal so future diagnostics can see further back. *(Requires a config change — out of scope for this read-only audit; flagged for approval.)*

2. **Make the off-box platforms visible and fix alecrae's real origin (cause #1).** The breakages Craig actually feels are on Cloudflare Pages (alecrae 503) and un-deployed gatetest.ai — invisible to this box. Keep `jarvis-fleet-check` and add alerting on any non-200; repair the alecrae Cloudflare Pages / `api.alecrae.com` origin; deploy gatetest.ai. Longer-term, consolidate the four routing systems (Coolify Traefik / Cloudflare / per-site DNS / Vapron Caddy) onto one — that's the real cure for the whack-a-mole.

3. **De-fang gluecron deploy + routing fragility (causes #2 & #4).** Keep `gluecron-update.timer` disabled (or fix git creds and switch it from a blind 60s loop to a commit-triggered deploy), and guarantee the `traefik.docker.network=coolify` label survives every redeploy (ideally by bringing gluecron under Coolify management instead of the hand-written `docker-compose.traefik.yml`). This closes the most likely mechanism behind past gluecron.com outages.

---

*All findings are read-only observations. No services, containers, configs, or sites were modified. This report is the only file written.*

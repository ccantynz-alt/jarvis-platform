# Vapron → Jarvis Box Migration — Phase 0 Recommendation

**Author:** overnight read-only investigation agent
**Date:** 2026-07-06
**Target box:** `66.42.121.161` (this box — runs Coolify, gluecron, Zoobicon, AlecRae, Jarvis)
**Source box:** `149.28.119.158` (Vultr Chicago — where Vapron production actually runs today)
**Scope:** read-only investigation. No changes were made to anything except writing this file. No Vapron checkout, service, or website was modified.

> **Honesty note:** This is a Phase-0 desk study done entirely from the three checkouts on this box. I did **not** log into the live Vapron box (`149.28.119.158`), so the real running footprint, real data location, and real service count are inferred from repo docs, not measured. Treat the "fit" numbers as compose-file declarations, not observed reality. The biggest unknowns are called out explicitly.

---

## 1. Canonical repo/branch pick

### The three checkouts

| Path | GitHub remote | Branch | HEAD commit | Commit date | Working tree | Size |
|---|---|---|---|---|---|---|
| `/root/vapron` | `ccantynz-alt/vapron` (lowercase) | `real-main` | `380ad62` | 2026-06-30 22:30 | dirty — 6 items incl. 2 GB `.next/` build cruft, `SPRINT_BLOCKERS.md`, edited routes | **2.0 G** |
| `/root/Vapron` | `ccantynz-alt/Vapron` (capital) | `Main` | `8ff283e` | 2026-07-01 21:48 | near-clean — 3 minor uncommitted (`.gitignore`, `CLAUDE.md`, a stray `gatetest-scan.js`) | 153 M |
| `/root/vapron-real` | `ccantynz-alt/vapron` (lowercase) | `Main` | `ed8b2da` | 2026-06-30 07:17 | clean (0 uncommitted) | 60 M |

### The two-repo (vapron vs Vapron) split — resolved

The two GitHub repos are **mirrors of one history, not divergent forks.** Evidence:

- Both repos' `origin/Main` remote-tracking ref resolves to the **same commit** `8ff283e9` with identical top-5 log.
- The lowercase repo's object store contains the capital tip (`8ff283e`), and the capital repo's object store contains the lowercase `real-main` tip (`380ad62`). Shared objects ⇒ shared history.

So there is effectively **one codebase** published under two repo names. I **cannot** determine from this box alone which GitHub repo Craig actually pushes to as the source of truth. Pointers toward the capital `Vapron`:

- `CLAUDE.md` states **"Default branch: `Main` (capital M)"** — only the capital checkout is on `Main` at the live tip.
- The product name is "Vapron"; capital-V matches.
- (Muddying it: `CLAUDE.md` also says the historical remote was "Crontech" and the workspace scope is `@back-to-the-future/*`. Naming in this project is genuinely messy — do not over-read it.)

### Recommendation

**Use `/root/Vapron` (capital, `ccantynz-alt/Vapron`, branch `Main`, tip `8ff283e`) as the canonical working checkout.** It is on the documented default branch, sits exactly on `origin/Main` HEAD (0 ahead / 0 behind), is the newest (2026-07-01) and highest commit count (3527), and is essentially clean.

**Action item for Craig (cannot be resolved from the box):** confirm which GitHub repo is the true push target. If it is the lowercase `vapron`, the capital checkout still holds the same `origin/Main` code, so nothing is lost — just re-point the remote. Until confirmed, treat "which repo name is canonical" as an open question, not a settled fact.

### What to do with the other two checkouts

- **`/root/vapron-real`** — clean but **stale**: its local `Main` is at `ed8b2da` (2026-06-30 07:17), ~a day and ~33 commits behind `origin/Main`. It is a fine fallback but should not be the working copy. Safe to keep read-only or delete after confirming `/root/Vapron` is the keeper.
- **`/root/vapron`** — a **scratch/working copy**: parked on side branch `real-main`, carrying 2 GB of `.next/` build artifacts and uncommitted edits. Not canonical. Candidate for deletion once its uncommitted edits (`object-store.tsx`, `deploys.tsx`, `SPRINT_BLOCKERS.md`) are confirmed to be either merged or disposable. **Do not delete before Craig checks those uncommitted diffs** — they are the only things on this box not also in `origin/Main`.

---

## 2. What the production stack requires

### Two different deployment models exist — this matters

There is a material gap between the compose file and how production actually runs:

**Model A — `docker-compose.production.yml` (self-contained standalone).** A tidy 5-service core + optional observability profile. This is what the task pointed at. But note two caveats:
- Its `caddy` service bind-mounts `./infra/caddy/Caddyfile`, **which does not exist in the repo** (only `infra/bare-metal/Caddyfile.template` exists). As-is, `docker compose up` would fail on the Caddy service until a Caddyfile is created. The compose is somewhat aspirational.
- It bundles its own Caddy on `:80/:443` and omits the bun-gateway / WAF / deploy pipeline that the live doctrine treats as load-bearing.

**Model B — the actual live production (per `CLAUDE.md`).** The real box runs a **systemd hybrid**, not this compose:
- **Caddy** (apt/systemd, `caddy.service`) is the public front door on `:80/:443`, doing TLS + **on-demand per-customer-domain certs** (core to the PaaS).
- **bun-gateway** (`vapron-bun-gateway.service`) on loopback `:8090` = WAF, bot defence, rate-limit, host routing, blue-green.
- **deploy-agent** on `127.0.0.1:9099`, self-polling `origin/Main` every 60s.
- **~56 services** under `services/` wired into the API.
- Data via **Turso** (external hosted SQLite, primary), **Neon** (external Postgres, optional), **Qdrant** (vectors).

These are not the same migration. Model A is far simpler but is not what's in production; Model B is what actually serves `vapron.ai` today.

### Model A service inventory (from `docker-compose.production.yml`)

**Core (always on):**

| Service | Image / build | Exposed port | Mem limit | Mem reservation | Public? |
|---|---|---|---|---|---|
| caddy | `caddy:2-alpine` | **80, 443, 443/udp** | 256 M | 64 M | **YES (host-bound)** |
| web | build (SolidStart SSR / Bun) | 3000 (internal) | 512 M | 128 M | no |
| api | build (Hono + Bun) | 3001 (internal) | 1 G | 256 M | no |
| qdrant | `qdrant/qdrant:v1.12.5` | 6333/6334 (internal) | 1 G | 256 M | no |
| orchestrator | build (Bun) | 9000 (internal) | 512 M | 128 M | no |

Core totals: **~3.28 G limit ceiling / ~832 M reservations.** Only Caddy binds host ports.

**Observability profile (`--profile observability`, opt-in):**

| Service | Image | Mem limit |
|---|---|---|
| otel-collector | `otel/opentelemetry-collector-contrib:0.114.0` | 512 M |
| loki | `grafana/loki:3.2.0` | 512 M |
| tempo | `grafana/tempo:2.6.1` | 512 M |
| mimir | `grafana/mimir:2.14.2` | 512 M |
| grafana | `grafana/grafana:11.3.0` | 512 M |

Observability adds **~2.5 G** of limit ceiling. Full stack ≈ **5.78 G** limits.

Named volumes (stateful): `vapron-caddy-data`, `vapron-caddy-config`, `vapron-qdrant-data`, `vapron-api-data`, plus loki/tempo/mimir/grafana-data when observability is on.

### The proxy collision (flag)

`docker-compose.production.yml`'s Caddy wants host **`:80`, `:443`, and `:443/udp` (HTTP/3)**. On this box those are already owned by **Coolify's Traefik** (`coolify-proxy`, `traefik:v3.6`), which also holds **`:8080`**. Two processes cannot bind the same host port. This is a hard collision, detailed in §4.

---

## 3. Fit analysis on this box

### Current state of `66.42.121.161`

- **RAM:** 7.7 Gi total, 1.5 Gi used, **5.8 Gi available** (6.0 Gi buff/cache), 5.3 Gi swap.
- **CPU:** 4 cores.
- **Disk:** 150 G, 69 G used, **75 G free** (48%).
- **Running containers (docker):** Coolify core + proxy(Traefik) + db(pg15) + redis + realtime + sentinel; `gluecron`; one Coolify-managed app container. Measured container memory totals only ~**0.6 G** right now — the box is lightly loaded. (Zoobicon / AlecRae / Jarvis appear to be Coolify-managed apps or idle; I could not positively map each named tenant to a container in a read-only snapshot.)

### Verdict: **needs a trimmed profile AND the proxy question solved first — does not drop in as-is.**

- **RAM — trimmed core fits, with caveats.** Core-only reservations (~832 M) fit comfortably in 5.8 Gi headroom; even the 3.28 G limit ceiling leaves ~2.5 Gi buffer. **Drop the observability profile** (`loki/tempo/mimir/grafana/otel`, ~2.5 G) — the full 5.78 G stack would leave almost no margin on a 7.7 Gi box shared with Coolify. Grafana LGTM is the obvious thing to cut for Phase 0.
- **Big RAM caveat:** the 5-service compose (Model A) is **not** the real platform (Model B has ~56 services + bun-gateway + deploy pipeline). If the intent is to run *real* Vapron here, the true footprint is unknown and likely well beyond these numbers. Fit for Model A ≠ fit for production Vapron.
- **CPU:** 4 cores is adequate for the trimmed core at low traffic; build steps (`--build web api orchestrator`) will spike. Fine for Phase 0.
- **Disk:** 75 G free is plenty for images + volumes; not a blocker.
- **Ports:** the `:80/:443` collision is the real blocker, not RAM (see §4).

---

## 4. Hard blockers

### Blocker 1 — Proxy collision on `:80/:443` (the gating issue)

Coolify's Traefik owns `:80`, `:443`, `:443/udp`, `:8080` on this box and fronts gluecron.com + Zoobicon. Vapron's front door (whether the compose Caddy in Model A or the systemd Caddy in Model B) also demands `:80/:443` — **and it needs them for on-demand per-customer-domain TLS**, which is a core PaaS feature, not incidental. Options, none clean:

- **(a) Vapron behind Traefik** (Traefik terminates TLS, routes by host to `web:3000` / `api:3001`). Lowest disruption to existing tenants, **but** it strips Vapron's on-demand customer-domain certificate flow — arguably breaks the product. Only viable if customer custom domains are out of scope for Phase 0.
- **(b) Retire/relocate Coolify off `:80/:443`.** The stated end-goal is for Vapron to *replace* Coolify, so this is the strategically-aligned path — but it's a real project (re-home gluecron + Zoobicon behind Vapron's Caddy) and is disruptive; not a Phase-0 drop-in.
- **(c) Second IP / separate box.** Cleanest technically; defeats the "put it on this box" goal.

**Recommendation:** decide the proxy model **before** any migration work. This single decision gates everything else.

### Blocker 2 — RAM / true footprint uncertainty

Model A trimmed core fits. But if "migrate Vapron" means the real Model B platform (~56 services), the box's 7.7 Gi is likely **insufficient** and this needs measurement on the live box before committing. Do not size off the compose file.

### Blocker 3 — Stateful data (partly not even on the source box)

What a migration must account for:

- **`vapron-api-data`** volume — SQLite `vapron.db` + API app data (compose default `DATABASE_URL=file:/data/vapron.db`).
- **`vapron-qdrant-data`** — vector collections.
- **`vapron-caddy-data`** — ACME account + issued TLS certs (customer domains). Losing this forces re-issuance and risks Let's Encrypt rate limits.
- **Live-box-only state (Model B):** `/var/lib/vapron/active-port` (blue-green pointer), `/etc/vapron-gateway/config.json` (vhost routing), and **customer-deployed apps** — the actual tenant workloads, the biggest unknown and the hardest thing to move.
- **External managed data:** `.env.production.example` shows the primary DB is **Turso** (hosted SQLite) and optionally **Neon** (hosted Postgres). If production genuinely runs on Turso/Neon, much of "the database" is **not on the source box at all** — migration becomes a *re-point of connection strings*, not a data copy. **This must be confirmed on the live box** — it materially changes migration difficulty in either direction.

---

## 5. Recommended Phase-0 next action

**Do not migrate yet.** The sequence:

1. **Confirm the canonical GitHub repo with Craig** (capital `Vapron` vs lowercase `vapron`). Adopt `/root/Vapron` as the working checkout regardless; re-point the remote if needed. Preserve `/root/vapron`'s uncommitted diffs until Craig reviews them, then reclaim its 2 GB.
2. **Make the proxy decision first** (Blocker 1). Everything downstream depends on whether Vapron fronts its own `:80/:443` (implying Coolify must move) or sits behind Traefik (implying no on-demand customer TLS in Phase 0). This is a Craig call, not an engineering default.
3. **Inventory the live box `149.28.119.158`** (read-only) before sizing anything: which of the ~56 services actually run, real RAM/CPU/disk in use, and — critically — **where production data actually lives** (local volumes vs Turso/Neon external). This turns the guesses in §3–§4 into facts.
4. **If a Phase-0 proof is wanted on this box:** stand up **Model A core only** (caddy+web+api+qdrant+orchestrator, **no observability**) on a **test hostname and non-privileged ports** (do not touch `:80/:443`), pointed at a throwaway Turso/SQLite, purely to validate the images build and boot here. This proves buildability without disturbing Coolify/gluecron/Zoobicon. It is **not** a production migration.

**Bottom line:** the code-side canonical pick is clear (`/root/Vapron` @ `Main`). The migration itself is blocked on two decisions only Craig/the live box can settle — the `:80/:443` proxy ownership and where production data really lives — and on the gap between the simple compose file and the much larger real platform. Recommend resolving those before committing to any move.

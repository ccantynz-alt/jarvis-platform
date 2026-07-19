# Overnight Report — 2026-07-07 (for Craig)

**Nothing was pushed, deployed, or made live. No colours/design changed. Every change is committed locally only, waiting for your review.** Box stayed healthy all night (no crashes, no OOM).

---

## TL;DR — what needs a decision from you

1. **The "100%" website goal is a flawed target** — read the website section. All 46 *real* errors are fixed and the build is green; a literal 100% is blocked by scanner false-positives + an AI check that fights correct fixes. Decide how far you actually want to chase it.
2. **GateTest site still isn't deployed** — "just needs a cert" wasn't the whole story; it needs a running site first. Blocked on your Vapron-vs-compose call.
3. **Vapron migration** — canonical repo is `/root/Vapron`; it does NOT drop onto this box as-is. Two decisions needed (below).
4. **Cloud executor** is built but off — needs a real cloud API endpoint/token before you flip it on.

---

## 1. GateTest website — the 40% → 100% job (honest result)

**What got done:** all **46 gate-blocking errors fixed** (secrets, code-quality, error-swallow, hardcoded-URL, env-vars). Modules passing went 40/45 → **44/45**. `next build` green, eslint green. Committed locally in `/opt/gatetest` as `3d48fc2`. **Zero colour/design/layout changes** — the one user-visible text case was fixed so the rendered output is byte-identical.

**But it did NOT reach a literal 100%, and here's the honest why** — this matters more than the number:
- The last gate-blocking "error" is GateTest's **own AI `fakeFixDetector`** flagging a *correct* dead-import removal. GateTest's `codeQuality` rule demands you remove unused imports; `fakeFixDetector` flags you for removing them. **No state satisfies both** for a legitimately-dead import. The tool contradicts itself.
- Most remaining warnings are **scanner false-positives**: `http://www.w3.org` SVG namespaces (must be http or SVG breaks), JSX paren "imbalance" from a line-counter, `.map(async)` calls that *are* wrapped in `Promise.all` on the next line.
- The biggest lever (151 dead-code warnings) is **risky to auto-remove** — `noUnusedLocals` turns de-exporting into build-breaking errors; some are Next.js instrumentation hooks that must stay exported.

**My honest take:** the meaningful win — every real error fixed, build green — is done. Getting to a cosmetic 100/100 would mean contorting valid code to satisfy false positives or deleting dead code at the risk of the build. **I'd stop here and instead decide whether the GateTest scanner's own rules need tuning** (the self-contradiction is a real bug in *your* product worth fixing). Your call.

## 2. Orchestrator runCloud upgrade — DONE, flag-off

Built `pickExecutor` + `runCloud` + `/dispatch/callback` (`src/executors.js` + `src/orchestrator.js`, commit `c76e5ea`). **Off by default — behaviour is byte-identical to today until you set `JARVIS_CLOUD_ENABLED=1`.** Verified: `node --check` clean, test instance on :9299 unregressed, live :9205 never touched.

Gives Jarvis **self-repair** (`platform=jarvis` → cloud agent, so it can fix its own box from off-box).

**To enable (morning, when ready):** add to `config/secrets.env` then `systemctl restart jarvis-orchestrator`:
- `JARVIS_CLOUD_ENABLED=1`, `JARVIS_CLOUD_TOKEN=…`, `JARVIS_CLOUD_ENV=…`, `JARVIS_CALLBACK_URL=…` (public URL → /dispatch/callback, since orchestrator is loopback-only).
- **Still needs human confirmation:** the exact cloud API endpoint + auth scheme (defaulted to a best guess). Don't enable until confirmed.

## 3. Vapron migration — Phase-0 findings (full doc: `docs/vapron-migration-phase0.md`)

- **Canonical repo: `/root/Vapron`** (capital, branch `Main`, tip `8ff283e`). The lowercase `vapron` and capital `Vapron` are mirrors of one history, not forks. `/root/vapron` has 2GB of `.next/` cruft + uncommitted edits — **don't delete it before you review those diffs.**
- **Does NOT fit as-is.** The 5-service compose core fits, but the *real* Vapron on the old box (`149.28.119.158`) is ~56 services and likely exceeds this 7.7GB box. Needs a trimmed profile.
- **Hard blocker: :80/:443.** Coolify's Traefik owns them; Vapron's Caddy needs them for per-customer TLS. No clean in-place answer — retiring Coolify is a real project, not a config tweak.
- **Good news:** the DB is likely external (**Turso**), so migration may be a connection-string re-point, not a data copy.
- **Two decisions needed from you:** (a) confirm which GitHub repo you actually push to; (b) the :80/:443 proxy-ownership call.

## 4. Why "the sites keep breaking" — evidence, not vibes

Checked it: **the box is healthy.** 5.9GB RAM free, **zero OOM kills in 24h**, **zero crash-looping services** (everything at 0 restarts). The instability you feel is **plumbing, not crashes** — DNS→proxy→app layers snapping while the apps underneath run fine (gluecron's app was healthy but its route hung; alecrae's app runs but its public path is broken; gatetest's engine works but isn't deployed). You have four different proxy/routing systems (Coolify Traefik, Cloudflare, per-site DNS, Vapron Caddy) each with its own failure mode. **Consolidating onto one (Vapron) is the actual cure for the whack-a-mole** — that's why your instinct is right.

## Still open / deferred (not done overnight, by design)
- GateTest site deploy (needs the Vapron-vs-compose decision + its `.env.local` secrets + port conflicts).
- `screenshot-to-code` still down (OOM'd 3 days ago) — one `docker compose up -d` from being back, your call.
- alecrae.com 503 — public origin (Cloudflare Pages/k8s) not serving; the healthy `:4200` local instance is a *different* origin.

---
*All commits local. `git log origin/main..HEAD` in /opt/jarvis shows the 3 unpushed commits; /opt/gatetest has 1 unpushed. Push nothing until you've reviewed.*

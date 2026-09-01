# RENDER JOURNEY AUDIT — why "show me" never works (2026-08-30)

Commissioned by Craig: "big deep audit, journeys/render — it never works, it's
been broken for some time." Method: full static trace of the render journey
end-to-end (`show_me`/`render_page` → `/browser/render` → deck
`/internal/show` → `/shot/:name` → `showThing`), plus docs/LESSONS archaeology
and test-coverage analysis. Run from a remote sandbox — the box was NOT
reachable from here, so §6 is the on-box checklist that pinpoints the live
fault in ~2 minutes. Complements docs/JARVIS-SYSTEM-AUDIT-2026-07-17.md.

---

## 1. Executive summary

The journey's plumbing is sound. The render leg — playwright-core launching
Chrome inside browser-service — is the one leg with a hard external-binary
dependency, and it is simultaneously:

1. **invisible when broken** — `/browser/health` is a static 200 that never
   touches Chrome (browser-service.js:289);
2. **watched by a check that trusts that lie** — `checkShowMe({browserOk})`
   is fed `!!(/browser/health JSON)` (experience-check.js:147,
   lib/experience.js:274), so the experience timer reports "capture path
   healthy" while every render 502s;
3. **completely untested** — no test file imports or references
   browser-service.js at all; nothing anywhere launches Chrome, calls
   `resolveChrome()`, or hits `POST /browser/render`. `npm run health`
   probes the same static health route;
4. **shipped with the exact config shape that already broke it once** —
   `secrets.env.example:51` still ships `CHROMIUM_BIN=chromium-browser`, a
   bare name; browser-service.js:25-44's own comment records that a bare
   name made "/browser/render fail EVERY call" while screenshot capture
   kept working. `resolveChrome()` patches this — but when no candidate
   exists it returns the bare name and every render fails at launch,
   per-request, with the service green.

So search/fetch stay green, port 9211 stays listening, metrics stays quiet,
experience-check passes, `npm test` passes — and Craig is the only detector.
That is precisely "never works, broken for some time." This is the
tts:true-while-every-synthesis-503'd defect class (LESSONS 2026-08-16),
reproduced on a different journey; voiceState() got the "probe the REAL
path" fix (experience-check.js:83-89), the browser check never did.
LESSONS' own rule was skipped here: "a check passes only on positive
evidence — something answered — never because nothing threw."

## 2. The journey, link by link (static verdicts)

| Link | Verdict | Notes |
|---|---|---|
| brain tool `show_me` (brain-tools.js:514-535) | ✅ sound | Correctly refuses to claim shown when `shown:false`; honest error strings |
| `browserCall` timeout (brain-tools.js:38) | ⚠️ marginal | 30s cap vs worst-case render ≈ cold Chrome launch + 15s nav + 6s networkidle + 0.9s settle + screenshot — a slow site aborts client-side |
| `/browser/render` (browser-service.js:176-229) | ❌ the break | Depends on CHROME resolving to a real, launchable binary; nothing verifies it, ever |
| SSRF guard (browser-service.js:82-123) | ✅ by design | Blocks loopback/10.x/tailnet/CGNAT — meaning "show me the deck/dashboard" or any tailnet URL can NEVER work, by ruling. If /etc/hosts on the box maps our own domains to 127.0.0.1, every "show me <our site>" is also blocked ("resolves to private") — check §6 |
| deck `/internal/show` + `/shot/:name` (deck-server.js:194-224) | ✅ sound | Auth, basename-only, triple traversal guard all present |
| deck client `showThing` (command-deck.html:2965-2992) | ✅ sound | `#showpanel` is at MAIN level, z-31, overlays all tabs incl. mobile; escaping + http(s)-only href verified by test |

## 3. Failure history (all of it at the same leg)

- **2026-07-17** BROWSER-TOOL.md: built, "verified end-to-end" — the claim
  that later proved false.
- **2026-07-26** DNS-rebinding hole in the render path (in-code stamp).
- **2026-07-30** concurrent renders leaked an unhandled Chromium; DDG 403
  returned `{results:[]}` as HTTP 200.
- **2026-08-11** first real show_me put DavenRoe's "Loading…" spinner on
  screen (domcontentloaded-only); SETTLE added. render_page "had been
  reading half-built pages all along."
- **undated (pre-graft)** bare `CHROMIUM_BIN=google-chrome` failed every
  render while screenshots worked; `resolveChrome()` added.
- **2026-08-19** AUDIT-FORCE-OF-NATURE: `render_page` returns a path string;
  "the model never sees pixels" — still true (brain-tools.js:540).
- Also: install.sh installs/prefers **Chromium** while browser-service
  defaults to `/usr/bin/google-chrome` and BROWSER-TOOL.md documents system
  Google Chrome — installer and service assume different browsers.
- git note: this checkout is shallow (grafted at 865c9f9, 2026-08-20), so
  pre-graft fixes are dated from comments/docs, not hashes.

## 4. Root-cause candidates on the box, ranked

1. **Chrome unlaunchable** — binary missing/moved, or apt/snap replaced it,
   or version drifted past playwright-core 1.61.1's protocol. Failure mode:
   every render 502s "executable doesn't exist" / launch error; service
   green. (Matches "never works" exactly.)
2. **cgroup OOM** — Chrome children live inside jarvis-browser.service's
   `MemoryMax=1536M`. A modern page can push node+Chrome past 1.5G; the
   kill lands mid-render. Failure mode: intermittent 502/hangs on real
   pages, small pages fine. No browser dropin exists to have raised it.
3. **Own-domain DNS** — /etc/hosts (or split DNS) mapping estate domains to
   127.0.0.1/10.x makes guard() block exactly the sites Craig asks for:
   "blocked: resolves to private…".
4. **30s browserCall abort** — cold launch + slow site exceeds the client
   timeout; render actually completes but the tool already gave up.

## 5. Designed fixes (smallest set that ends the blindness + the break)

1. **Honest health**: `/browser/health` gains `chromeOk` —
   `statSync(CHROME)` on every call, plus a `?deep=1` that actually
   `getBrowser()`s (launch + version + leave it warm) — and returns 503
   when Chrome is unlaunchable. Fail loud and free (doctrine 6).
2. **experience-check probes the real path**: `checkShowMe` takes
   `chromeOk` from the deep probe, not process liveness — the exact voice
   fix, ported. Announce on change / daily / recovery, never alert-level.
3. **config-integrity test**: assert `CHROMIUM_BIN` in secrets.env.example
   is absolute OR resolveChrome()-resolvable on the box; align install.sh,
   the service default, and BROWSER-TOOL.md on ONE browser.
4. **A `jarvis-browser.service.d` dropin** (the only service without one):
   pin absolute `CHROMIUM_BIN`; revisit `MemoryMax=1536M` with Chrome in
   the cgroup.
5. **Timeout ledger**: raise browserCall's render timeout above the
   server-side worst case (launch + NAV 15s + SETTLE 6.9s + shot), or
   lower the server budget — one commit, both sides (the brain-tier rule).
6. **Regression test carrying this incident** (doctrine 1): a test that
   starts browser-service with a bogus CHROMIUM_BIN and asserts
   `/browser/health` goes unhealthy — the class no current test can catch.

## 6. On-box checklist (run first — pinpoints the live fault in ~2 min)

```bash
# 1. what does render actually say?
curl -s -X POST 127.0.0.1:9211/browser/render -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com"}' | head -c 600
# 2. what has it been saying? (the audit log is the flight recorder)
tail -20 /opt/jarvis/logs/browser-audit.jsonl
# 3. what is CHROME resolved to, and does it exist/launch?
curl -s 127.0.0.1:9211/browser/health
grep CHROMIUM_BIN /opt/jarvis/config/secrets.env
ls -l /usr/bin/google-chrome* /usr/bin/chromium* 2>/dev/null
# 4. OOM evidence?
journalctl -u jarvis-browser -n 50 | grep -iE 'oom|kill|error'
systemctl show jarvis-browser -p MemoryMax -p MemoryPeak
# 5. own-domain DNS trap?
getent hosts davenroe.com alecrae.com vapron.ai
```

Interpretation: (1) failing with "executable doesn't exist"/launch error →
candidate 1; "blocked: resolves to private" → candidate 3; timeout/hang with
OOM lines in (4) → candidate 2; (1) succeeding but show_me still failing →
the fault is upstream in the brain call, check the 30s abort (candidate 4)
and `/root/.claude/projects/-opt-jarvis/*.jsonl` for the tool result.

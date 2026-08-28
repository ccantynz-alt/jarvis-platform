# LESSONS.md — the incident record behind the doctrine

> Every rule in CLAUDE.md was paid for by something on this page. CLAUDE.md
> holds the current truth and the constraint; this file holds the WHY — dates,
> evidence, and the failure that made the rule. When you are tempted to relax
> a constraint, read its entry here first. Rule 0 applies to this file too:
> if an entry is contradicted by the box, fix the entry.
>
> Created 2026-08-07 by moving the accumulated narratives out of CLAUDE.md.

---

## Voice & the open mic

**The echo loop, three times "fixed" (2026-07-26 → 2026-07-31).** Jarvis
transcribed his own TTS as Craig's input. The rule that held: *an open mic
pointed at a speaker cannot be rescued by a text-similarity heuristic* — the
ear must be SHUT while Jarvis talks, on every platform. What was wrong in
`public/command-deck.html` (gateway.html was correct and is the template):
(1) `pumpSpeech` aborted recognition only `if (IS_IOS)` while desktop ran one
long-lived continuous session, so the mic stayed open through the whole reply;
(2) `v2TalkOver` admitted any 3+ word utterance the echo filter missed;
(3) the follow-up window sent anything it heard with no echo check. All closed
by `closeEar()` (aborts everywhere, called when a turn leaves and from
`pumpSpeech`) plus `isSelfEcho()` in the post-speech window. The filter is
**LCS, not a contiguous run** — STT mangles speaker echo ("queued"→"cute") and
one dropped word desynchronises a fixed-offset match; a verbatim 50-word echo
scored under threshold before the rewrite. Ordering is still required (that is
what separates echo from shared vocabulary); gaps are not. Floors that must
stay: under `ECHO_MIN_WORDS` nothing is dropped ("yes"/"stop"/"do it"), past
`ECHO_WINDOW_MS` nothing is judged, and a drop is always shown on screen — a
silent drop is indistinguishable from a broken assistant and cost an evening.
**Cost accepted by Craig 2026-07-31: no voice barge-in.** Interrupt with
Escape, the STOP bar, or the mic button. A headset with hardware AEC is the
only safe route to talk-over — a hardware change, not a code change.
Tests: `test/deck-echo.test.js` (carries the two real 2026-07-31 echoes).

**The live-mic eavesdrop (2026-08-06, fixed 2026-08-07, `98adb70`).** A deck
tab sat in MIC LIVE mode for 14+ hours — the mode was persisted in
localStorage, so it survived every reload — and transcribed **23 minutes of a
private household conversation**, sending every ~20s fragment to the brain and
speaking a reply to each one. "stop it" got "Stopping, sir." and the mic
stayed hot. The diagnostic tell: user turns with NO wake word reaching the
brain (wake mode would have dropped them). Three bounds now, pinned by
`test/deck-live-mic.test.js`: LIVE never survives a page load; LIVE expires
after 30 min with an on-screen notice; the wake-mode follow-up window stops
re-arming after `FOLLOWUP_CHAIN_MAX` consecutive turns that never said
"Jarvis" (an eavesdrop never says the name; a real conversation does — the
chain resets on any wake hit, mode tap, or manual interrupt).

**Diagnose ANY voice weirdness the same way first:**
`curl 127.0.0.1:9200/memory/kv/jarvis-conversation` and read the `user` turns.
Jarvis's own sentences there = echo (the mic, not the brain). No-wake-word
room talk there = a live/held-open mic. One command, minutes to answer.

**Gateway voice needs the https `.ts.net` name, never a raw IP** — iOS Safari
grants mic/STT only in secure contexts, and iOS `speechSynthesis` must be
primed by a user gesture (gateway.html does this on first mic tap) or replies
stay silent.

---

**A capture is only as good as what had painted (2026-08-11).** The first real
`show_me` put DavenRoe's **"Loading…" spinner** on Craig's screen: the render
path waited for `domcontentloaded` + 600ms, and a client-rendered app has
painted nothing at that point. Half the web is SPAs, so a "show me" that
photographs spinners is worthless. Now: `waitForLoadState('networkidle')`,
BOUNDED (a page that polls or holds a websocket never reaches networkidle at
all) plus a short settle — both best-effort, because a picture arriving late is
a worse failure than one arriving slightly early. The same fix improves
`render_page`, which had been reading half-built pages all along.
*Second thing that capture taught:* the panel's fixed `max-height` on the image
pushed the "open it properly" link off the bottom — the one control that turns a
photograph back into a usable page. The image now shrinks and the footer never
does. Both were found by LOOKING at the screenshot (Rule 2), not by testing.

## The brain

**Subscription-only (Craig's ruling 2026-07-26).** On 2026-07-25 a total
outage made the failover loop land on metered `anthropic`, and because a
successful failover persists to KV `brain-provider` it STAYED there, billing
metered tokens silently; `secrets.env` separately had `BRAIN_PROVIDER=gemini`,
so clearing the KV would have pinned a *different* metered API. Hence: metered
providers gated behind `BRAIN_ALLOW_METERED=1` (default unset), removed from
failover via `keyFor()` in one place; both accounts exhausted → THROW, degrade
to keyword-intent, fire a total-outage `notify()` — loud and free, never quiet
and metered. If the brain seems to be on the wrong provider check BOTH places
(they drifted apart before): KV `brain-provider` AND `grep BRAIN_PROVIDER
config/secrets.env`. Fastest check: the `[jarvis-deck] agent brain: <name> ✓`
boot line in `journalctl -u jarvis-deck`. `ANTHROPIC_API_KEY` is deliberately
kept — it powers the ~300ms Haiku *intent classifier* fast-path, not brain
turns; don't delete it thinking it's brain fallback.

**Model tiers (2026-07-26): Opus 5 everyday, Fable 5 heavy.** Fable is
voice-selectable ("switch model to Fable") and the automatic one-turn
escalation on non-limit, non-timeout failure. Sonnet is not a tier (a stale KV
naming it falls back to Opus 5); `claude-opus-4-8` is retired.

**A heavier tier changes the TIMEOUTS that fit it — move them in the same
commit (2026-07-28).** The 12s warm first-token watchdog was tuned against
Sonnet; `7e1c7b9` made Opus 5 the everyday tier and left the watchdog, so
healthy turns were shot at 12s (seen live 2026-07-28 20:33). Now 20s, and a
watchdog trip classifies `kind:'timeout'` and retries the SAME tier with the
cold-spawn allowance — escalation answers "too slow" with something slower.

**A model-ID change in code can outrun the `claude` binary on the box
(2026-07-28).** Every spawn sets `DISABLE_AUTOUPDATER=1` by design, so the CLI
only moves when a human moves it. A binary that predates a tier rejects the
model ID; with metered fallback off, ONE unknown ID takes the whole brain down
and every surface degrades to the keyword pipeline — which reads to Craig as
three separate faults ("keeps breaking", "has no memory", "keeps narrating
problems") from one stale binary. `classifyFailure` returns `kind:'model'`
and `reportModelRejected()` names it. First check when the brain is dead
everywhere: `claude --version` on the box, then
`claude --model claude-opus-5 --print hi`.

**Two-account failover** (`src/lib/claude-auth.js`): logins at `/root/.claude`
(profile `default`) and `/root/.claude-profiles/<name>` via
`CLAUDE_CONFIG_DIR`. Usage-limit error → flip account, announce, retry once;
all exhausted → hold work (not fail) until earliest reset. Durable state: KV
`claude-active-profile` / `claude-profile-exhausted:<name>`. Voice: "switch
account". Any automatic failover away from `claude` fires a spoken notify() —
the 2026-07-18 silent Gemini downgrade must never repeat.

**The brain's session JSONL is the evidence.** Service logs don't record
turns. Read `/root/.claude/projects/-opt-jarvis/*.jsonl` to see what Jarvis
really heard, said, and called.

---

**An org-level switch kills BOTH accounts at once, and the failover flapped
between them for three days (2026-08-17).** Craig opened with "we have major
defects". Every one of the 491 tests passed, all twelve services answered 200,
every timer fired on schedule — and the fleet had done no work since the 14th.
Both claude.ai profiles on the box had `expiresAt: 0` and
`hasAvailableSubscription: false`, and box 158 — running a NEWER CLI (2.1.223 vs
the master's 2.1.220) — printed the actual reason the master's generic
"OAuth session expired and could not be refreshed" had hidden: *"Your
organization has disabled Claude subscription access for Claude Code."* One root
cause, not three. Craig is the org admin, so every `claude login` anyone might
have run in response would have been refused the moment it finished.

Two code defects sat underneath it:

1. **The auth-broken cooldown was in-process; every autonomous caller is a
   systemd oneshot.** So `authBroken` was empty at process start, each fresh
   process believed the *other* account was fine, flipped to it, and announced a
   triumphant recovery — 171 claude-auth notifications in seven days, ~90 a day,
   every one of them "switched to X". This is the SAME defect the 2026-08-16 fix
   records as closed for the *alert limiter*: made durable one layer up, left
   in-process one layer down. Whenever a limiter or a cooldown guards something
   a oneshot touches, the state has to be in KV — process memory gates nothing.
   Now `claude-profile-authbroken:<name>`, loaded in `refreshFromKV()` and
   awaited *before* the decision. The switch notice got its own once-per-UTC-day
   marker on a SEPARATE key (`claude-profile-authwarn:<name>`) so it can never
   suppress the far more important total-outage alert.

2. **The org-disabled message classified as `other`.** `spawn-agent.js` breaks
   out of its auth branch for any non-auth kind, so the single most informative
   error in the estate — the one naming its own fix — produced a generic "agent
   exited 1", no failover, no alert, no `authHeld`. It now classifies as
   `auth`/`reason:'org_disabled'`, and that reason **never fails over**: trying
   the second account under a disabled org is not a failover, it is a second
   identical failure. The alert says "re-enable Claude Code access in claude.ai
   settings", not "run `claude login`", because the second is wrong advice.

The decision is now a pure `authFailoverPlan()` with ten regression tests, so a
flap that could previously only be observed in production is testable. Standing
lesson: **when a diagnosis depends on an error string, check the newest CLI in
the fleet** — the master's binary was three patches behind and turned an
actionable org-policy message into a generic session error.

## Guardrails & numeric limits

**The 117-dispatch day (2026-07-17).** systemd's `EnvironmentFile` does NOT
strip inline comments: `MAX=6 # per day` arrives as `"6 # per day"`,
`Number()` gives NaN, every `x < NaN` is false, the gate stops gating —
self-heal dispatched 117 repair agents against a cap of 6. The same bug was
later found still live in `tts.js`/`tts-stream.js` (a malformed
`TTS_DAILY_CHAR_BUDGET` removed the ElevenLabs spend cap entirely). Hence
`src/lib/guardrail.js` for EVERY numeric limit: takes the leading token,
refuses non-positive values, always returns something finite, logs
`BAD GUARDRAIL` when a value was set but unusable. `Number(x) || default` is
only *accidentally* safe — it hides the operator's mistake instead of
reporting it.

---

## Timers, units, and the box-vs-repo gap

**Units that existed only on the box (three occurrences).**
`jarvis-browser.service`, then `jarvis-self-heal.service`/`.timer`
(2026-07-24), then both `jarvis-vapron-backup` units (2026-07-30) — each real,
enabled, running, and absent from `systemd/` in this repo. The self-heal units
now in `systemd/` are a best-effort reconstruction, not a copy — verify with
`diff /etc/systemd/system/jarvis-self-heal.* /opt/jarvis/systemd/jarvis-self-heal.*`.
**When you write a unit during an incident, copy it into `systemd/` the same
hour or nobody will know it exists.** Count the timers with
`systemctl list-timers "jarvis-*"` — trust that, not any doc (the doc said
"three" when there were six).

**The unit files weren't the deployed config either (2026-07-30).** Eleven
drop-in directories under `/etc/systemd/system/jarvis-*.service.d/` overrode
`MemoryMax` on ten services — the orchestrator's real ceiling was 3G, not the
2048M its unit claimed. Drop-ins now live in `systemd/dropins/` with matching
units, but **a drop-in still wins**: verify with
`systemctl show <svc> -p MemoryMax`, never by reading a unit file. See
`systemd/dropins/README.md` (also documents three `codex-env.conf` drop-ins
awaiting Craig's decision to delete).

**`Type=oneshot` DISABLES the start timeout by default (2026-07-30).**
fleet-check's memory write had no `--max-time`; a stalled memory-server could
hang the run forever, systemd skips every timer activation while the unit sits
`activating`, and since fleet-check is what notices a platform is down — and
self-heal only acts on the status it writes — the whole detect-and-repair
chain would go quiet with everything showing green. `TimeoutStartSec=600` is
now explicit. Set it on any new oneshot; the default is not a default.

---

## Self-heal

**Live in production, not experimental.** `SELF_HEAL_MODE=live`;
`config/self-heal.env`'s own comments reference the 117-dispatch incident.
Debounce (`SELF_HEAL_DOWN_MINUTES`), cooldown, daily cap, fleet concurrency
cap, and (2026-07-24) a check that no OTHER job is already in flight for the
platform (audit-runner and deploy-gate dispatch on different signals).

**DNS pre-check (2026-07-30).** gatetest.ai expired into .ai redemption on
2026-07-29; self-heal spent SIX repair agents in one day — twelve runs — each
correctly concluding "registry-level, nothing to do" while Next.js answered
200 on 10.0.1.1:3000 throughout. Now: `nxdomain` → alert Craig, count the
attempt, dispatch NOTHING (a name that doesn't exist can't be repaired from
this box); `unresolvable` (our resolver) → wait, don't count.

**The daily cap is now actually daily (2026-07-30).** The recovered-platform
loop wrote `day: today()` while carrying yesterday's count forward, so the
reset never fired and ONE bad day disabled a platform's autonomous repair
PERMANENTLY. It was live: bookaride claimed "1 attempt today" for an attempt
made 2026-07-12. `rollDay()` now owns rollover for both paths and derives the
reset from `lastAttempt`, not the re-stamped `day`.

---

## Code health & the fix loop

**A path existing is not the same as code being there (2026-07-30).** The
sweep picked zoobicon at `/root/zoobicon` — a directory holding only a
`.claude` folder — spent a review agent, returned 0 findings in 25s, and
recorded the flagship as SWEPT with a 20-hour cooldown, having read nothing.
`eligiblePlatforms()` now requires `hasSource(path)` (`src/lib/checkout.js`).
Note that is a DIFFERENT test from the audit runner's `checkoutProblem()`:
"is there code to read" (any source file, 2 levels deep) versus "could this be
built" (a manifest). universal-ai-operator is loose Python with no manifest —
reviewable, not buildable — and swapping those silently drops a platform from
one system or the other.

**A path pointing at the WRONG code is worse than a path pointing at none
(2026-08-05).** zoobicon's registry path held nothing, while the real checkout
sat INSIDE another platform — `universal-ai-operator/target_code/zoobicon`,
the CrewAI engine's working copy (its `master_engine.py` hardcodes and WRITES
it). Every sweep of the operator walked into the target directory and filed
**Zoobicon's** bugs under **universal-ai-operator's** name — nine confirmed
criticals (unauthenticated Stripe-portal session minting, `x-user-role: admin`
header spoofing, RCE via `new Function`) — against a checkout 194 commits
behind, attributed to a platform with no git remote and therefore excluded
from every auto-fix path. Zoobicon now has a genuine clone at
`/root/zoobicon`; the operator is in `CODE_HEALTH_SKIP`. **A registry `path`
is a claim about WHOSE code lives there** — when adding a platform, confirm
the path holds that platform's own source, not a vendored or target copy.

**Findings record their `commit_sha`** because a local checkout can be behind
its remote (/opt/alecrae was 28 behind during the first live sweep) — a real
finding may already be fixed upstream.

**fix-runner's gates are strict on purpose** (`src/lib/fix-dispatch.js`): a
full-permission agent editing the wrong repo unattended is worse than a bug
waiting. Confirmed-only; a checkout WITH a git remote; no suspected dupes;
denied platforms (screenshot-to-code = third-party fork, alecrae = live
co-tenant, jarvis = an agent must not rewrite the orchestrator running it);
and `CAUTION_RE` — the first dry-run tick picked a finding stored `confirmed`
whose verdict prose read "PARTIALLY re-verified and NOT confirmed at
origin/main". **When the enum and the prose disagree, the prose wins.**
`fix_job_id` is stamped as a durable claim BEFORE the attempt is counted, so a
restart can't double-dispatch. Nothing in fix-runner marks a finding `fixed` —
only code-health's own re-check on a later sweep; the fixer never marks its
own homework. First live tick (2026-08-05) fixed bookaride #17 (Stripe
webhook answered 200 on a missing key — paid bookings dropped forever) and
gatetest #149 (`/api/heal/ssh` had no auth), both with tests, both pushed.

---

## Audits & notification noise

**The invented health score (found 2026-07-30).** `ZOOBICON_PATH` and
`ALECRAE_PATH` pointed into `/var/www`, which does not exist on this box.
`spawnSync` got a dead cwd, the ENOENT text matched none of
`extractErrors()`'s patterns, the arithmetic landed on a tidy `100-20-10=70` →
`warning`, and warnings aren't spoken. The flagship was "audited" daily for
weeks and the number was invented. Guard: `src/lib/checkout.js` — a missing/
non-directory/manifest-less path gives `status:'unconfigured'` with
`health_score: null` — never a number — and a spoken warn. **Don't "fix" a
platform's audit by correcting its command alone — check the path exists and
that running it is SAFE on a shared box** (alecrae is typecheck-only,
`testCmd: null`: a live co-tenant whose tree is `/opt/alecrae`; a build would
regenerate Next.js output under the running server). jarvis-audit's
`MemoryMax` went to 2560M because the first genuine typecheck OOM-killed the
service (measured: exit 137 under 1536M, exit 0 under 2G).

**The "100+ Slack notifications" (2026-08-05).** Not a live flood: 246
messages from 1–14 July sitting unread, re-delivered as a burst (the bot had
posted 2–3/day and handled zero incoming since 30 July — check the `[bolt]`
line count first). The real defect underneath: vapron and screenshot-to-code
can never be auto-fixed by design, so they posted a byte-identical `critical`
audit EVERY DAY forever — `critical` bypasses quiet hours and mute, and the
matching warn notify() buzzed his phone via ntfy. NotifyCenter's dedupe
(30-min cooldown, 24h repeat) structurally could not catch a daily repeat, and
the escalation branch raised `alert`, which push.js exempts from BOTH dedupe
and the hourly cap. Now `audit_fingerprint`/`audit_repeat` count consecutive
IDENTICAL results (verdict + score + sorted errors); past `ANNOUNCE_REPEATS=2`
Slack drops to `info` (digest) and notify below the push threshold. **Nothing
is dropped** — inbox + digest still carry it with an "unchanged, day N"
suffix. The fingerprint covers the error LIST so a platform that breaks in a
NEW way is loud again immediately — "already broken" must never swallow "now
broken differently". `audit_repeat` is NOT `consecutive_critical` (which
would suppress a platform failing differently each day). Logic + tests:
`src/lib/audit-noise.js`, `test/audit-noise.test.js`.

**235 phone pushes for a machine that was fine (2026-08-10).** Craig: *"why am
I getting so many Jarvis alerts"*. Two defects compounded, and the trigger was
a change made two days earlier:
1. **A refused PC verb marked the whole machine down.** The flywheel's hourly
   `harvest.list` reached a PC worker running OLDER code, which correctly
   refused an unknown verb (`pc-actions.js` re-validates against its own table
   — shipping a verb server-side does not ship it to the worker). Each refusal
   went through orchestrator's `finishJob`, whose only exemption was role-AGENT
   jobs, so it wrote craig-pc `status:'error'` — a failed *verb* impersonating
   a dead *machine*. Fixed by `jobWritesPlatformHealth()` in
   `lib/health-status.js` (the third writer's rule now lives with the other
   two), tested in `test/health-status.test.js`.
2. **self-heal's not-repairable branch alerted every single tick.** `alert`
   level is exempt from BOTH push dedupe and the hourly cap, and the timer runs
   every 5 minutes → 288 buzzes/day, forever, for a condition only a human can
   clear. The file already carried this exact lesson twice (the dry-run notify
   was moved below the guardrails for it; the nxdomain notice got its own daily
   marker) — this branch was simply never revisited, because until craig-pc went
   `error` nothing unreachable had ever been DOWN. It now uses the same
   once-a-day marker (`manualNoticeDay`), cleared on recovery so a
   recover-then-fail-again is still heard.
**The general rule: an alert about something the monitor cannot fix needs a
HUMAN's rate limit, not a monitor's.** And when adding a `notify()` inside a
loop that runs on a timer, the question is never "is this worth saying" but
"is this worth saying 288 times a day".
*Third-order note:* the harvester also now backs off to daily when the worker
refuses its verbs — retrying hourly manufactured the failed job that fed the
whole chain. Rate-limiting the LOG line is not the fix; the DISPATCH is.

**The back-off had a blind spot, and jobs stacked while the PC slept
(2026-08-10, same incident, closed the same day).** The daily back-off above
only saw a refusal that landed inside `pcAction`'s 60-second wait window. The
03:05 refusal happened to land at +3s; a worker on its 5-minute error back-off
polling cadence — or a PC waking later — fails the job where nobody is
looking, and the next hourly run dispatched again as if nothing had happened
(41 failed `harvest.list` jobs, 2026-08-08→10). And while the PC slept, every
hourly run left ANOTHER queued job behind (three were stacked when this was
found). Three structural closes, all tested:
1. **Read the fate of the last dispatch before making another.** The
   harvester remembers its list job's id (KV `harvest-pc-last-list-job`) and
   `pcListPlan()` (lib/harvest.js) checks it next run — a permanent refusal
   (`refused:` / "unknown PC action", `isPermanentRefusal()`) trips the daily
   stale-worker marker no matter WHEN it landed. Transient failures (lost
   lease, timeout) still retry hourly.
2. **Single-flight:** a harvester PC job still queued or running means this
   run dispatches nothing. A pull-based worker with a sleeping PC needs at
   most one job waiting, ever.
3. **Refuse doomed dispatches up front:** the worker's heartbeat now reports
   its verb list into KV `pc-worker-capability`; `/pc/action` 409s (with the
   restart remedy) on a verb the connected worker doesn't have —
   `workerKnowsVerb()`, benefit of the doubt for older workers that don't
   report verbs. Zero failed jobs manufactured, and the 409 carries the same
   "unknown PC action" phrase so caller-side detection fires on it too.
The general rule: **a permanently-refused dispatch must change the CALLER's
behaviour, not just fail the job** — the job table records the refusal, but
only the dispatcher can stop manufacturing the next one.
*Separate finding, same dig (OPEN):* every `harvest.get` on 2026-08-10
06:05–06:07 "completed" but decoded to garbage ("incorrect header check", 0
of 40 transcripts pulled). The worker truncates action stdout to its LAST
8000 chars (`powershell()` in pc-worker.js: `stdout.slice(-8000)`), which
beheads the base64 gzip stream of any transcript whose encoding exceeds it.
A real fix needs a chunked fetch protocol (offset/length args on
`harvest.get`) — the gateway proxy's JSON body limit means simply raising the
cap is not enough. Until then the PC leg lists but cannot pull large
transcripts, and the cursor correctly refuses to advance.

**The week that produced the experience check (2026-08-11).** Craig asked "how
do we keep improving", and the honest answer was in the incident list: the open
mic transcribing his household, 235 alerts about a healthy PC, the voice
silently on the backup, production parked on an agent branch — **every one found
by him, while twelve services stayed green.** The fleet monitored the MACHINE
well and the EXPERIENCE not at all, and every fault shared one shape: nothing
errored, things quietly became wrong. `src/experience-check.js` turns each of
those into a check the box runs every 30 minutes. Two rules keep it honest:
**every check must cite a real incident** (no plausible-sounding monitoring),
and **a check passes only on positive evidence** — something answered — never
because nothing threw. Its own noise discipline is structural, not optional: it
announces on CHANGE, once daily while unchanged, once on recovery, and can
never emit `alert` (which push.js exempts from dedupe AND the hourly cap) —
otherwise the thing watching for floods becomes one. Verified by causing a real
failure: stopping jarvis-browser produced a detection, a repeat run stayed
quiet, and restarting it produced exactly one recovery notice.

**NotifyCenter basics:** critical = immediate, bypasses quiet hours/mute;
warning = immediate, deduped + rate-limited; info = digest. Hourly immediate
cap, overflow demotes. Quiet hours 22:00–07:00 NZ. Craig controls from Slack:
`mute`, `mute 2h`, `unmute`, `digest`, `notifications`. Replies to Craig's own
commands bypass all of it — mute never mutes answers. If Slack floods, find
the caller posting level=critical or a constantly-changing dedupe key.

---

## platform_state and its three writers

`status` has three writers meaning three different things: fleet-check
(uptime, 10 min), audit-runner (build quality, daily), orchestrator
`logToMemory` (job outcome, per job) — last one wins. The dangerous direction
is fixed (an audit can no longer erase a real outage — `lib/health-status.js`).
**The column-loss half is STRUCTURAL now (2026-08-05):** `/memory/platform/
update` had been fixed twice and broke a FOURTH time when audit-runner added
`audit_fingerprint`/`audit_repeat` — fleet-check's 10-minute write nulled
them, so the repeat counter never reached threshold and the suppression
silently did nothing. With `INSERT OR REPLACE` a column is destroyed by NOT
being named; it is now an UPSERT (`ON CONFLICT DO UPDATE SET`) touching only
the columns each caller manages — a future column survives by construction.
Do not turn it back. The parameters are referenced directly, not via
`excluded.`, because `status` is NOT NULL with an explicit-NULL trap: the
INSERT half spells `'unknown'`, and `excluded.status` would carry that into
the UPDATE half over a real status. Pinned by
`test/platform-state-preserve.test.js` — needs `node_modules`, SKIPS on dev
checkouts, **run it on the box**. Remaining cosmetic gap and the designed fix
(per-writer columns + derived worst-of `status`): see KNOWN DEBT in CLAUDE.md.

### The list that decided who was watched at all (2026-08-28)

Craig: *"how do we keep jarvis/marco synchronised with the platforms."* The
answer turned out to be: for uptime, we didn't. `scripts/fleet-check.sh`
carried its own hardcoded `FLEET=` list — the precise thing CLAUDE.md forbids
("read the registry; never trust a list in a doc") — and it had drifted from
`config/platforms.json` three ways at once.

The sharpest: **`marco-demo`, the first platform the build pipeline ever
produced, was registered at birth on 2026-08-25 with a `site_url`, and was
never probed once.** Its `platform_state` row still read `unknown / health 0 /
2026-08-25T13:41` three days later. CLAUDE.md said "platforms.json entry at
birth — the fleet watches the newborn". The registration half was real; the
watching half was a sentence. Nothing reported this, because *the failure mode
of a monitor is an absence*: no probe, no status change, no alert, and a row
that simply stops moving looks identical to one nobody has any news about.

Also live in that list: `gatetest-mcp`, probed for months but not a registry
key at all — a `platform_state` row no config could explain; and `davenroe`,
probed at `www.davenroe.com` while the registry declared `davenroe.com`, two
spellings of one claim with nothing comparing them.

Fixed by deriving the targets from the registry (`src/lib/fleet-targets.js`),
so *registered* and *watched* are one word. Three rules earned their comments:
`site_url` beats `health_url` (vapron has both, and preferring its tailnet
health endpoint would make the headline "vapron healthy" true of something no
customer can reach); a row name may be written at most once per tick (two
declarations of one row is the last-writer-wins trap in miniature); and an
empty target list must SHOUT and exit non-zero, because fleet-check is the only
thing that notices a platform is down and self-heal acts solely on the status
it writes — probing nothing looks exactly like a fleet in perfect health. The
shout is `warn`, not `alert`: its 10-minute dedup window matches the timer's
cadence, where `alert` is dedup-exempt and would buzz 144 times a day over a
config only a human can fix (see the 235-push flood).

What this does NOT fix, and is the larger half of Craig's question: nothing
verifies the registry's *claims* — `server`, `path`, `repo`, `site_url`. That
is how DavenRoe sat at `"server":"vercel"` for five days after it moved onto
this box while twelve services stayed green. The designed reconciler is
`docs/REGISTRY-SYNC.md`.

---

## The dispatch confirmation gate

**"Please" wasn't a yes (2026-07-30).** Craig staged a repair, answered
"please", and nothing launched: the old `AFFIRM_RE` knew `please do` but not
`please`, so the reply counted as an unrelated command — which **silently
deleted the pending job** and passed the text to the brain, which re-staged
the identical job and claimed "I've passed your yes through, sir". Both halves
were bugs. Now `classifyGateReply` classifies `yes|no|defer|none` against word
sets (compact replies only — >8 tokens or any word outside the sets = fresh
command; any negation vetoes); a staged job survives `GATE_TTL_TURNS=3` turns
of ordinary talk; re-staging the SAME job does not move its confirmation turn;
`gate.launched`/`gate.lapsed` feed `gateNote()` → `statusDigest()` so the
brain knows what happened (it cannot see the confirming turn — which is
exactly why it used to invent one). Gate turns are recorded to the shared
transcript via `recordTurn()`.

**The same day's overcorrection:** widening to a vocabulary made it too LOOSE —
it answered *yes* to "i need to run", "let me go", "you can send it". **A
confirmation is an IMPERATIVE**: `YES_STRONG` stands alone; `YES_VERB` needs a
`YES_OBJECT` or must be the entire reply; `i/me/my/we/us/you/can/could/would/
will/need` are deliberately NOT filler, so a sentence about the speaker falls
through as a fresh command. Touch this only with both directions run: the
false-affirm list AND the 21 real confirmations —
`test/dispatch-gate.test.js`. A false "yes" launches a production agent.

The gate is deliberately NOT shared across surfaces: a preview shown on one
must not be confirmable from another.

---

## Transcript & memory

**One conversation, all surfaces (2026-07-28):** deck + gateway share ONE
durable transcript (`src/lib/transcript.js`, KV `jarvis-conversation`).
Before: the gateway held conversation per-WebSocket, so a reload or restart
silently wiped it. If Jarvis "forgets", check that key first.

**Saves MERGE, they do not overwrite (2026-07-30).** `saveTranscript` used to
write the whole local array from a never-refreshed cache — and deck + gateway
are separate PROCESSES: a long deck conversation plus one gateway sentence
meant the gateway's stale array clobbered the deck's turns. Now a save
re-reads the store, appends only what that process added since its last
CONFIRMED write (`newSince`/`mergeTail`), splices in place (runAgent holds the
reference), and writes NOTHING if the store is unreachable. `newSince` cannot
diff by LENGTH: runAgent trims to 24 in place, so at the cap two new turns
leave length unchanged — that shipped and was caught live, not by tests.
Known limit: two saves within a few hundred ms can lose the later one (no
version on the KV; CAS would close it).

**`agent_context` is NOT junk (corrected 2026-07-28):** it is the physical
table behind the whole `/memory/kv` API — `brain-provider`,
`jarvis-conversation`, `claude-active-profile`, everything durable. Never
"clean it up". Separately: `repair_log` only helps if sessions actually write
to it (12 of 47 sessions in the 2026-07-06 audit never closed).

---

## Governance

**The 1,028-line incident (2026-08-05).** A repair agent dispatched for a
one-line merge defect in gluecron committed a 1,028-line feature across 9
files, exited 0, and pushed to a live product repo. Every guardrail worked —
they all governed which work to START. **A prompt is a request, not a
boundary**; there was no gate on what came back. Hence PROPOSE → REVIEW (a
DIFFERENT agent — the domain's officer) → APPROVE/REJECT/ESCALATE → EXECUTE,
one mechanism for all six officers (six bespoke paths would drift and five
would rot). Separation of duties enforced in `canTransition()`, not
convention. `ALWAYS_HUMAN` classes (payment, credential, legal_filing,
production_data, public_content, infrastructure) + anything high/unrecognised
risk escalate by construction — with the deliberate counter-property that
ordinary low/medium `code_fix` IS agent-approvable and is tested as such,
because a control that blocks everything gets switched off. The gate is
enforced SERVER-SIDE (`status` is not settable via PATCH, or the gate becomes
advisory). `scripts/install-push-guards.sh` puts a pre-push hook on all 9
checkouts refusing main/master/trunk/release/production — local-only, so
re-run after any new clone; verified live (push to main REFUSED, push to
`jarvis/…` succeeds). The remaining hole is credential scope: one key still
writes to every repo, and `--no-verify` or a fresh clone bypasses a local
hook. Server-side branch protection is the only control an agent cannot route
around, and it is Craig's: docs/CREDENTIAL-SCOPING.md.

---

## Infrastructure gotchas (the long versions)

**`tailscale serve` cannot use :443 on this box (2026-07-09).** Coolify's
Traefik binds `0.0.0.0:443` first; tailscaled fails silently —
`tailscale serve status` shows the route "active" while every request 503s
("no available server"; `journalctl -u tailscaled` showed
`bind: address already in use`). Hence `--https=8443/8444/8445`. Don't fight
Traefik for :443 (Rule 4). **A route in `serve status` is not proof — always
confirm with a real `curl .../health` (Rule 2).**

**Coolify/Traefik two-network hang:** a container on two Docker networks
while Traefik sits only on `coolify` HANGS (TLS completes, then silence,
HTTP 000) — it does not error. Fix: label
`traefik.docker.network=coolify`, recreate only that service. Cost gluecron.com
downtime until 2026-07-06.

**Tailscale runs `--accept-dns=false`** (co-tenant safety; only Craig's
devices need MagicDNS). UFW allows `in on tailscale0`; tailnet invisible
publicly.

**`gluecron-update.timer`** (legacy, not Jarvis's) was disabled 2026-07-06
after failing every 60s for days; Coolify owns that deploy now. The cups snap
was disabled the same day (public cupsd on :631). Don't re-enable either.

**:9212 exists for exactly one reason:** the 2026-07-18 hardening correctly
moved the real dashboard to loopback but silently killed the public `/health`
the off-box watchdog probes. :9212 is ONE static route, no express, no auth
surface. Needing more than a static "ok" there means build a proper endpoint
elsewhere.

**Slack intent routing is two-tier:** keyword fast-path (`src/intent.js`,
pure, tested) then Haiku classification for ambiguous phrasing, silent
keyword fallback on classifier failure. Debug:
`curl '127.0.0.1:9203/slack/test?text=...'`. Address prefixes and polite
lead-ins are stripped BEFORE matching (so "hey jarvis" doesn't route to the
`jarvis` platform). Unclear messages get "didn't catch that" — NEVER
auto-dispatched (the old passthrough caused spurious agent runs).

**Rendered UI is proven by LOOKING at it (2026-07-10).** Five visual
iterations of the Gateway avatar shipped "verified" by HTTP 200s and syntax
checks; all five were broken pixels. A full day and Craig's trust. Screenshot
via :9201 and inspect before saying done.

**Verify live, not with `node --check` (2026-07-28's six regressions,
and lint, 2026-07-30):** `src/slack-bridge.js:637` interpolated `${ms}` — an
identifier that never existed — for 22 days. ESM is strict mode: the line
throws, it sat after intent resolution and before the switch, both call sites
swallowed the error; every Slack command died silently. `node --check` passes
it (syntax is fine); no test exercised the line. `eslint` + `no-undef` catches
it at commit time — that's why `npm run lint` exists. `no-empty` is
deliberately OFF (~30 intentional commented `catch {}` blocks). Lint is NOT
in `npm test` (dev checkouts lack node_modules) — lint on the box. Three of
the first 13 findings were worth more than the linter: a discarded
`/memory/query` round trip per dashboard refresh, an orphaned
`COOKIE_MAX_AGE`, a destructured-never-used `body`. (A heuristic test was
attempted instead and FAILED to catch the very bug it was written for —
`(${ms}ms)` contains `ms` twice. It was deleted: a test that passes on the
bug it was written for is worse than no test.)

**The off-box watchdog's abandoned history (short version — full detail in
docs/OFF-BOX-WATCHDOG.md):** three attempts at a cloud-routine watcher, two
contradictory "fixes", zero delivered alerts. Two sessions worked it in
parallel unknowingly; the durable finding (confirmed twice, 2026-07-19 and
2026-07-22) is that CCR sandboxes egress through an allowlisting proxy that
403s `ntfy.sh` AND `*.tailscale.com`. The replacement is
`.github/workflows/offbox-watchdog.yml` — measured at ~one run per 49 min
(GitHub throttles schedules hard; design for ~1h detection, never 5 min),
raising an ntfy push (needs `NTFY_TOPIC` repo secret — still Craig's to set)
and a failing job = GitHub emails Craig with no secret needed. Do not mark
KNOWN DEBT #1 cleared until a test alert has actually buzzed a device —
"the code exists" is the mistake that kept this open a month.

**Slack is frozen-legacy but ACTIVE.** A 2026-07-20 correction found the
"retired 2026-07-15" claim in ROADMAP's decisions-locked table was wrong.
Never touch/delete `slack-bridge.js` on the strength of that claim.

---

## Debt cleared (dates + what closed it)

- 2026-07-06: dashboard auth; cupsd exposure; keyword-only intents; no DB
  backups (jarvis-backup.timer).
- 2026-07-12: Slack notification firehose (NotifyCenter); misrouted Slack
  commands (src/intent.js rewrite).
- 2026-07-19: resource guards / pre-OOM alerting (metrics-collector.js).
- 2026-07-20 (code side): Haiku classifier HTTP fast-path for Gateway/voice
  (~300ms vs 3–10s CLI cold start).
- 2026-07-22: `ANTHROPIC_API_KEY` live on the box (verified via
  `/slack/health` → `"classifier":"http-api"`); audit coverage for all 11
  eligible platforms; audits now ACT on what they find (auto-dispatch, capped
  at 2 consecutive criticals then human alert).
- 2026-07-30: nothing alerted when a Jarvis SERVICE died — metrics-collector
  now probes all 12 ports (one `ss` call) and classifies WHY a port is quiet
  (`src/lib/service-verdict.js`: `restarting` silent / `failed` first-probe
  alert / `stopped` warn ~2min / `notlistening` — the dangerous one — ~60s);
  the linter (KNOWN DEBT #7).

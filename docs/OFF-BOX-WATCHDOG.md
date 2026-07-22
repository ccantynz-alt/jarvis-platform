# Off-box watchdog (KNOWN DEBT — no external watcher, cleared 2026-07-19)

**Note on the heading:** an earlier revision of this file mislabeled this as
"Roadmap move #21" — move #21 in `config/roadmap.json` is actually
*Embodied Jarvis (avatar/voice)*, unrelated. There's a *different*,
apparently pre-existing system, roadmap move #3 ("Off-box watcher extended
to the whole public fleet", `jarvis-fleet-watcher`, marked done 2026-07-15,
GitHub-issue alerts with dedup) that this doc does not track and that
wasn't touched or verified during this redesign — worth Craig confirming
that one still actually runs, given the pattern of "done" markers in this
codebase that turned out to be unverified.

**Problem it solves:** nothing outside Jarvis's own infrastructure ever
checked whether Jarvis itself was alive. If the box died, the outage was
silent until Craig happened to notice.

**What it is:** a scheduled Claude Code cloud routine (CCR) — runs in
Anthropic's cloud, NOT on Craig's Vultr box or anywhere in the tailnet, so
it survives even a total box failure. This is deliberately NOT Jarvis code
and NOT tracked in this repo's runtime — it lives only in Anthropic's
routines system. This file is its only documentation.

**REDESIGNED 2026-07-20** — the original routine (`trig_01KDPX4RE3Vo9HeMUG1Lj4G4`)
now 404s when queried via the RemoteTrigger API (genuinely not found, not
just disabled — cause unknown, possibly never actually persisted despite
being documented). It's superseded by a new routine below with a
fundamentally different, simpler design. See "Why it was redesigned" below
for the reasoning.

- **Routine name:** `jarvis-offbox-watchdog`
- **Routine ID:** `trig_01Gu62Hw6X46th5NhLz9Jin3`
- **Manage it:** https://claude.ai/code/routines (list/update/disable — the
  API this was created through cannot delete routines)
- **Schedule:** hourly, `7 * * * *` UTC (cron minimum interval is 1 hour —
  this is a backstop for total outages, not a fast health probe; on-box
  self-heal + the metrics resource guards handle fast-response monitoring)
- **Target:** `GET http://66.42.121.161:9212/health` — the dedicated public
  liveness ping added 2026-07-19 (see `src/dashboard-server.js`, PORTS ON
  THIS BOX in CLAUDE.md). NOT `:9206` — that's the real dashboard,
  loopback/tailnet-only on purpose.
- **State tracking: NONE, intentionally.** The routine no longer tries to
  remember "was it already down last time." It just alerts every single
  hourly run where the health check fails — see "Why it was redesigned."
- **Execution shape: exactly one Bash tool call, no exceptions.** The
  routine's entire prompt is one literal shell command combining the check
  and the conditional alert via `||`, run in a single tool invocation:
  ```bash
  curl -sf -m 10 http://66.42.121.161:9212/health | grep -q '"status":"ok"' \
    || curl -s -m 10 -X POST -H "Content-Type: text/plain" \
       -d "Jarvis box unreachable: :9212/health check failed at $(date -u +%FT%TZ)" \
       https://ntfy.sh/jarvis-watchdog-894aba5ccdd6
  ```
  The prompt explicitly forbids the agent from reading files, using git, or
  making a second tool call. No git clone of this repo is needed for the
  routine to function (a `sources` entry is still attached for consistency
  with other CCRs, but the prompt never touches it).
- **Alert channel:** [ntfy.sh](https://ntfy.sh) (free, no-signup HTTP push).
  Topic: **`jarvis-watchdog-894aba5ccdd6`**. Craig must have the ntfy app
  installed and subscribed to that exact topic to receive alerts — this
  was NOT wired through Jarvis's own notify()/gateway system because a
  cloud routine has no path onto the tailnet and no MCP connector was
  configured for anything else at setup time (2026-07-19, no connectors
  present). If Craig later wants email/SMS/Slack instead, update the
  routine's prompt via the `/schedule` skill or RemoteTrigger `update`.
  **Gotcha confirmed 2026-07-20:** a plain `curl -X POST -d "text" ntfy.sh/topic`
  (no Content-Type header) gets misinterpreted by ntfy as a *file
  attachment upload* — the notification arrives as a mystery
  `attachment.txt` instead of readable message text. Always send
  `-H "Content-Type: text/plain"` on the alert POST. Verified directly by
  sending test messages to the real topic with and without the header.

## Known limitations

Hourly granularity means up to ~1 hour of undetected downtime in the worst
case. This is a backstop, not a replacement for on-box monitoring
(self-heal, metrics resource guards, the gateway's own `/internal/heartbeat`
dead-man switch for peer boxes like 158) — all of which are faster but all
of which die WITH the box, which is exactly the gap this closes.

**No up→down/down→up transition detection, intentionally.** Craig will get
a repeat ntfy alert every hour for as long as the box stays down, not a
single alert on the initial failure. This is a deliberate trade for
reliability (see below) — a noisy-but-guaranteed alert beats a clean but
unreliable one. There's also no explicit "back up" notification; recovery
is implied by alerts simply stopping.

## Why it was redesigned (2026-07-19 → 2026-07-20)

**UNRELIABLE EXECUTION, NOT YET TRUSTED (2026-07-19 finding).** During the
original setup, the routine's health CHECK (a plain `curl` to `:9212/health`)
worked correctly every single time it was tested. But a WRITE step meant to
remember "was it already down last time" failed silently, repeatedly,
across THREE different designs tried the same session:
1. Git commit + push of a state file — worked on the very first-ever run,
   then failed on every subsequent run (2 consecutive failures, ~15 min).
2. A trivial isolated diagnostic (6 commands, nothing but `git push`,
   different routine, same environment) — also failed to land, confirming
   this wasn't specific to the watchdog's own prompt complexity.
3. Redesigned to avoid git entirely — read/write a tiny state marker via
   ntfy.sh's own message cache (`https://ntfy.sh/jarvis-watchdog-state-<id>`,
   plain curl POST/GET, no git, no file writes) — STILL failed to land
   after 5+ minutes of waiting on the very next run.

The common thread across all three: every design's READ step (a plain
outbound `curl`) worked; every design's *second* step (git push OR a second
curl POST, run after the first tool call) didn't complete. That pointed at
something in the cloud execution environment breaking multi-step tool
sequences specifically — not a bad choice of persistence backend.

**The fix (2026-07-20): stop needing a second step at all.** The routine
was rebuilt from scratch (new trigger, old one — `trig_01KDPX4RE3Vo9HeMUG1Lj4G4`
— now 404s and is abandoned) around a single Bash tool call that does the
check AND the conditional alert in one shell line (`check || alert`, see
above). There is no cross-run state, so there is nothing to write, so the
failure mode that broke three previous designs no longer has anywhere to
occur. The cost is losing transition-only alerting (see Known limitations)
— judged an acceptable trade for actually working.

**Verified 2026-07-20, within the session that made this change:**
- The target endpoint (`:9212/health`) was independently curled and
  confirmed healthy (`{"status":"ok"}`, HTTP 200).
- The routine was triggered twice via `RemoteTrigger action:"run"` after
  creation and again after the Content-Type fix below — both accepted
  (HTTP 200, `last_fired_at` updated). Per-run execution logs are still not
  exposed by the RemoteTrigger API (same limitation noted in the original
  investigation) — only https://claude.ai/code/routines/trig_01Gu62Hw6X46th5NhLz9Jin3
  shows run-level detail, so **a human still needs to glance at that page
  once** to confirm a run actually executed the Bash call rather than just
  being accepted by the scheduler.
- **Found and fixed a real bug in the alert command itself:** a bare
  `curl -X POST -d "text" ntfy.sh/topic` (no Content-Type header) gets
  misinterpreted by ntfy as a file-attachment upload — the notification
  arrives as a mystery `attachment.txt`, not readable text. Confirmed by
  sending real test messages to the live topic with and without
  `-H "Content-Type: text/plain"`. The routine's command now includes the
  header.
- Not independently verified: the actual down-path (:9212 unreachable →
  alert fires) hasn't been observed end-to-end, since the box has been up
  the whole time this was tested. The alert-delivery mechanism (ntfy POST
  with the correct header) was verified directly; the trigger-level "did
  the cloud routine really run the command" was not, per the log
  limitation above.

**UPDATE 2026-07-22 — the ntfy channel itself is very likely BLOCKED from
inside the real routine sandbox, not just unverified.** A one-shot
diagnostic CCR (same environment the watchdog runs in) tried four HTTPS
endpoints in a single Bash call: `login.tailscale.com`,
`controlplane.tailscale.com`, `pkgs.tailscale.com`, and — critically —
`ntfy.sh` as a "known-working baseline." **All four failed identically**:
`CONNECT tunnel failed, response 403` (curl exit 56). This is the exact
same error the 2026-07-19 investigation (see below) found for `ntfy.sh`
specifically — two independent tests, days apart, both show the sandbox's
default outbound proxy rejecting it. The earlier "verified" note above was
tested from an *interactive* Claude Code session, which apparently has
different (more permissive) network access than the unattended CCR
environment the watchdog actually fires in — that gap turned out to
matter. **Bottom line: the live watchdog most likely cannot actually
deliver an alert right now, regardless of the Content-Type fix, because
the alert channel itself is blocked by the environment's default network
policy.** Fix is the same one Craig already needs for the tailnet-join
design below — allowlist the needed domain(s) in the claude.ai/code
environment's network policy. `ntfy.sh` specifically if keeping this
design, or skip straight to `*.tailscale.com` + `pkgs.tailscale.com` for
the tailnet-join redesign instead (see below), which drops the third-party
dependency entirely.

## Investigation 2026-07-19 (cloud session, "box-watchdog issues")

Findings from a Claude Code cloud session that dug into the failures above.
None of this is fixed yet — it's diagnosis plus a concrete design; the two
prerequisite changes are Craig-only (environment settings + tailnet key).

### 1. The current "down" state is probably a false alarm

`docs/.watchdog-state.json` on main says `{"status":"down","since":
"2026-07-19T06:03:14Z"}` (commit `af340f2`, landed 06:03 UTC — so at least
one git write from the routine HAS succeeded, contrary to the all-writes-fail
pattern above). But the commit restoring the `:9212` endpoint itself
(`e728388`) was only authored ~09:00 UTC — three hours AFTER the routine
recorded "down". The routine was probing an endpoint that didn't exist yet
(or wasn't deployed/restarted on the box). No up-transition has been
committed since, which means either the box never got the `:9212` restore
deployed, or the routine's later runs are still failing to write. On-box
check: `ss -tlnp | grep 9212` and `systemctl status jarvis-dashboard`.

### 2. Likely root cause of the silent write failures: the cloud
### environment's egress allowlist

Verified from inside a Claude Code cloud container (same kind of
environment the routine runs in): outbound traffic goes through an
allowlisting proxy, and

- `ntfy.sh:443` → **CONNECT rejected 403** (policy denial). The routine's
  ntfy alert POSTs and the ntfy-cache state design both die here —
  silently, exactly matching the observed "reads work, writes vanish"
  symptom for the ntfy designs.
- Plain HTTP to `66.42.121.161:9212` → not proxied (405 from the proxy for
  non-CONNECT) and direct egress is firewalled. **If the routine's
  environment has the same policy, the health check itself may not be
  reaching the box either**, and a failed check is indistinguishable from
  a down box → false "down".
- `controlplane.tailscale.com` / `login.tailscale.com` /
  `pkgs.tailscale.com` → all 403. So a cloud session cannot currently join
  the tailnet at all.

GitHub is allowlisted (git push works — see the successful `af340f2`), so
the earlier git-push failures were probably a different issue (per-run
execution logs in the web UI are still the only way to see them).

### 3. The fix design: put the watchdog ON the tailnet

"A cloud routine has no path onto the tailnet" (above) is only true under
the default network policy. The environment's network policy is
user-configurable, which unlocks a much better design:

1. **Craig, in the environment settings** (claude.ai/code → environment →
   network policy): allow `*.tailscale.com` (control plane + DERP relays)
   and `pkgs.tailscale.com`; keep/add `ntfy.sh` only if it stays as backup
   channel. Note the proxy's no-proxy list already exempts `100.64.0.0/10`
   (the Tailscale CGNAT range), so tailnet traffic won't fight the proxy.
2. **Craig, in the Tailscale admin console**: create an **ephemeral,
   pre-authorized, tagged** auth key (e.g. tag `tag:watchdog`) with ACLs
   allowing only the gateway/dashboard serve ports on `jarvis`. Put it in
   the environment as an env var (e.g. `TS_AUTHKEY`) — never in a prompt
   or this repo.
3. The routine then runs `tailscaled` in userspace-networking mode, joins
   as an ephemeral node, and probes
   `https://jarvis.tailbd6217.ts.net:8443/health` (the gateway — the real
   front door) instead of the raw-IP `:9212` ping.
4. Alerting: POST to the gateway's `/internal/notify` with a scoped token
   (same pattern as `JARVIS_HEARTBEAT_TOKEN_vapron158`) so a "Jarvis box
   unreachable" alert is spoken through Jarvis's own channel when the
   gateway is up but something else is wrong — with ntfy (or email via a
   connector) as the channel for the case that matters most, the box being
   fully dead and the gateway unreachable.

Until (1) and (2) are done, the watchdog stays as-is: built, plumbed,
unverified, and not to be trusted (see above).

## To change the check target, schedule, or alert channel

Use the `/schedule` skill or call `RemoteTrigger` directly:
```
{"action": "update", "trigger_id": "trig_01Gu62Hw6X46th5NhLz9Jin3", "body": {...}}
```
The routine's prompt is self-contained (the cloud agent starts with zero
conversation context each run) — any edit to its behavior must go through
the prompt text itself, not this doc.

## Unrelated finding while investigating this (flag for Craig, not fixed here)

The RemoteTrigger routine list is dominated by ~100+ hourly self-re-arming
`send_later` routines, all named `send_later <timestamp> #<hash>`, doing
repeated check-ins on **PR #140 in `ccantynz-alt/DavenRoe`** about a GitHub
Actions outage that had already run continuously for **~147+ hours** (six
days) as of 2026-07-19T18:30 UTC, each one re-arming itself for another hour
indefinitely. This is unrelated to Jarvis and wasn't touched or deleted —
just flagging that it exists and looks like it may be stuck in a long-running
loop worth a human look via https://claude.ai/code/routines.

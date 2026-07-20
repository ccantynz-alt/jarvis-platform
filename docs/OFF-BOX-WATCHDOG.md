# Off-box watchdog (Roadmap move #21 / KNOWN DEBT #1)

**Problem it solves:** nothing outside Jarvis's own infrastructure ever
checked whether Jarvis itself was alive. If the box died, the outage was
silent until Craig happened to notice.

**What it is:** a scheduled Claude Code cloud routine (CCR) — runs in
Anthropic's cloud, NOT on Craig's Vultr box or anywhere in the tailnet, so
it survives even a total box failure. This is deliberately NOT Jarvis code
and NOT tracked in this repo's runtime — it lives only in Anthropic's
routines system. This file is its only documentation.

- **Routine name:** `jarvis-offbox-watchdog`
- **Routine ID:** `trig_01KDPX4RE3Vo9HeMUG1Lj4G4`
- **Manage it:** https://claude.ai/code/routines (list/update/disable — the
  API this was created through cannot delete routines)
- **Schedule:** hourly, `7 * * * *` UTC (cron minimum interval is 1 hour —
  this is a backstop for total outages, not a fast health probe; on-box
  self-heal + the metrics resource guards handle fast-response monitoring)
- **Target:** `GET http://66.42.121.161:9212/health` — the dedicated public
  liveness ping added 2026-07-19 (see `src/dashboard-server.js`, PORTS ON
  THIS BOX in CLAUDE.md). NOT `:9206` — that's the real dashboard,
  loopback/tailnet-only on purpose.
- **State tracking:** the routine reads/writes `docs/.watchdog-state.json`
  in THIS repo on every run (via its own git clone) so it only alerts on a
  genuine transition (up→down or down→up), never on every hourly check.
  That file is gitignored from a "meaningful diff" standpoint but IS
  committed by the routine — don't hand-edit it.
- **Alert channel:** [ntfy.sh](https://ntfy.sh) (free, no-signup HTTP push).
  Topic: **`jarvis-watchdog-894aba5ccdd6`**. Craig must have the ntfy app
  installed and subscribed to that exact topic to receive alerts — this
  was NOT wired through Jarvis's own notify()/gateway system because a
  cloud routine has no path onto the tailnet and no MCP connector was
  configured for anything else at setup time (2026-07-19, no connectors
  present). If Craig later wants email/SMS/Slack instead, update the
  routine's prompt via the `/schedule` skill or RemoteTrigger `update`.

## Known limitations

Hourly granularity means up to ~1 hour of undetected downtime in the worst
case. This is a backstop, not a replacement for on-box monitoring
(self-heal, metrics resource guards, the gateway's own `/internal/heartbeat`
dead-man switch for peer boxes like 158) — all of which are faster but all
of which die WITH the box, which is exactly the gap this closes.

**UNRELIABLE EXECUTION, NOT YET TRUSTED (2026-07-19).** During setup, the
routine's health CHECK (a plain `curl` to `:9212/health`) worked correctly
every single time it was tested. But the WRITE step needed to remember
"was it already down last time" failed silently, repeatedly, across THREE
different designs tried the same session:
1. Git commit + push of a state file — worked on the very first-ever run,
   then failed on every subsequent run (2 consecutive failures, ~15 min).
2. A trivial isolated diagnostic (6 commands, nothing but `git push`,
   different routine, same environment) — also failed to land, confirming
   this wasn't specific to the watchdog's own prompt complexity.
3. Redesigned to avoid git entirely — read/write a tiny state marker via
   ntfy.sh's own message cache (`https://ntfy.sh/jarvis-watchdog-state-<id>`,
   plain curl POST/GET, no git, no file writes) — STILL failed to land
   after 5+ minutes of waiting on the very next run.

The common thread: every design's READ step (a plain outbound `curl`)
works; every design's WRITE step (git push OR a second curl POST) doesn't
complete. This points at something in the cloud execution environment
itself (a timeout before the later steps run, an issue specific to
multi-step tool sequences, or something not visible via the
`RemoteTrigger`/`/schedule` API, which exposes trigger *configuration* but
not per-run execution logs). **Bottom line: do not trust this routine to
actually alert Craig until someone has watched a real run complete via the
web UI** (`https://claude.ai/code/routines/trig_01KDPX4RE3Vo9HeMUG1Lj4G4`
— that page may show run-level logs this API doesn't). Until then, treat
this as "built and plumbed correctly, but unverified in production" —
on-box monitoring remains the layer actually trusted to catch problems
fast; this is a slower backstop that still needs its execution reliability
proven before it's trusted for the one case that matters most (the box
being fully dead).

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
{"action": "update", "trigger_id": "trig_01KDPX4RE3Vo9HeMUG1Lj4G4", "body": {...}}
```
The routine's prompt is self-contained (the cloud agent starts with zero
conversation context each run) — any edit to its behavior must go through
the prompt text itself, not this doc.

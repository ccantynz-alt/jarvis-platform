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

## To change the check target, schedule, or alert channel

Use the `/schedule` skill or call `RemoteTrigger` directly:
```
{"action": "update", "trigger_id": "trig_01KDPX4RE3Vo9HeMUG1Lj4G4", "body": {...}}
```
The routine's prompt is self-contained (the cloud agent starts with zero
conversation context each run) — any edit to its behavior must go through
the prompt text itself, not this doc.

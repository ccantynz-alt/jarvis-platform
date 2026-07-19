# Cloud routines (Anthropic-hosted, outside Jarvis's own infra)

Two scheduled Claude Code cloud routines exist under this Anthropic account.
They are NOT Jarvis services — no systemd unit, no /opt/jarvis process, not
visible to `systemctl status jarvis-*` or any Jarvis health check. They live
entirely in Anthropic's routines system (https://claude.ai/code/routines)
and this file is their only record in either repo. **Rule 0 applies to this
file too** — if a routine changes, update this doc in the same breath.

## Vapron PR Sync

- **Routine ID:** `trig_014CTt637y13Y2xvvU87rXHj`
- **Created:** 2026-07-15 (predates the 2026-07-19 session that discovered
  and documented it — origin/author not recorded anywhere else)
- **Schedule:** hourly, `0 * * * *` UTC
- **Repo:** `github.com/ccantynz-alt/Vapron`
- **What it does:** reads every open PR on Vapron, runs the real gate suite
  (`bun install --frozen-lockfile`, `db:validate`, `check-links`,
  `check-buttons`, `build`, `test`) in an isolated git worktree, and merges
  with `gh pr merge --admin --squash --delete-branch` when everything passes
  AND no human-review hold is detected. Detects migration-number collisions
  under `packages/db/migrations/` and holds (never auto-fixes) on a
  collision. Maintains a live-updating public artifact at
  `https://claude.ai/code/artifact/440c7e5d-c5a9-4e56-886c-05ac459f0a32`
  (canonical source: `docs/HEAD_TO_HEAD_ARTIFACT.html` in the Vapron repo).
- **Hold detection (the load-bearing safety rule):** reads full PR bodies
  and comments for MEANING, not keyword matching — biased hard toward
  skipping a merge on ANY hint a human should look first. This exists
  because an earlier version merged PR #1511 despite an explicit
  human-review request that didn't match its old keyword list; the prompt
  was corrected 2026-07-15 and the fix is embedded in the routine itself.
- **This means Vapron already has real autonomous merge authority** — an
  order of magnitude more powerful than anything in Jarvis's own role-agent
  org (which is draft-only, gated behind `dispatch_job` confirmation). Worth
  knowing before assuming Jarvis's agents are the only thing acting
  autonomously across Craig's estate.

## jarvis-offbox-watchdog

See `docs/OFF-BOX-WATCHDOG.md` — the off-box liveness monitor created
2026-07-19 (Roadmap move #21 / KNOWN DEBT #1).

## Managing these

`https://claude.ai/code/routines` (list/enable/disable) or the `/schedule`
skill / `RemoteTrigger` tool from a Claude Code session. Routines cannot be
deleted via the API — only through the web UI.

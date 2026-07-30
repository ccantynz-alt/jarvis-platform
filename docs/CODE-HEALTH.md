# The code-health spine

> Built 2026-07-30, from: *"we could run for days finding problems and build a
> spine health prob not just finding HTTP problems but actually coding issues
> regardless of how deep they go."*
>
> Rule 0 applies. Change the behaviour, change this file in the same commit.

## What it is for

Every health system Jarvis had answers one question — **is it serving?**

| System | Signal | Blind to |
|---|---|---|
| `scripts/fleet-check.sh` (10 min) | public URL returns 200 | anything that returns 200 and is wrong |
| `src/audit-runner.js` | build + test + screenshot + score | every defect the tests don't cover |
| `src/deploy-gate.js` | GateTest scan on deploy | code that was never deployed today |
| `src/self-heal.js` (5 min) | site down → restart | a site that is up and losing data |

A codebase full of swallowed exceptions, unvalidated input, races, missing
timeouts and money-path bugs passes all four cleanly. `src/code-health.js` asks
the other question — **is it correct?**

## How one sweep works

Every 3 hours (`jarvis-code-health.timer`), one sweep:

1. **Pick a target.** The least-recently-swept platform that is `active`, hosted
   on this box, has a `path` in `config/platforms.json` that exists, and isn't on
   the skip list. Least-recently-swept rather than worst-looking, because a quiet
   platform with no findings is otherwise indistinguishable from one nobody has
   ever reviewed.
2. **Pick the lens.** Nine lenses rotate per platform (`LENSES` in
   `src/lib/findings.js`): failure paths · data integrity · input trust · auth &
   session · concurrency · money paths · integrations · config & deploy · recent
   commits. **This is the load-bearing idea.** "Find bugs in this repo" returns
   the same shallow answers forever — the model re-reads the entry points and
   stops. One angle per sweep, nine platforms, three-hourly, works through the
   whole fleet in about three days and then comes back on a *different* angle.
   That is what "regardless of how deep they go" looks like as a schedule.
3. **Review, read-only.** One `spawnClaude` agent in the repo root, told
   explicitly that it may not edit, commit, push, install, migrate, build or
   restart anything, and that the only file it may write is its output JSON. It
   writes to a file rather than stdout because `spawnProcess` keeps only the last
   4000 characters of stdout — enough for a marker, not for findings.
4. **Normalise.** `normalizeFinding()` clamps every field and drops anything
   without a real title. Model output is untrusted input; unbounded strings
   otherwise travel from an agent into SQLite, into a spoken briefing, and into a
   dispatch prompt.
5. **Verify adversarially.** Anything critical, high, security- or data-loss-shaped
   gets a second agent whose job is to **refute** it — find the guard earlier in
   the call path, the caller that makes the input impossible, the test that proves
   the opposite — and which defaults to refuted when unsure. Confirmed findings
   are ones Craig can act on without checking the work.
6. **File by fingerprint.** `POST /memory/findings` upserts into `code_findings`.
7. **Report proportionately.** A confirmed critical is a device push. Other new
   findings are an inbox item. A clean sweep says so only in the log — this runs
   forever, and "I looked and it's fine" is not a notification.

## Why fingerprints, and what they cost

A nightly deep review that re-reports the same twelve things is a firehose, and
a firehose gets muted (see `notify-center.js` for the Slack version of that
lesson). So identity is computed from `platform : file : significant words of the
title, SORTED`.

Sorting makes the key word-order-independent, so *"unbounded retry loop in
worker"* and *"the worker retry loop is unbounded"* collapse to one finding —
necessary, because two agents almost never phrase a defect identically. The cost
is that two genuinely different defects in the same file sharing their
significant words will merge. Scoped to one file that is rare and cheap; the
opposite mistake is a report per phrasing, every night.

Three behaviours in `memory-server.js` matter as much as the key:

- **`dismissed` is sticky.** A verifier refuted it; re-arguing it every sweep is
  precisely the noise this design exists to avoid.
- **Severity only escalates.** One sweep calling something `low` must not undo
  another that proved it `critical`.
- **`fixed` → found again = `regressed`.** The most valuable signal the table
  holds, and a plain `INSERT OR IGNORE` would have thrown it away.

## Nothing here fixes anything

Deliberate. The review and verify agents are read-only, and a finding becomes
work only when Craig says yes through the dispatch confirmation gate
(`resolveDispatchGate`). He can ask for them in conversation — the brain has
`get_code_findings` — and say "fix the top one on vapron", which stages a
dispatch naming the real file and defect.

Auto-fixing is the obvious next step and is deliberately NOT first. `self-heal`
earned that privilege by proving its guardrails against the real fleet for weeks,
and its one bad day (117 dispatches against a cap of 6) is why every numeric
limit here goes through `guardrail()`.

## Configuration

`config/code-health.env` (loaded by the unit after `secrets.env`, so it wins):

| Var | Default | Meaning |
|---|---|---|
| `CODE_HEALTH_MODE` | `dry-run` | `off` · `dry-run` (review + log, file nothing) · `live` |
| `CODE_HEALTH_COOLDOWN_HOURS` | 20 | before the same platform is swept again |
| `CODE_HEALTH_MAX_FINDINGS` | 8 | taken from one sweep, worst first |
| `CODE_HEALTH_MAX_VERIFY` | 4 | adversarial verifiers per sweep (each is a subscription turn) |
| `CODE_HEALTH_REVIEW_MIN` | 25 | review agent wall clock |
| `CODE_HEALTH_VERIFY_MIN` | 8 | verifier wall clock |
| `CODE_HEALTH_SKIP` | `craig-pc,screenshot-to-code,vapron` | never reviewed |

Skipped by default: `craig-pc` (a worker node, not a codebase),
`screenshot-to-code` (third-party fork — findings there are upstream's), `vapron`
(lives on box 158, which nothing on this box can SSH to as of 2026-07-30 — the
day that changes, remove it from the list and it joins the rotation).

## Running one by hand

```bash
cd /opt/jarvis && set -a && . config/secrets.env && set +a
CODE_HEALTH_MODE=dry-run node src/code-health.js jarvis failure-paths   # forced target
node src/code-health.js                                                 # normal rotation
```

Read the log at `/var/log/jarvis-code-health.log`; rotation state lives in
`/var/lib/jarvis/code-health/state.json` (delete it to reset the rotation).

## What to check before trusting it

Rule 2 — a named artifact, not "the code looks right":

```bash
curl -s 'http://127.0.0.1:9200/memory/findings?open_only=1&limit=10' | jq .
curl -s http://127.0.0.1:9200/memory/findings/summary | jq .
journalctl -u jarvis-code-health -n 50 --no-pager
```

And read three findings against the actual code. The failure mode that matters
is not a missed bug — it is a **confident wrong one**, because that is what
spends Craig's attention and an agent's time. If two of three findings are
rumours, the verifier prompt needs tightening before the mode goes anywhere near
auto-fix.

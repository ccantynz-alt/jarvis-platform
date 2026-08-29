# SELF-REPAIR AUDIT — 2026-08-29

> Craig: *"what do we need to build to be completely self repair… also marco
> needs to be in sync with all the platforms if not then marco will be claiming
> and making bad repairs especially when i currently complete all repairs from
> CLI powershell."*
>
> Both halves of that sentence are the same problem, and the instinct behind it
> is right. Numbers below are live from the box on 2026-08-29.

## The headline

**Detection works. Nothing closes.** The loop finds far more than it can ever
act on, and every path to actually landing a repair terminates in a queue that
has never been emptied.

| Stage | Built? | Live number |
|---|---|---|
| Find defects | yes, over-produces | **500 findings**, 280 `confirmed` |
| Verify a finding is real | yes, adversarial | but only critical/high get a verifier |
| Re-check whether it's STILL real | yes, throttled to near-zero | **max 16/day** estate-wide vs 280 open claims |
| Open a proposal | yes | **34 proposals** since 2026-08-05 |
| Review it | dry-run | **0 approved, ever** |
| Write a fix branch | yes | **2 branches** on origin |
| Merge it | **no — Craig, by hand** | 0 merged |
| Deploy / restart the service | **no** | the deck ran 3 commits stale until today |
| Confirm the fix worked | **no** | nothing marks a finding fixed from a landed repair |

So: 280 confirmed defects, 19 of which ever got a fix job, 0 of which ever
reached production. **31 of 34 proposals are still sitting at `proposed`.**

That is not a broken machine — every component does what it says. It is a
machine with no exit.

## Why "out of sync" is the dangerous half

Craig's specific fear — Marco "claiming and making bad repairs" — is not
hypothetical, and the evidence is in the findings table:

- **106 of the 280 confirmed findings have never been re-checked at all**
  (`last_checked` is null). They are month-old assertions about code.
- Findings carry the `commit_sha` they were raised against, and per platform
  there are **many distinct SHAs** (vapron 13, alecrae 12, gatetest 8,
  zoobicon 8). The code has moved on underneath most of the backlog.
- `first_seen` spans **2026-07-30 → 2026-08-29**. A month of accumulation.
- The re-check that would close them runs at `CODE_HEALTH_MAX_RECHECK=2` per
  sweep, 8 sweeps a day — **~16/day against a 280-item backlog that is still
  growing.** A full pass takes over two weeks and never catches up.

And the only thing standing between a stale finding and a repair agent today is
**a paragraph in the prompt**. `buildFixTask()` in `src/lib/fix-dispatch.js`
lists it among the STOP CONDITIONS:

> `- The defect is already fixed. This finding was recorded against commit`
> `  ${finding.commit_sha} and the checkout may have moved on.`

That is well-written and it is still a request, not a gate — CLAUDE.md
principle 5 is explicit that boundaries are credentials and server-side checks,
never prompts. The system already knows the staleness problem exists and
delegates the whole of it to the model's judgement, on a full-permission agent
running as root. It is the highest-risk delegation in the self-repair loop.

**Craig's PowerShell repairs make this strictly worse, and they are invisible.**
He fixes things directly from the CLI. Nothing in the estate observes that:
`platform_state` records uptime, `code_findings` records what a sweep saw days
ago, and the harvester indexes Claude Code *transcripts* — not a hand-run
`git commit` on a platform he fixed himself. So every repair he performs
silently widens the gap between what Marco believes and what is true.

## What to build, in order

Ordered by how much risk each removes per hour of work. The first two are the
ones that stop bad repairs; the rest close the loop.

### 1. The freshness gate (small, highest value)

**A finding must prove it is still real at the moment of action, not when it
was born.** Server-side in `fix-dispatch.js`, not in the prompt:

- refuse to dispatch a fix when `finding.commit_sha !== <platform HEAD now>`
  unless a re-check has run *since* that HEAD landed;
- refuse when `last_checked` is null or older than N hours;
- make the first act of every repair agent a **re-read of the cited file at the
  cited line**, reporting `still_present: true|false` before it may edit
  anything — and `false` closes the finding as `fixed` (by someone else) rather
  than repairing it.

This alone converts "Marco makes a bad repair" from a live risk into a
structurally impossible one, and it costs one gate plus a test.

### 2. See Craig's own repairs

Cheap, and it feeds #1 directly. Two sources, neither requiring him to change
how he works:

- **Git is the record.** A per-platform poll of `git log` since the last seen
  SHA (local checkouts and 158 over the tailnet) tells Marco what changed,
  when, and by whom — including everything Craig did from PowerShell. Any
  finding whose `file_path` was touched by a commit newer than its
  `commit_sha` is marked **stale-pending-recheck** and jumps the re-check
  queue. This is the highest-signal, lowest-effort input available and it is
  currently unread.
- **The PC worker already has read-only verbs.** `shell.read` and
  `files.recent` can report what he touched without any new capability.

### 3. Raise the re-check ceiling and give low/mediums an exit

`CODE_HEALTH_MAX_RECHECK=2` is the throttle that guarantees the backlog never
clears. Re-checking is far cheaper than finding (one Haiku turn per finding,
per `modelFor('cheap')`). Raise it, and give the 122 `open` low/mediums the
`stale` exit the schema already allows and nothing ever sets — KNOWN DEBT #8,
still open, and it is now 122 findings that can never be verified, repaired or
closed.

### 4. Close the loop: merge → deploy → confirm

Only after 1–3, and only with Craig's explicit ruling on autonomy:

- **Merge.** Requires server-side branch protection first
  (docs/CREDENTIAL-SCOPING.md — the ~10-minute job that is still Craig's, and
  is the prerequisite for every autonomy step after it). Until that exists, one
  key writes to every repo and "auto-merge" means an agent with estate-wide
  write.
- **Deploy.** A landed commit is not live. `jarvis-deck` was serving build
  `c7c4289` today while the box's main was three commits further on — nothing
  restarts a service after a merge. `jarvis-experience`'s deploy-drift check
  notices the *repo* drift; nothing notices the *process* drift.
- **Confirm.** A repair is not done because an agent said so. The finding
  should only reach `fixed` when a re-check against the new HEAD says the
  defect is gone — the same evidence standard Rule 2 applies to humans.

### 5. Only then: turn the review runner live

`REVIEW_RUNNER_MODE=dry-run` is correct today. It should stay dry-run until
1–4 exist, because auto-approving a verdict about a stale finding is precisely
the failure Craig is describing, with a rubber stamp on it.

## The uncomfortable conclusion

"Completely self-repairing" is currently blocked on **two things only Craig can
do** — branch protection, and the decision about how much autonomy to grant —
and on **one thing the estate should stop doing**: finding more defects. At 280
confirmed and 16 re-checks a day, more detection makes the picture *less*
accurate, not more. The next unit of work should reduce the backlog's age, not
its size.

## Related

- `docs/REGISTRY-SYNC.md` — the other sync axis (what the registry *claims*).
  Same disease, different table.
- KNOWN DEBT #5 (credential scope) and #8 (`open` findings have no exit path).
- Roadmap moves 12, 13 (self-repair), 27 (alerting), 52 (registry reconciler).

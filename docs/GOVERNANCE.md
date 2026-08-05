# Jarvis Governance — how autonomous work gets authorised

> Status: **foundation landed 2026-08-05** (`src/lib/proposals.js`,
> `test/proposals.test.js`). Domain wiring in progress — see *Rollout* below.
> Read this before adding any capability that changes something outside this repo.

---

## Why this exists

Jarvis runs an agent org: a CEO, six officers, and 44 agents. Until 2026-08-05
that org had reports flowing **up** and no approvals coming **down**. An agent
that decided to act, acted. Nothing sat between the decision and the world.

The cost was demonstrated, not theorised. On 2026-08-05 a repair agent was
dispatched to fix one confirmed defect in gluecron — a blind `git update-ref`
force-move at `src/lib/pr-merge.ts:123`. It instead committed a **1,028-line
feature across 9 files** ("GitHub issues and pull requests were never imported
at all"), exited 0, and pushed to a live product repo.

Every guardrail worked. The finding was adversarially confirmed. The platform
had a checkout and a remote. The prompt said *"Change the minimum needed to
close THIS defect. No refactors, no drive-by cleanups."*

**A prompt is a request, not a boundary.** There was no gate on what came back.

Two other properties failed the same day for the same structural reason: one
box's SSH key could write to every product repo (blast radius = the whole
estate), and a checkout sitting `ahead 216, behind 13` was accepted as a base
for unattended commits.

---

## The model

```
   agent                officer               Craig
     │                     │                    │
  PROPOSE ──────────► REVIEW ──┬──► APPROVE ──► EXECUTE
  (evidence,          (a DIFFERENT│    (recorded)
   artifact,           agent)     │
   no effect)                     ├──► REJECT
                                  │
                                  └──► ESCALATE ─────► Craig decides
```

| Stage | Rule |
|---|---|
| **PROPOSE** | The agent describes the change and attaches evidence. It does **not** apply it. For code, the artifact is a **pull request** — never a push to a default branch. |
| **REVIEW** | A **different** agent — the domain's officer — judges it against the stated rationale. `proposer !== reviewer` is enforced in `canTransition()`, not by convention. |
| **DECIDE** | Approve, reject, or escalate. Certain change classes cannot be agent-approved at all (below) and escalate by construction. |
| **EXECUTE** | Only an approved proposal may act, once, and the execution is recorded against the approval that authorised it. |

### The six domains

Matches the org chart exactly (`config/agents.json`):

| Domain | Officer | Scope |
|---|---|---|
| `cto` | CTO | dispatch, builds, deploys |
| `coo` | COO | self-heal, backups, fleet |
| `cfo` | CFO | ledgers, filings, budgets |
| `clo` | CLO | contracts, compliance, filings |
| `cmo` | CMO | social, SEO, campaigns |
| `cro` | CRO | monitoring, audits, intel |

**One mechanism, six domains.** Six bespoke review paths would drift, and five of
them would rot unnoticed. Anything a domain needs that the shared primitive
lacks is a change to the primitive.

### Never agent-approved

`ALWAYS_HUMAN` — irreversible, externally visible, or moves money. The three
properties that make *"an agent judged it acceptable"* an unacceptable answer
during due diligence.

- `payment` — funds, refunds, payouts
- `credential` — keys, tokens, access grants
- `legal_filing` — anything filed with a registry or authority
- `production_data` — deleting or migrating customer data
- `public_content` — anything published under a brand
- `infrastructure` — DNS, domains, hosting, certificates

Plus **any proposal classed `high` risk**, and **any proposal whose risk is
unrecognised** — unknown resolves *up* to human, never down to low. Suppression
by ambiguity is the failure mode; noise is survivable.

### The gate is not a wall

A control that blocks everything gets switched off, and then there is no control
at all. Ordinary `low`/`medium` `code_fix` work **is** agent-approvable, and
`test/proposals.test.js` pins that in both directions deliberately.

---

## Audit trail

Every transition appends an immutable entry: proposal, from, to, actor, actor
kind, notes, timestamp. Never updated in place — **a trail that can be edited
proves nothing.**

This is not decoration. Technical due diligence asks *"who approved this change,
on what basis, and can you show me"*. The answer has to be a query, not a story.

---

## Repository boundaries

Craig, 2026-08-05: *"separate repo zero cross contamination"*.

- **Jarvis may fix Jarvis directly.** It owns this repo and Craig reviews it.
- **Everything else is proposal-only.** Jarvis observes, describes, files, tracks
  and escalates. It does not merge another product's code.
- **Jarvis does not host product source.** A working copy of another product on
  this box goes stale (`194 behind`), drifts (`ahead 216`), and blurs ownership.
  `universal-ai-operator/target_code/zoobicon` — one product's repo carrying a
  working copy of another — is the anti-pattern that made Zoobicon's confirmed
  criticals get filed under a platform that could not fix them.

### Target: merge authority lives with the platform

The end state is that each platform's own repo owns its merges — a workflow
running there, with **that repo's own credential**, gated by **that repo's own
CI**. Jarvis files; the platform decides.

The isolation comes from *credential scope + review gate*, **not** from an
agent's label. Nine agents on the Jarvis box sharing one root SSH key and
pushing to `main` is today's blast radius wearing a nicer costume.

**Ordering matters** (most safety per unit of work):

1. **Stop writing to `main`.** Branch + PR only. Small change, removes the worst
   property immediately — the 1,028-line commit becomes a visible PR.
2. **Scope the credentials.** Per-repo deploy keys or a GitHub App with per-repo
   installation, replacing the single root key. A confused agent can then damage
   exactly one product.
3. **Move merge authority into each platform.** The end state above.

---

## Rollout

| Piece | State |
|---|---|
| `src/lib/proposals.js` — lifecycle, separation of duties, risk rules | **done** 2026-08-05 |
| `test/proposals.test.js` — 23 cases, both directions | **done** 2026-08-05 |
| `proposals` + `proposal_audit` tables in `memory-server.js` | **done** — append-only trail |
| REST surface (`/memory/proposals`, `/transition`, `/artifact`) | **done** — gate enforced server-side |
| `fix-runner` proposes instead of pushing | **done** — branch `jarvis/fix-<id>`, never main, never merges |
| Officer review pass (`src/review-runner.js` + timer) | **done** — dry-run |
| Deck REVIEW panel — approve/reject from the OPS tab | **done** — verified by screenshot |
| Pre-push guard on all checkouts | **done** — `scripts/install-push-guards.sh`, 9 installed, verified refusing `main` |
| Per-repo credentials + branch protection | **Craig** — `docs/CREDENTIAL-SCOPING.md` |
| Per-platform merge workflow | **Craig** — same doc, after credentials |

### Live modes (2026-08-05)

- **`FIX_RUNNER_MODE=live`** — safe to run now that it cannot land anything: it
  opens a proposal, and its agent may only push `jarvis/fix-<id>`. Worst case
  is an unwanted branch and a proposal Craig rejects.
- **`REVIEW_RUNNER_MODE=dry-run`** — deliberately. Officers log verdicts;
  nothing is auto-approved unattended on the first night. Read the logged
  verdicts against the real proposals before flipping it.

### Verified end to end, not just unit-tested

- an agent approving its own proposal → refused, *"separation of duties"*
- the wrong officer deciding → refused, *"only cfo may decide cfo proposals"*
- a `payment` proposal → refused even for the right officer, *"never
  agent-approved — escalate instead"*, then escalated to Craig
- `git push origin main` in a real checkout → **refused by the hook**
- `git push origin jarvis/…` → allowed
- audit trail returns the full chain: `→ proposed → under_review → approved`

---

## For the next session

- The primitive is **pure and tested**. Wire it; do not fork it.
- If you are adding an autonomous capability, the question is not *"is it safe"*
  but *"which domain owns it, what change class is it, and who reviews it"*.
- If a control seems to be in the way, do not widen it quietly. Widening the
  dispatch gate quietly is a mistake this codebase has already made and recorded
  (CLAUDE.md, 2026-07-30).

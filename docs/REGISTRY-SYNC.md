# REGISTRY SYNC — keeping Marco synchronised with the platforms

> Spec, 2026-08-28. Written from Craig's question: *"how do we keep
> jarvis/marco synchronised with the platforms."* Phase 1 (registry-driven
> fleet-check) has shipped; this document specifies phase 2, the reconciler,
> and is the thing to read before building it.

## The four axes, and which one is unwatched

Synchronisation is four different questions wearing one word. Three of them
already have a mechanism:

| Axis | What it asks | Mechanism | Cadence |
|---|---|---|---|
| **Liveness** | is it up? | `scripts/fleet-check.sh` → `platform_state` | 10 min |
| **Code truth** | are there defects in its source? | `jarvis-code-health` (1 platform × 1 of 9 lenses) | 3 h |
| **Topology truth** | is what the registry SAYS about it still true? | *nothing* | — |
| **Birth & death** | did something arrive or die without us noticing? | half — the build pipeline registers at birth; nothing ever deregisters, and nothing notices an unregistered live platform | on build only |

Phase 1 (2026-08-28) fixed a liveness hole inside axis 1: `fleet-check.sh`
kept its own hardcoded target list, which had drifted from the registry three
ways — most sharply, `marco-demo` was registered at birth on 2026-08-25 and
never probed once. Targets now derive from `config/platforms.json`
(`src/lib/fleet-targets.js`), so *registered* and *watched* are one word.

**Axis 3 remains the answer to Craig's actual question, and it is unbuilt.**

## Why axis 3 matters — the evidence

- **DavenRoe, 2026-08-10/11.** It moved off Vercel onto this box. The registry
  said `"server": "vercel"` for **five days**. Every service stayed green the
  whole time, because nothing has ever asked the registry whether it is still
  describing reality. Found by a human reading the file.
- **`/var/www/zoobicon`, 2026-07-30.** `ZOOBICON_PATH` and `ALECRAE_PATH`
  pointed into a directory that does not exist on this box. Two platforms, one
  of them the flagship, were "audited" daily for weeks and the score was a
  fabricated number arrived at in silence (`src/lib/checkout.js` exists because
  of it — but it only guards the audit's own entry, it never files the fact
  that a registry path is a lie).
- **`esim`**, retired long ago, still has a `platform_state` row. Nothing
  reaps. Conversely the real eSIM MVNO is not registered, so intent routing
  cannot target it — a live thing invisible to the estate (KNOWN DEBT #3).
- **`/opt/vapron`'s git origin is a local bare repo**, not the GitHub URL a
  reader would assume from the registry's `repo` field.

The shared shape: a registry entry is a *claim*, CLAUDE.md says so explicitly
("a path in config is a claim — verify it"), and claims here are verified only
by a human happening to look.

## Design — `jarvis-registry-check`

A read-only reconciler on a timer. It repairs nothing and edits nothing.

- **Unit**: `jarvis-registry-check.timer`, oneshot, `TimeoutStartSec` set
  explicitly (doctrine — the default is no timeout).
- **Cadence: daily.** Topology changes on the scale of days, not minutes, and
  the checks cost SSH round-trips. Daily also means the noise floor is one
  possible announcement per day, by construction.
- **Entrypoint** `src/registry-check.js`; **pure logic + tests**
  `src/lib/registry-truth.js`, `test/registry-truth.test.js`. Every check
  carries the incident that earned it, the way `src/lib/experience.js` does —
  this is not a place to add plausible-sounding checks.
- **Reuse the experience-check noise discipline literally**, not a second copy
  of it: `fingerprint()` / `announcement()` / `summarize()` are already
  exported from `src/lib/experience.js`. One mechanism, not N.

### The checks

Each runs per registry entry where `status === 'active'`, and each answers a
question the registry currently only asserts.

1. **`path` exists on `server`, and holds that platform's own source.**
   Local for this box, tailnet SSH for 158. `hasSource()` in
   `src/lib/checkout.js` already answers the second half — reuse it rather
   than re-deriving "is there anything buildable here".
   *Incident: `/var/www/zoobicon`, weeks of fabricated audit scores.*
2. **`server` matches where the site actually answers from.** Resolve
   `site_url`, compare the answering address against the claimed `server`
   (this box's IP, `158`, `vercel`, …). A mismatch is the DavenRoe case and
   should say so in the finding.
   *Incident: `"server":"vercel"` for five days.*
3. **`repo` matches the checkout's real `git remote get-url origin`.**
   Report the drift; do not assume the registry is the correct half.
   *Incident: `/opt/vapron`'s origin is a local bare repo; gatetest's repo was
   wrong until the 2026-08-08 truth pass.*
4. **`site_url` resolves and is the canonical spelling** — following redirects,
   report when the declared URL is not where the site actually lives (the
   `www.davenroe.com` / `davenroe.com` split, now merged onto the registry's
   spelling with nothing checking which one is right).
5. **Reverse sweep — live things nobody registered.** Cross-reference
   listening ports (`ss -tlnp`), Traefik's dynamic config in
   `/data/coolify/proxy/dynamic/`, and the systemd unit list against the
   registry. Anything serving a domain that no entry claims gets ONE `info`
   row. This is the only check that can find the *next* DavenRoe or the
   unregistered eSIM MVNO, because it looks at the box rather than down the
   list.
6. **Stale `platform_state` reaper — report only.** A row whose platform is no
   longer a registry key (`esim`) or whose `updated_at` has not moved in >7
   days while the platform is `active`. A row that stops moving is exactly what
   a monitoring hole looks like from the outside, so it must never be silent.

### Output, and where it must NOT go

- Findings go to the **inbox** (`POST /memory/notifications`, `source:
  'registry-check'`), at `warn` — never `alert`. `alert` is exempt from push
  dedupe and the hourly cap; a daily timer that can reach it is the 235-push
  flood in slow motion.
- Announce **on change**, once daily while unchanged, once on recovery. Same
  contract as `jarvis-experience`.
- **Not** to `code_findings`. These are topology facts, not code defects, and
  that backlog already has 300-odd `open` low/mediums with no exit path
  (KNOWN DEBT #8). Polluting it with a different kind of thing makes the
  number mean even less.

### It proposes; it does not edit

The reconciler must never write `config/platforms.json` itself. The registry is
infrastructure, it is hot-reloaded into every service, and `infrastructure` is
an `ALWAYS_HUMAN` class in `docs/GOVERNANCE.md`. A confident, mechanical fix
("`server` should say `66.42.121.161`") may open a **proposal** carrying the
diff; Craig or the owning officer approves it. Anything less than certain is
an inbox row and nothing more.

This is also the honest position: in every incident above, it was ambiguous
*which half was wrong*. DavenRoe's registry entry was stale — but a `repo`
mismatch might equally mean someone repointed a checkout by mistake. A checker
that "corrects" the registry toward the box would have quietly ratified that.

## Acceptance — how we know it works

Rule 2 applies: a named artifact, not "the code looks right".

1. `test/registry-truth.test.js` green, with a case per incident above.
2. Run it live on the box against the real registry and read the output.
3. **Seed a known lie and watch it caught**: temporarily point a copy of the
   registry at `"server": "vercel"` for davenroe (the exact 2026-08-11 state)
   in a sandbox tree, run, confirm check 2 fires with a legible message.
4. Confirm a second consecutive run announces *nothing* — the noise discipline
   is the part most likely to be wrong, and the part that gets it switched off.

## Open questions for Craig

- **Check 5's blast radius.** The reverse sweep will find co-tenant services
  (AlecRae, Gluecron, GateTest, Coolify's own stack) that are legitimately not
  Jarvis platforms. It needs an allowlist, and the allowlist is a judgement
  call about what counts as "a platform" versus "something running on the box".
- **Should a `repo`/`path` mismatch on a co-tenant open a proposal at all**, or
  only ever an inbox row? Rule 4 says never break co-tenants; a proposal that
  edits our registry does not touch them, but it is worth being explicit.

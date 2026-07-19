# Jarvis on Vapron — integration seams & scale architecture (draft v1)
**2026-07-17 · the contracts both sides build toward, tuned for extreme reliability + load**

> Thesis: **Jarvis is the fish hook.** It's the emotional, "I can talk to my whole
> infrastructure and it just handles things" product that pulls people onto Vapron —
> and once they're on, they use Deploy, Network, Mail, Comms, Data. So Jarvis must be
> (1) incredibly intelligent, (2) incredibly reliable, (3) able to take immense load.
> The way we get all three is to build Jarvis **as a native Vapron tenant workload**,
> not as a bolted-on box — so it inherits Vapron's isolation, billing, networking and
> ops discipline, and every Vapron scale win is a Jarvis scale win.

---

## 0. The one decision everything hangs on — the execution model

**Decision: Jarvis is a per-tenant AI *copilot*, not a per-tenant root box.**

Jarvis reasons freely, watches everything, searches/verifies the live web, and *acts*
through **two bounded channels only**:
1. **Vapron's own control-plane APIs** (deploy, DNS, mail, comms, data) — already
   audited and confirm-gated. Jarvis's "hands" are Vapron's APIs, scoped to the tenant.
   This is the natural extension of what you already built: **BLK-241 (MCP with teeth,
   agents invoke real JARVIS playbooks)**.
2. **Vetted playbooks** — parameterised, reviewed action templates that run as Vapron
   background-worker / isolate jobs, never arbitrary host shell.

Why this is the right call and not a compromise:
- **You cannot hand a million strangers a root shell** on shared metal — it's
  unshippable at any scale. So the "open shell" model was never the product anyway.
- Acting *through Vapron's APIs* means Jarvis inherits Vapron's **audit log, confirm
  gates, and blast-radius limits for free** — the safety is already built.
- It maps cleanly onto Vapron's **actual compute** (V8 isolates + background workers +
  Turso job queue), so no new per-tenant VM substrate is required to launch.
- Craig's own Jarvis (single-tenant, on 66.42.121.161) keeps its deeper shell powers as
  the *admin/reference* tier; the **multi-tenant product is the copilot tier**.

*(If, later, a customer segment genuinely needs sandboxed arbitrary code, that's a
per-tenant micro-VM add-on — a separate, heavier track. Not needed to launch.)*

---

## 1. The seams — the contracts the two teams build toward

Seven interfaces. Agree these and Jarvis-on-Vapron mostly falls out of work already
underway on both sides.

| # | Seam | Contract | Vapron primitive it rides |
|---|------|----------|---------------------------|
| 1 | **Identity** | Jarvis never has its own accounts. Every request carries a Vapron-issued tenant identity (JWT/session → `tenant_id`, `project_id`, roles). | Vapron auth + dashboard |
| 2 | **Provisioning lifecycle** | Add-on enabled → webhook `jarvis.provision(tenant)`; disabled/cancelled → `jarvis.deprovision(tenant)`. Both **idempotent**, both emit an audit event. | Deploy-agent / control plane, HMAC webhooks |
| 3 | **Execution** | Jarvis proposes → executes ONLY via (a) Vapron control-plane API calls scoped to the tenant, or (b) a registered playbook worker. No raw host access. Every action is confirm-gated by class. | MCP server (BLK-241), background workers, job queue |
| 4 | **Metering / billing** | Every AI token and every billable action emits a usage event to Vapron's usage pipeline. Jarvis is a **metered add-on SKU**, priced in the existing plan table. | Stripe metered usage (`STRIPE_USAGE_PRICE_MAP`), AI Gateway token buckets |
| 5 | **Networking** | Each tenant's Jarvis lives inside that tenant's project network; reaches the tenant's services over `.internal`; the customer reaches Jarvis **privately**, never the public internet. | Per-project **WireGuard** + `.internal` hostnames |
| 6 | **Data / memory** | Per-tenant Jarvis memory in the tenant's own DB (hard isolation). Global *learning* (see §4) in a separate store with strict tenant-scoped, anonymised access. | Turso per-tenant edge replicas; Neon Postgres |
| 7 | **Brain / inference** | All LLM calls go through the AI Gateway: metered, rate-limited, cached, tiered. Tenant may supply their own provider key (scoped to their sandbox). | AI Gateway (5 providers), 3-tier compute mesh |

---

## 2. Reliability — "incredibly reliable" as an architecture, not a hope

Reliability is designed in at four layers:

**No single point of failure.**
- The Jarvis app/worker tier is **stateless** — all per-tenant state lives in Turso/
  Postgres (replicated). Any node serves any tenant; lose a node, lose nothing.
- Today both Vapron and Jarvis are single-box. **Precondition #1 for the product is
  Vapron going multi-node** (see §5). Until then, we pilot; we don't sell "immense load."

**Blast-radius isolation — one tenant can never hurt another.**
- Per-tenant worker quotas, per-tenant AI-Gateway token buckets, per-tenant circuit
  breakers. A runaway or hostile tenant trips *their* breaker, not the fleet's.
- This is the exact lesson from Jarvis's own history: a mis-set guardrail once fired
  117 repair jobs in a day. At multi-tenant scale that discipline is mandatory — every
  guardrail parses defensively and fails safe.

**Graceful degradation — Jarvis is never fully "down."**
- The **read/watch path is independent of the act path.** If the brain or an action
  channel is unavailable, monitoring, alerts and status still work.
- **Three-brain failover is already built** (GPT ↔ Claude ↔ Gemini, auto-failover,
  proven in production on 66.42.121.161). If one provider 400s or runs out of credit,
  the next answers; if all fail, Jarvis drops to a basic deterministic mode and *says so*
  rather than confabulating.

**Self-proving + self-healing.**
- Point Vapron's probe-everything + claim-truth CI gate + audit-on-every-action at the
  Jarvis tier, and Jarvis's own self-heal at the tenant workloads. Dead-man's switches
  on both. Confirm-gates on every destructive action class (built on both sides).
- SLOs authored in natural language (BLK-242): "page me if any tenant's Jarvis p99 > Xs."

---

## 3. Scale — "immense load" as a set of choke-point defeats

Load in this product is dominated by **AI inference cost and concurrency**, not web
requests. The architecture attacks each choke point:

- **Stateless horizontal scale** of the app/worker tier → Vapron autoscaling handles
  request and job concurrency.
- **Per-tenant state sharding is free** — Turso edge replicas *are* the shards; no giant
  shared DB to contend on.
- **Inference is the real cost, so it's tiered + cached:**
  - Vapron's **3-tier compute mesh** — small models on the client via WebGPU (free),
    then edge isolates, then cloud GPU — means most routine reasoning never hits a paid
    frontier model.
  - AI-Gateway **response caching** collapses repeated questions across the fleet.
  - Route by task: cheap/fast model for classification & monitoring, frontier model only
    for genuine reasoning. (Jarvis's provider layer already does per-task model choice.)
- **Backpressure everywhere** — per-tenant token buckets + job-queue depth limits; excess
  work queues or sheds gracefully, never melts a node.
- **Async by default** — probes, playbook runs, and heavy actions are queued jobs that
  survive deploys (Vapron's Turso-backed queue), not synchronous blocking calls.

Rough capacity intuition: with tiered inference + caching, a single well-provisioned
node serves *thousands* of monitored tenants because the steady state is cheap probes +
occasional cached reasoning; frontier-model calls are the rare, metered, billed events.

---

## 4. Intelligence — the compounding moat (why it takes off fast)

The reason this "could take off really quick" is a **flywheel you already started building**:

- **Fleet-wide incident memory (BLK-257)** — a fix learned for one tenant is instantly
  recognised for all. *The more customers, the smarter Jarvis gets for everyone.* That's
  a compounding advantage no single-tenant competitor can match — classic network-effect
  moat, and it's the real fish hook.
- **Platform semantic layer + App Graph (BLK-235/236)** — Jarvis already *understands*
  each tenant's estate, so its advice is specific, not generic.
- **Multi-brain + web eyes** — three interchangeable frontier models plus live
  search/fetch/render (already built) mean Jarvis reasons well *and* checks reality
  before it speaks.
- **Bounded playbooks + open reasoning** — safe to act, free to think.

Guardrail on the flywheel: fleet learning must be **anonymised and tenant-scoped** —
patterns and fixes propagate, raw tenant data never does. That boundary is a launch
requirement, not a nice-to-have.

---

## 5. Staged rollout — and exactly what breaks at each step

| Stage | Tenants | The choke point that must be solved first |
|-------|---------|-------------------------------------------|
| **Pilot** | 1–10 | Single box is fine. Prove the 7 seams end-to-end with real tenants. Billing still off. |
| **Early access** | 10–1,000 | **Vapron multi-node** (kill the single-box SPOF) + per-tenant isolation quotas. Flip billing on (Craig's 110% gate). |
| **Growth** | 1k–100k | DB write contention → lean fully on per-tenant Turso sharding; AI-Gateway caching + tiering carry inference cost; support/ops tooling. |
| **Scale** | 100k–1M+ | Multi-region; regional inference; fleet-learning store partitioned; automated tenant lifecycle at volume; cost controls per plan enforced hard. |

Golden rule: **we never advertise a stage we haven't proven.** (Vapron's own claim-truth
CI gate is the cultural fit — sell only what production demonstrates.)

---

## 6. Open items to confirm with the Vapron team
1. **Execution boundary** — confirm playbook workers + control-plane API calls cover the
   action surface we want; agree the per-class confirm-gate list.
2. **Provisioning hooks** — is there a signup/add-on-enable + cancel webhook we bind to?
3. **Auth/identity API** — how Jarvis receives and validates `tenant_id` per request.
4. **Metering event shape** — the exact usage-event contract to feed `STRIPE_USAGE_PRICE_MAP`.
5. **Fleet-learning store** — where global (anonymised) incident memory lives vs per-tenant Turso.

---

## 7. What's already real today (so this isn't starting from zero)
- **Jarvis** (single-tenant reference): 3-brain provider layer w/ auto-failover, browser
  tool (search/fetch/render, SSRF-guarded, audited), unified dispatch confirm-gate,
  self-heal, voice + neural-core UI, one tailnet front door. Proven in production.
- **Vapron**: metered Stripe billing (built, gated), per-project WireGuard, Turso/Neon/
  Qdrant/MinIO data layer, AI Gateway, 3-tier compute mesh, MCP + JARVIS playbook
  executor, fleet incident memory, probe-everything + claim-truth CI. Under active build.

The gap between these two and the product above is **integration and hardening, not
invention.** Both halves largely exist; the work is agreeing the seams and building
toward them as each side grows.

# Vapron capability brief — for a "Jarvis" clip-on product

**Goal:** We want to offer *Jarvis* — an autonomous AI assistant that monitors and
operates a customer's web platforms and can run automated tasks on their behalf
(including executing code and calling external APIs) — as a **paid add-on for Vapron
customers**. The plan is to let **Vapron be the platform layer** (accounts, billing,
private networking, tenant isolation) and provision a per-customer Jarvis on top,
rather than rebuild that plumbing ourselves.

Before we design it, we need to understand what Vapron already provides, so we build
**on** it instead of reinventing it. Please answer what you can — a "no / not yet /
on the roadmap" is just as useful to us as a "yes". Rough answers are fine.

---

## What we already found (from Vapron's public site)
Vapron advertises: an **edge runtime = V8 isolates on your own bare metal** (Live),
**authoritative DNS** (Live), **S3-compatible object storage** (Soon), and **WAF /
DDoS / CDN / rate-limiting on your own metal**, organised into **projects** managed
in a **dashboard** with domain connection. So the networking, DNS, edge-serving and
multi-project scaffolding clearly exist. The questions below are the parts a
marketing site can't tell us — especially the compute model, since **V8 isolates and
a long-lived code-executing agent are very different things** (see #1).

## ⭐ The one that matters most — per-tenant isolated execution
Jarvis's core feature is that it can *act*: it runs automated agents that execute
shell commands, run code, and push changes — a **long-lived process**, not a
stateless request handler. V8 isolates (edge functions) are great for the latter but
generally can't run arbitrary code / a persistent process. So, the critical questions:
1. **Beyond V8 isolates**, can Vapron give each tenant a **long-lived, code-executing
   sandbox** (container / micro-VM) that can run shell commands and background work
   with **no access to other tenants or the host**? Or is compute today isolate-only?
2. What is the isolation boundary (isolate, container, VM, separate node)?
3. Can a tenant run a **persistent background process** (a standing Jarvis instance)?
4. Are there **per-tenant resource limits** (CPU/RAM/disk/network)?
5. Any **egress controls** — can we allow/deny a tenant's outbound network from the sandbox?

## Accounts & tenancy
6. Do you have **multi-tenant user accounts**? How is a tenant identified (id/slug)?
7. Auth method (email/password, OAuth/SSO, magic link)? Is there an **API** to look up
   or authenticate a tenant?
8. Roles/permissions per account? Teams/multiple users per tenant?
9. Can we attach a **per-tenant entitlement / add-on flag** (i.e. "this customer has Jarvis")?

## Billing & metering
10. What billing system is in place (Stripe, other)? Subscriptions, usage-based, or both?
11. Can we add a **new paid add-on** with its own price/plan?
12. Can you **meter usage** and bill on it (e.g. per request, per AI token, per seat)?
    Can Jarvis push usage events to you to bill from?
13. Trials, proration, cancellation/tear-down hooks?

## Provisioning & deployment
14. How is a new tenant/app **provisioned today** — API, control plane, infrastructure-as-code?
15. Can we **programmatically stand up** a per-tenant Jarvis on signup and **tear it down**
    on cancellation? Is there a webhook/event on signup and on cancel?
16. What runs the workloads (Docker, Kubernetes, Nomad, Coolify, bare processes)?
17. Is there a CI/CD / image-deploy pipeline we'd plug into?

## Private networking
18. What does **"private networking"** mean concretely on Vapron (VPC, WireGuard,
    Tailscale, per-tenant network segments)?
19. Can a tenant's services be made **reachable only by that tenant** (their devices/users)?
20. How do customers connect securely to their own resources today?

## Data & storage
21. What **database** options are available per tenant (Postgres, etc.)?
22. How is tenant data **isolated** — separate database, separate schema, or row-level?
23. Per-tenant **file/object storage**?
24. **Backups**, restore, retention, and any data-residency/region requirements?

## Secrets management
25. How are **per-tenant secrets / API keys** stored and injected (vault, encrypted env)?
26. Can a customer safely **supply their own API keys** (e.g. their own OpenAI/Gemini key)
    scoped to just their sandbox?

## Scale & limits
27. Current scale — roughly how many tenants, and peak concurrency, does Vapron run today?
28. What is Vapron **designed/tested** to handle? Any known ceilings?
29. **Autoscaling**? **Multi-region**? Single point of failure anywhere in the stack?

## Observability, security & compliance
30. Logging, metrics, and **per-tenant audit trails**? Alerting / on-call / any SLA?
31. Encryption at rest and in transit? Tenant data-isolation guarantees?
32. Any compliance posture (SOC 2, GDPR, etc.)?

## Blockers
33. Is there **anything** that would prevent running, per tenant, a long-lived AI agent
    that executes code and makes outbound web/API calls? If so, what?

---

**Most important answers for us:** #1–5 (isolated execution), then #14–16 (programmatic
provisioning) and #10–12 (billing/metering). Those three decide whether Jarvis-on-Vapron
is a medium integration or a larger build. Thank you.

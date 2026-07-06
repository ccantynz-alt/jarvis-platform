# Jarvis Roadmap & Decisions Ledger

> **This is the single source of truth.** Every agent (Jarvis-dispatched, Vapron's,
> or interactive) reads this at session start and updates it the moment a decision
> changes. If this file disagrees with reality, fix reality *or* fix this file —
> never leave them out of sync. Last updated: 2026-07-07.

---

## DECISIONS LOCKED (read before acting — stops agents contradicting each other)

| Decision | Status | Notes |
|---|---|---|
| Vapron stays on **149.28.119.158**, Jarvis controls it remotely | ✅ DECIDED | Critical shared backend → its own resilient home, not co-located. |
| All platforms → **Vapron as backend via API onboarding** (dogfood) | ✅ DECIDED (direction) | Vapron already has the API + SDK (`packages/sdk`). Roll out one platform at a time. |
| Jarvis Gateway = **private mesh (Tailscale), NOT public HTML** | ✅ DECIDED (direction) | PWA front-end can be public (powerless); control channel private. Build when Voxlen is green. |
| Cloud executor (`runCloud`) | 🔒 OFF | Stays off until registry repos are fixed (#8) + cloud creds confirmed. |
| Canonical Vapron repo | 🟡 RECOMMEND `/root/Vapron` (`ccantynz-alt/Vapron`, branch `Main`) | Craig to confirm which GitHub repo he actually pushes to. |
| GateTest canonical repo | 🟡 INFER `crclabs-hq/GateTest` | All tonight's work came from there; registry wrongly says `ccantynz-alt/gatetest`. Craig to confirm. |
| **Slack** — keep or drop | ⏳ PENDING | Leaning: replace with the conversational Gateway; Slack becomes legacy. Not yet locked. |
| Registry repo fixes (gatetest/alecrae/bookaride) | ⏳ PENDING Craig confirm | Blocks safe cloud dispatch. |

## BANKED (done — do not redo)
Dashboard token auth · cups/:631 closed · gluecron-update timer disabled · nightly
memory backups (03:30) · Haiku intent routing · `runCloud` code (flag-off) · Vapron
Phase-0 investigation · GateTest scanner self-contradiction fixed · GateTest MCP endpoint
live (`mcp.gatetest.ai`).

---

## THE 20 MOVES (order = strategy; reliability is the floor)

### Phase 1 — STABILIZE (kill "everything breaks")
1. ✅ Restart policies — all jarvis-* + gatetest-mcp = `Restart=always`, alecrae = `on-failure`. (Container autoheal deferred — could conflict with Coolify; Craig call.)
2. ⬜ Resource guards — per-container memory limits + pre-OOM alerting.
3. ✅ Off-box watcher extended to the whole public fleet (`jarvis-fleet-watcher`, hourly, deduped GitHub-issue alerts, known-down list to avoid noise).
4. ⬜ Consolidate the proxy layer (4 front doors → 1) — endgame is Vapron (#18).
5. ✅ Restore-drill passed — backup recovers faithfully (all tables match, integrity ok).

### Phase 2 — ALIGN (stop the burning)
6. This ledger — every agent reads/updates it. **(seeded by this file)**
7. Point all CLAUDE.mds here; enforce Rule 0.
8. Fix registry repo mismatches (closes cloud cross-contamination).
9. Enforce session protocol — auto-log repairs to memory.

### Phase 3 — AUTOMATE (self-running)
10. Agent runtime → Claude Agent SDK, scoped permissions (retire `--dangerously-skip-permissions`).
11. Enable cloud executor (after #8 + creds).
12. Turn on self-repair (jarvis → cloud).
13. Auto-dispatch + guardrail layer (allowlist, spend caps, confidence thresholds).
14. Intent routing → HTTP API (~300ms vs ~4-10s CLI).

### Phase 4 — CONSOLIDATE onto Vapron
15. Confirm canonical Vapron repo; clean the 3-checkout mess.
16. Add Jarvis SSH key to 158 + update registry (Jarvis can't reach 158 today).
17. Onboard GateTest to Vapron as pilot tenant #1 (prove the loop).
18. Migrate off Coolify → Vapron proxy (endgame of #4).
19. Roll remaining platforms onto Vapron; Jarvis's #1 monitor = Vapron API health.

### Phase 5 — INTERFACE (the product)
20. Jarvis Gateway MVP — private mesh, streaming brain, voice in/out (when Voxlen green; may be the ears).

---

## OPEN QUESTIONS FOR CRAIG (unblock when convenient)
- Slack: keep, drop, or keep-and-plan-migration?
- Canonical repo per platform (esp. gatetest: `ccantynz-alt/gatetest` vs `crclabs-hq/GateTest`).
- Deploy GateTest site now (compose+Traefik) or wait for the Vapron path?

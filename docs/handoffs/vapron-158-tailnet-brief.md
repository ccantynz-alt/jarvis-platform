# HANDOFF BRIEF: Box 158 (Vapron) joins the Jarvis tailnet

**From:** Jarvis session 51, box 161 (66.42.121.161) · 2026-07-08
**To:** the Vapron control-plane session on box 158 (149.28.119.158)
**Authority:** Craig's decisions 2026-07-08, recorded in Jarvis `docs/ROADMAP.md` (decisions
table) and `docs/GATEWAY.md`. Estate model: never SSH between boxes — this brief is the
transport for cross-box work.

## Context

The Jarvis estate adopted a private Tailscale mesh: box 161, box 158, and Craig's devices in
one tailnet, so cross-box monitoring/control traffic is invisible to the public internet.
161 now runs the **Jarvis Gateway** (conversational interface + notification inbox). 158's
part is small: join the tailnet, expose Vapron's health endpoint tailnet-only, and send a
heartbeat. Nothing on 158 changes ownership; no Jarvis code lands on 158.

## Tasks (in order)

### 1. Join the tailnet
```bash
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh=false --accept-dns=false
```
- `--ssh=false`: the estate model forbids cross-box SSH; do not enable Tailscale SSH.
- `--accept-dns=false`: leaves 158's resolv.conf untouched (Vapron's ~56 services must not
  see a DNS change).
- The `tailscale up` command prints a login URL — **Craig authenticates it** into the same
  tailnet as 161 (node name will be whatever 158's hostname is).
- Ask Craig to disable key expiry for the node in the Tailscale admin console.

### 2. Expose Vapron health, tailnet-only
Pick the existing aggregated health endpoint (or add a minimal one) on a loopback port, then:
```bash
tailscale serve --bg https:443 http://127.0.0.1:<vapron-health-port>
```
- This serves it ONLY on the tailscale interface with a valid cert — it must NOT be public.
- Report back (via Craig or a reply brief): the node's ts.net name and the health path,
  e.g. `https://<158-node>.<tailnet>.ts.net/health`. Jarvis's fleet-check will probe it
  every 10 minutes.
- Preferred payload: per-service status + queue depths + disk/memory + versions. Even a
  simple `{"status":"ok"}` is acceptable for v1.

### 3. Heartbeat to the Jarvis Gateway (dead-man's switch)
Every 5 minutes, POST:
```bash
curl -s -X POST https://vultr.<tailnet>.ts.net/internal/heartbeat \
  -H "Authorization: Bearer $JARVIS_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"vapron-158","status":"ok"}'
```
- Craig supplies `JARVIS_GATEWAY_TOKEN` (in 161's `/opt/jarvis/config/secrets.env`) — do not
  transmit it over anything but the tailnet or Craig's own hands.
- Implement as a systemd timer on 158 (5-min interval, `Persistent=true`).
- If heartbeats stop for >15 minutes, the Gateway raises a spoken + inbox alert on Craig's
  devices automatically. When they resume, it announces recovery. No further wiring needed.

### 4. Also owed to 161 (separate, from tonight's Gatetest work)
The gatetest tenant on Vapron has a freshly rotated `vpk_` key that never reached 161.
Deliver to Craig for placement in `/opt/gatetest/website/.env.local`:
- the `vpk_` key value (for `VAPRON_API_KEY` / `VAPRON_API_TOKEN`),
- `VAPRON_DISPATCH_SECRET` (HMAC for gatetest→Vapron dispatch + runtime callbacks —
  contract documented in gatetest `website/app/lib/vapron-dispatch.js`).

## Boundaries
- No SSH keys exchanged in either direction. No Jarvis code on 158. No public exposure of
  anything new — tailnet only.
- Rollback at any time: `tailscale down` (and remove the systemd timer). Nothing else on 158
  depends on the tailnet.

# Fleet autonomy — the one-time setup that unlocks headless Jarvis

This is the single human step behind the whole "Jarvis acts while I'm on a plane"
plan (see `/root/.claude/plans/generic-sprouting-mist.md`, Phase 1). ~15 minutes,
done once. After it, new boxes join and Jarvis operates with zero prompts.

There are two ways to do it: **(A)** click through the Tailscale admin console, or
**(B)** hand Claude a Tailscale API token and it scripts almost all of it. Pick one.

---

## What we're fixing (verified on this box)

- Tailnet node is authed as Craig's personal Google account, **untagged**.
- **Key expiry is ON** (this node expires 2027-01-04 → eventual forced re-login).
- **Tailscale-SSH is in "check" mode** → every box→box SSH pops a browser re-auth.
- **No auth key / OAuth client exists** → a new box cannot join without Craig.
- Jarvis's own SSH key (`/opt/jarvis/.ssh/orchestrator.pub`) is **not** on box 158;
  it currently reaches 158 only by borrowing root's personal key over the public IP.

---

## Option A — Admin console (≈15 min)

1. **Apply the ACL.** Admin console → **Access controls** → paste the contents of
   `/opt/jarvis/config/tailscale-acl.json` → Save. (This defines `tag:server` and the
   "fleet box → fleet box SSH without check" rule.)

2. **Tag the existing boxes as servers.** Machines → for **jarvis (vultr / 161)** and
   **vapron-158**: ⋯ → **Edit ACL tags** → add `tag:server`.

3. **Disable key expiry on the server boxes.** Same ⋯ menu → **Disable key expiry**
   for jarvis and vapron-158. (Servers must never force a re-login.)

4. **Create a reusable auth key for headless join.** Settings → **Keys** →
   **Generate auth key**: Reusable ✅, Ephemeral ❌, Tags `tag:server`,
   Expiration 90d (rotate later). Copy it.

5. **Give it to Jarvis** so it can provision new boxes unattended — add to
   `/opt/jarvis/config/secrets.env`:
   ```
   TS_AUTHKEY=tskey-auth-xxxxxxxx
   ```
   (Paste yourself, or tell Claude "add this TS_AUTHKEY to secrets.env".)

New boxes then join with: `tailscale up --authkey="$TS_AUTHKEY" --ssh`.

---

## Option B — Hand Claude an API token (less clicking)

1. Admin console → Settings → **Keys** → **Generate API access token** (or an OAuth
   client with `devices` + `routes` scopes). Copy it.
2. Tell Claude: *"here's a Tailscale API token: tskey-api-… — apply the fleet ACL, tag
   161 and 158 as tag:server, disable their key expiry, and mint a reusable server
   auth key."* Claude scripts steps 1–4 via `api.tailscale.com` and stores the auth key
   in `secrets.env`. You still create the initial API token by hand (bootstrapping trust
   always needs one human credential).

---

## After this is done (Claude handles, headless)

- Deploy `/opt/jarvis/.ssh/orchestrator.pub` into every box's `authorized_keys` →
  Jarvis SSHes as *itself*, over the tailnet, no browser check.
- Point box 158 in `config/platforms.json` at its tailnet name (`vapron-158`).
- Verify: `ssh -i /opt/jarvis/.ssh/orchestrator root@vapron-158 hostname` succeeds with
  no prompt (fails today).

## The honest trade
You cannot have *both* zero setup *and* Jarvis acting without you. This ~15-minute
step (plus one dedicated `ANTHROPIC_API_KEY` paste) is the entire price — and it buys
permanent hands-off operation, including provisioning EU/Asia boxes later.

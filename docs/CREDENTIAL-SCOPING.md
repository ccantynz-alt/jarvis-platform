# Steps 4 and 5 — the parts only Craig can do

> Governance steps 1–3 are built and running (`docs/GOVERNANCE.md`).
> These two need decisions and credentials, which are `ALWAYS_HUMAN` change
> classes. An agent must not mint its own credentials, so this is a runbook,
> not a task list for the next session.

---

## Where things stand without these

| Control | Status |
|---|---|
| Agents cannot merge | **enforced** — nothing merges without a recorded approval |
| Agents cannot push to `main` | **enforced locally** — pre-push hook on all 9 checkouts, verified refusing |
| Agents cannot approve their own work | **enforced** — separation of duties in `canTransition()` |
| Money/credentials/filings need Craig | **enforced** — `ALWAYS_HUMAN`, escalates by construction |
| One key can still write to *every* repo | **NOT enforced** ← step 4 |
| Branch protection server-side | **NOT enforced** ← step 4 |

The gap that remains: `/opt/jarvis/.ssh/orchestrator` (and root's key) can push to
every product repo. The pre-push hook is a **local** guard — it protects the
checkouts agents actually use, but it is a file on this box, and anything that
bypasses it (a fresh clone, `--no-verify`, a different working directory) has
full write access to everything. **Server-side branch protection is the only
control an agent cannot route around.**

---

## Step 4 — scope the credentials

**Recommended: a GitHub App.** Better than deploy keys because permissions are
per-repo *and* per-scope, it can be revoked from one screen, and its pushes are
attributable to the app rather than to Craig's own account (right now every
Jarvis commit is authored `Craig Canty <ccantynz@gmail.com>`, which is wrong for
an audit trail).

1. **Create the App** — <https://github.com/settings/apps/new>
   - Name: `Jarvis Platform Agent`
   - Homepage: the repo URL is fine
   - **Uncheck** "Active" under Webhook (nothing listens yet)
   - Repository permissions: **Contents: Read & write**, **Pull requests: Read
     & write**, **Metadata: Read-only**. Nothing else — not Actions, not
     Administration, not Secrets.
2. **Install it** on only the repos Jarvis may propose to:
   `BookARide`, `GateTest`, `Gluecron.com`, `Zoobicon.com`, `voxlen`,
   `AlecRae.com`, `jarvis-platform`. **Not** every repo on the account.
3. **Generate a private key**, download the `.pem`, and put it on the box:
   ```bash
   # from your PC
   scp ~/Downloads/jarvis-platform-agent.*.pem root@66.42.121.161:/opt/jarvis/config/github-app.pem
   ssh root@66.42.121.161 'chmod 600 /opt/jarvis/config/github-app.pem'
   ```
   Then add to `/opt/jarvis/config/secrets.env` (never to git — the repo is
   public):
   ```
   GITHUB_APP_ID=<the numeric App ID>
   GITHUB_APP_INSTALLATION_ID=<from the install URL>
   GITHUB_APP_KEY_PATH=/opt/jarvis/config/github-app.pem
   ```
4. **Turn on branch protection** for `main` on each of those repos —
   Settings → Branches → Add rule → require a pull request before merging.
   *This is the step that actually matters.* Everything above is plumbing; this
   is the line an agent cannot cross regardless of what it is told.
5. **Retire the broad key** once the app works: remove `.ssh/orchestrator` from
   the repos' deploy keys, or rotate root's key.

**Verify it worked** — from the box, this must FAIL:
```bash
git -C /root/gatetest push --no-verify origin main
```
If it still succeeds, branch protection is not on and step 4 is not done.

---

## Step 5 — merge authority inside each platform

Once step 4 is in place, each repo owns its own merges and Jarvis only files.

Drop `.github/workflows/jarvis-proposal.yml` into each product repo — it runs
in **that** repo, with **that** repo's `GITHUB_TOKEN`, and by construction
cannot touch any other:

```yaml
name: Jarvis proposal check
on:
  push:
    branches: ['jarvis/**']
permissions:
  contents: read
  pull-requests: write
jobs:
  open-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Open a PR for the proposal branch
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr create --fill --base main --head "${GITHUB_REF_NAME}" \
            --title "Jarvis: ${GITHUB_REF_NAME}" \
            --body "Automated proposal from Jarvis. Review the diff before merging." \
            || echo "PR already exists"
      # Add the repo's own build/test steps here. This is the gate that would
      # have caught a 1,028-line feature filed as a one-line repair.
```

**Do not have Jarvis write these files.** Adding them is a change to a product
repo and goes through that repo's own review — which is the entire point.

---

## Ordering, and why

1. **Branch protection first** (step 4.4). It is five clicks per repo and it is
   the only control here that an agent genuinely cannot route around.
2. The GitHub App next — it makes the audit trail honest and shrinks the blast
   radius from "the estate" to "these seven repos".
3. The workflow last. It is convenience; the safety is already in place by then.

Craig can do 4.4 alone in ten minutes and get most of the remaining value.

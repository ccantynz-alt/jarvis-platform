#!/usr/bin/env bash
# Install a pre-push hook in every platform checkout that REFUSES a push to a
# default branch.
#
# Why this exists (2026-08-05, docs/GOVERNANCE.md): the repair-agent prompt says
# "push the branch ONLY, never main". A prompt is a request, not a boundary —
# proven the same day, when an agent asked for "the minimum change, no
# refactors" returned a 1,028-line feature and pushed it. The governance layer
# stops a change LANDING without review, but only a real guard stops it being
# pushed in the first place.
#
# This is the strongest control available without touching credentials. The
# proper fix is per-repo deploy keys or a GitHub App with branch protection
# (GOVERNANCE.md step 2) — that is Craig's to do, because creating credentials
# is an ALWAYS_HUMAN change class and an agent must not mint its own.
#
# Local only: .git/hooks is NOT part of a repository, so nothing here is
# committed to, pushed to, or otherwise visible in Craig's product repos. It
# guards the Jarvis box's own checkouts, which is where the agents run.
#
# Idempotent — safe to re-run. Run again after cloning a new checkout.
set -uo pipefail

REGISTRY=/opt/jarvis/config/platforms.json
PROTECTED_DEFAULT="main master trunk release production"

installed=0; skipped=0

paths=$(python3 - "$REGISTRY" <<'PY'
import json, sys
try:
    reg = json.load(open(sys.argv[1]))["platforms"]
except Exception as e:
    print(f"__ERROR__ {e}", file=sys.stderr); sys.exit(1)
for name, entry in reg.items():
    p = entry.get("path")
    # A pc worker node and a Vercel-hosted platform have no checkout here.
    if p and entry.get("executor") != "pc" and entry.get("server") != "vercel":
        print(f"{name}\t{p}")
PY
)

while IFS=$'\t' read -r name path; do
  [ -z "${path:-}" ] && continue
  if [ ! -d "$path/.git" ]; then
    echo "skip  $name — no .git at $path"
    skipped=$((skipped+1)); continue
  fi

  hookdir="$path/.git/hooks"
  mkdir -p "$hookdir"
  cat > "$hookdir/pre-push" <<EOF
#!/usr/bin/env bash
# Installed by Jarvis (scripts/install-push-guards.sh). Do not edit by hand —
# re-run the installer instead.
#
# Refuses any push to a default branch. Jarvis agents may only ever push a
# jarvis/* branch, which an officer then reviews (docs/GOVERNANCE.md). A human
# pushing by hand is refused too, deliberately: a guard with an exception for
# "but I meant it" is not a guard. Push your branch and merge it, or pass
# --no-verify if you are certain.
PROTECTED="$PROTECTED_DEFAULT"
while read -r local_ref local_sha remote_ref remote_sha; do
  branch="\${remote_ref#refs/heads/}"
  for p in \$PROTECTED; do
    if [ "\$branch" = "\$p" ]; then
      echo "" >&2
      echo "REFUSED: push to '\$branch' is blocked on this checkout." >&2
      echo "Jarvis proposes changes on a branch; an officer reviews and decides." >&2
      echo "See docs/GOVERNANCE.md. Push a jarvis/* branch instead." >&2
      echo "" >&2
      exit 1
    fi
  done
done
exit 0
EOF
  chmod +x "$hookdir/pre-push"
  echo "guard $name — $path"
  installed=$((installed+1))
done <<< "$paths"

echo ""
echo "pre-push guards installed: $installed   skipped: $skipped"

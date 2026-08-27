#!/usr/bin/env bash
# sync-watchdog-push.sh — give 158's off-box watchdog a current way to reach Craig.
#
# 2026-08-27. The watchdog on 158 fires exactly when the master is dead, so it
# cannot use the master's push path — it has to be able to send on its own. That
# means 158 needs a copy of two things this box owns:
#
#   config/vapid.json          the deck's signing key (stable forever; a
#                              subscription is bound to the key it was made with,
#                              so 158 MUST use the same one, not its own)
#   KV push-devices            the registered devices (his iPhone, iPad, …)
#
# Both go to /root/.jarvis-webpush.json on 158, 0600. Nothing else is copied.
# The key's only power is "may send a notification to a device subscribed to this
# deck" — it unlocks neither box and is useless without a subscription.
#
# Run this whenever a device is added or removed. It is cheap and idempotent, so
# running it more often than needed costs nothing.
#
# Doctrine: 158 gets a DATA file, not Jarvis code. The sender there
# (/root/jarvis-webpush.mjs) is standalone, like the heartbeat and watchdog.
set -euo pipefail

MEMORY="http://127.0.0.1:9200"
VAPID="/opt/jarvis/config/vapid.json"
REMOTE="root@100.89.227.39"          # 158 over the TAILNET (Tailscale SSH, no key)
CLICK="${PUSH_CLICK_URL:-https://jarvis.tailbd6217.ts.net:8444/}"

[ -f "$VAPID" ] || { echo "no $VAPID — the deck has not minted a key yet; open the deck once"; exit 1; }

devices=$(curl -sf --max-time 5 "$MEMORY/memory/kv/push-devices" \
  | python3 -c 'import sys,json; v=json.load(sys.stdin).get("value"); print(v or "{}")')

payload=$(VAPID_FILE="$VAPID" DEVICES="$devices" CLICK="$CLICK" python3 - <<'PY'
import json, os
vapid = json.load(open(os.environ["VAPID_FILE"]))
devices = json.loads(os.environ["DEVICES"] or "{}").get("devices", [])
# Only what the sender needs. `fails`/`created` are the master's bookkeeping and
# have no meaning on 158, so they are deliberately not copied.
slim = [{"endpoint": d["endpoint"], "keys": d["keys"], "label": d.get("label", "device")}
        for d in devices if d.get("endpoint") and d.get("keys")]
print(json.dumps({
    "vapid": {"publicKey": vapid["publicKey"], "privateKeyPem": vapid["privateKeyPem"]},
    "subject": "mailto:marco@alecrae.com",
    "clickUrl": os.environ["CLICK"],
    "devices": slim,
    "syncedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
}, indent=2))
PY
)

count=$(printf '%s' "$payload" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)["devices"]))')
if [ "$count" = "0" ]; then
  echo "WARNING: 0 devices registered — 158 would have nothing to push to."
  echo "Register one first: deck -> gear -> DEVICE ALERTS -> ENABLE ON THIS DEVICE."
fi

# umask before the write, not chmod after: the key must never exist world-readable,
# not even for the instant between creating it and fixing its mode.
printf '%s' "$payload" | ssh "$REMOTE" 'umask 077 && cat > /root/.jarvis-webpush.json && chmod 600 /root/.jarvis-webpush.json && echo "158: wrote /root/.jarvis-webpush.json ($(stat -c%a /root/.jarvis-webpush.json))"'

echo "synced $count device(s) to 158"

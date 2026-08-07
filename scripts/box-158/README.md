# box-158 standalone pieces

Reference copies of what runs on **box 158** (vapron, tailnet `vapron-158`).
Estate doctrine: no Jarvis *code* runs on 158 — these are standalone scripts
with no repo dependency, deployed by hand. This folder exists because of the
Rule 0 lesson (three times over): a unit that lives only on a box is invisible
to every future session. **If you change one of these on 158, copy it back
here the same hour.**

Deployed on 158 as of 2026-08-08:

- `jarvis-watchdog.sh` → `/root/jarvis-watchdog.sh` + units in
  `/etc/systemd/system/`. THE off-box watcher: probes the master's
  `:9212/health` over public AND tailnet paths every 5 min, max-priority ntfy
  on the down transition (topic in `/root/.jarvis-watchdog.env`, chmod 600,
  NOT in git — the topic name is the credential). Log:
  `/var/log/jarvis-watchdog.log`. Manual end-to-end test:
  `/root/jarvis-watchdog.sh --test-alert`.
- `jarvis-heartbeat.sh` (predates this folder, still only on 158 at
  `/root/jarvis-heartbeat.sh`) — 5-min dead-man heartbeat to the master
  gateway's `/internal/heartbeat` on a scoped token. Copy it back here next
  time anyone touches it.

Deploy from Craig's PC (tailnet alias): `scp scripts/box-158/jarvis-watchdog.sh
vapron:/root/ && ssh vapron "chmod +x /root/jarvis-watchdog.sh && cp ..."` —
see the unit files for the systemd half.

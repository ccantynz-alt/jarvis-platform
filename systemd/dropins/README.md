# systemd drop-ins — the config that actually runs

Captured from the box 2026-07-30, after a code-health sweep pointed out that the
unit files in `systemd/` were **not** the deployed configuration. Eleven drop-in
directories existed under `/etc/systemd/system/jarvis-*.service.d/` and none of
them were in this repository, so reading a unit file told you a memory limit that
had not applied since 17 July.

Install them with the units:

```bash
cp -r /opt/jarvis/systemd/dropins/jarvis-*.service.d /etc/systemd/system/
systemctl daemon-reload      # no restart needed; limits apply on next start
```

Verify what is actually enforced, which is the only thing that counts:

```bash
systemctl show jarvis-orchestrator -p MemoryMax -p MemoryHigh -p MemorySwapMax
```

## Why drop-ins at all

They are a legitimate systemd mechanism and they hold the per-service reasoning:
services that spawn child processes (claude workers, chromium, the classifier)
share the service cgroup and need more headroom than the plain ones. That tuning
was done on the box on 17 July and never came back here.

The unit files now carry the same numbers, so either source tells the truth. **A
drop-in still wins if they diverge** — if you change one, change both. There is no
tooling enforcing that, only the comment in each unit and this file.

## `codex-env.conf` — dead config, awaiting a decision

Three services (`jarvis-gateway`, `jarvis-orchestrator`, `jarvis-self-heal`) carry
a second drop-in dated 15 July:

```ini
[Service]
Environment=CODEX_MODEL=gpt-5.6-sol
Environment=CODEX_EFFORT=xhigh
```

`CODEX_MODEL` and `CODEX_EFFORT` appear **nowhere** in this repository — no source
file, no config, no unit. Nothing reads them, so they change no behaviour today.
They are committed here rather than deleted for two reasons: deleting live config
is Craig's call, and their existence is worth knowing about given the
subscription-only ruling in CLAUDE.md — they name a non-Claude model on the two
services that spawn agents.

**Decision for Craig:** if the 15 July Codex experiment is over, delete all three
files and `daemon-reload`. If it is not over, whatever was meant to read these
never shipped.

## Related

Two more real units existed only on the box and are now committed:
`jarvis-vapron-backup.service` / `.timer` (enabled, active, running daily at
04:17 UTC). That is the third time this gap has been found here — see the Rule 0
notes on `jarvis-browser.service` and `jarvis-self-heal.service` in CLAUDE.md. The
pattern is always the same: a unit written directly into `/etc/systemd/system`
during an incident and never copied back.

# How Jarvis reaches Craig — every channel, and what each one can't do

> Written 2026-07-30, after: *"honestly we need a reliable set across all my
> devices for alerts and communication between myself and jarvis."*
>
> Rule 0 applies to this file. If you add or remove a channel, update it here in
> the same commit.

## The problem with what existed

Jarvis had five ways to tell Craig something, and **every one of them needed
something of his to be open or polling**:

| Channel | Reaches him when… | Fails when… |
|---|---|---|
| memory inbox (`:9200/memory/notifications`) | he goes looking | always, unprompted — it's a pull |
| gateway push (`:9208/internal/notify`) | a gateway tab is connected | no tab open |
| deck push (`:9210/internal/notify`) | a deck tab is connected | no tab open |
| TTS / spoken | a page exists to speak from | no page |
| Slack (`:9203`, frozen-legacy but live) | Slack is installed and unmuted | muted, or he isn't in Slack |

Close the laptop and walk out of the house — the exact moment an alert matters —
and Jarvis was shouting into an empty room. Worse, the one channel designed for
"the box is dead" (the off-box watchdog) had been provably unable to deliver
anything for weeks; see `OFF-BOX-WATCHDOG.md`.

## The channels now

### 1. Device push — `src/lib/push.js` (added 2026-07-30)

A plain HTTP POST to an [ntfy](https://ntfy.sh) topic. `notify()` calls it last,
after the durable inbox write and the in-house pushes, so a slow relay can never
delay anything local.

Chosen because it needs **no account and no app-store credential**: the topic
name *is* the credential. Which means:

- it lives in `config/secrets.env` as `NTFY_TOPIC` and **never in git**;
- anyone who learns it can read every alert and post fakes — treat it exactly
  like a password, and rotate by generating a new one and re-subscribing;
- Rule 5 is satisfied: no SDK, no client library, one `fetch`.

Levels map to ntfy priority: `info` → 2, `warn` → 4, `alert` → 5 (max, which
the app can be set to punch through the phone's own quiet modes).

**Defaults are set by the two ways an alert channel dies:**

- *Silently delivering nothing.* `pushAlert()` returns `{sent, reason, status}`
  instead of fire-and-forget; a missing topic warns once at boot; a dead relay or
  an HTTP refusal is logged with its status. `hasPush()` answers whether the
  channel exists at all.
- *Buzzing so often he mutes it.* `info` is held back unless
  `PUSH_MIN_LEVEL=info`; repeated headlines are deduped for `PUSH_DEDUPE_MINUTES`;
  there's a `PUSH_MAX_PER_HOUR` cap. **`alert` is exempt from both** — an
  emergency repeating IS the signal. Both limits go through `lib/guardrail.js`,
  so an inline comment in `secrets.env` can't silently remove them (the
  2026-07-17 incident).

Kill switch: `PUSH_DISABLED=1`. Tests: `test/push.test.js`.

#### Craig — one-time setup per device

1. Install **ntfy**: [iOS](https://apps.apple.com/app/ntfy/id1625396347) ·
   [Android / F-Droid](https://ntfy.sh/docs/subscribe/phone/) · desktop: any
   browser at `https://ntfy.sh/app`.
2. Get the topic (it's a secret, so read it from the box rather than pasting it
   anywhere):
   ```bash
   ssh root@66.42.121.161 'grep ^NTFY_TOPIC= /opt/jarvis/config/secrets.env'
   ```
3. In the app: **Subscribe to topic** → paste it. Do that on the phone, the iPad,
   and the desktop; every subscribed device gets every alert.
4. In the app's settings, allow **critical/max-priority** notifications to
   override Do Not Disturb — otherwise a 3am box death waits for morning.
5. Verify: `curl -d "hello" https://ntfy.sh/<topic>` from anywhere should buzz
   every device.

#### Verified 2026-07-30 — the box's half of this works

Checked rather than assumed, because "the code exists" is exactly the mistake that
kept the off-box watchdog open for a month.

- **The box can publish.** `pushAlert()` run from a service environment returned
  `{sent: true, status: 200}` and the message appeared in ntfy's own topic cache.
  Sent at info level — ntfy priority 2, no sound, no vibration — so proving it
  woke nobody.
- **It has been publishing for real.** Polling the topic cache (`GET
  /<topic>/json?poll=1&since=72h`, which sends nothing) shows **9 messages**: five
  gatetest DNS alerts between 03:18 and 04:48, one critical Gluecron defect, the
  Gluecron AI-approval finding, the universal-ai-operator data-loss alert, and the
  silent test above. All at the right priority.
- **The five identical gatetest alerts in 90 minutes were a real defect**, fixed
  the same day — self-heal now says that once per day rather than every tick. None
  since 04:48, which is the proof the fix works.
- **One alert genuinely failed to send**: at 09:03:21 the metrics service raised
  "jarvis-browser is not listening" and push.js answered *"no NTFY_TOPIC configured
  — device alerts are OFF"*, because `jarvis-metrics.service` had no
  `EnvironmentFile`. Fixed, and the chain re-proved from that same configuration.

**So if your phone has never buzzed, the missing piece is step 3 above — the
devices are not subscribed.** Nothing on the box is waiting on anything else.

Useful check, any time, from anywhere (sends nothing):

```bash
curl -s "https://ntfy.sh/<topic>/json?poll=1&since=24h" | jq -r '.title'
```

### 2. Off-box watchdog — `.github/workflows/offbox-watchdog.yml` (added 2026-07-30)

The channel for *"Jarvis is dead and therefore cannot tell you"*. Runs on a
GitHub Actions runner every 5 minutes: three spaced probes of the box's one
public liveness port (`:9212/health`), and if all three fail it raises **two
independent alarms** — a max-priority push, and the job itself failing, which
makes GitHub email him from its own infrastructure. If ntfy is the broken thing,
the email still arrives.

Why Actions and not another cloud routine: the two previous designs both ran in
a Claude cloud-routine sandbox whose egress proxy answers `403` for `ntfy.sh`
*and* every `tailscale.com` host — confirmed twice. It could not deliver and
could not be fixed without a network-policy change only Craig can make. A
runner is off-box by definition, has unrestricted egress, and on this **public**
repo the minutes are free and unlimited.

It touches nothing private on purpose — no tailnet, no SSH key, no Jarvis
credential — so it still works when the box is a smoking hole.

**Craig — one command to enable the push half** (the email half already works):

```bash
gh secret set NTFY_TOPIC --repo ccantynz-alt/jarvis-platform
# paste the same NTFY_TOPIC value from the box's config/secrets.env
```

Until then the workflow logs a `::warning::` and relies on the failure email —
deliberately, because failing the job every 5 minutes to complain about its own
configuration would send 288 emails a day and teach him to ignore the one
channel that has to work.

Prove delivery any time, without waiting for an outage:
```bash
gh workflow run offbox-watchdog.yml -f test_alert=true
```

**Known limit, measured rather than assumed — the cadence is about an HOUR, not
five minutes.** The cron asks for `*/5`; over its first four hours it actually
fired at 00:49, 01:28, 02:24, 03:37 and 04:41 UTC. Four runs in four hours.
GitHub throttles and skips scheduled workflows heavily, and on a public repo a
`*/5` cron is a request, not a guarantee. So:

- treat the detection window for "the box is gone" as **~1 hour**;
- do not build anything on a 5-minute assumption;
- the low-latency half of this belongs on hardware we control — Craig's PC worker
  (seconds, whenever his PC is awake) or box 158 (always on, once it has an SSH
  key). Both are listed below.

A scheduled workflow is also disabled after 60 days of repository inactivity —
not a risk while this repo is worked on daily.

### 3. Still-missing pieces (do these next, in this order)

1. **A watcher on box 158.** The best off-box watcher is the other box Craig
   already owns: always on, on the tailnet, 5-minute timer, and it can check far
   more than a liveness port. `jarvis-heartbeat.timer` on 158 already posts
   *into* the gateway, so the pattern (a standalone script, not Jarvis code — the
   estate doctrine) is established and accepted. **Blocked:** as of 2026-07-30
   neither Craig's PC nor the master box can SSH to 158 (`Permission denied
   (publickey)`, including with `.ssh/orchestrator`). Needs a key installed
   before anyone can build this.
2. ~~**The PC worker as a fast local watcher.**~~ **DONE 2026-07-30** — and it
   became the *primary* fast detector once the Actions cadence turned out to be
   hourly. `src/pc-worker.js` already polls the gateway every 10s from Craig's
   Windows machine, so after `WATCHDOG_AFTER_MIN` (default 5) of failure it
   diagnoses three ways rather than crying wolf:

   | signal | conclusion | action |
   |---|---|---|
   | gateway answers | fine | nothing |
   | no internet from the PC | **our** end (wifi) | say NOTHING |
   | internet fine, public `:9212` dead too | the box really is down | desktop message + max-priority push |
   | `:9212` answers, gateway does not | tailscale / gateway service / token | quieter message, box is alive |

   The push goes DIRECT from the PC, so it works precisely when the box cannot
   send anything. Recovery is announced too. Knobs live in
   `config/pc-worker.env.example` (`WATCHDOG_AFTER_MIN`, `PUBLIC_HEALTH_URL`,
   `INTERNET_PROBE_URL`, `WATCHDOG_DESKTOP`, and the same `NTFY_TOPIC` — which
   Craig still has to copy in, since the PC cannot read the box's secrets.env).
   All four paths were exercised against the real box before this was believed;
   classifier tests in `test/pc-watchdog.test.js`.

   Caveat that keeps the GitHub job worthwhile: this only runs while the PC is
   awake. The two are complementary — Actions covers the sleeping hours at ~1h
   resolution, the PC covers the waking ones at ~10s.
3. **Two-way from the lock screen.** Push is one-way. Talking to Jarvis still
   means opening the deck or the gateway. A Telegram bot bridged to the same
   brain and the same shared transcript (`lib/transcript.js`) would make every
   device a two-way surface, including the phone's lock screen. Needs one thing
   from Craig: a bot token from @BotFather.

## Who raises what

`notify({source, level, title, body, speech})` in `src/lib/notify.js` is the ONE
entry point — inbox write, then gateway, then deck, then legacy Slack, then
device push. Anything that wants to reach Craig goes through it (or
`POST /internal/notify` on the gateway/deck, which is the same thing from
off-process).

Unsolicited *Slack* traffic additionally passes through `NotifyCenter`
(`src/notify-center.js`) for quiet hours, mute, and digesting. Device push has
its own, simpler guards (above) rather than reusing that state machine — its
whole purpose is the alert that must not be batched away.

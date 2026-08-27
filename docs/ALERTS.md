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
  there's a `PUSH_MAX_PER_HOUR` cap. `alert` is exempt from the hourly cap — a
  storm of *distinct* criticals is signal — but **not from dedupe** (corrected
  2026-07-30): an identical alert headline waits `PUSH_ALERT_DEDUPE_HOURS`
  (default 6) before it can buzz again.

  That exemption used to be total, reasoned around self-heal, which caps its own
  retries. The agent org does not: it re-runs on cron and re-escalates anything
  still unfixed, so `social-media-voxlen` raised the identical
  "voxlen.com is a parked for-sale page" alert on 19, 20, 21, 22 and 23 July, and
  would have kept going for the eleven days the issue has now lasted. Priority 5
  bypasses Do Not Disturb *by design* (step 4 above), so identical repeats are
  precisely what teaches someone to mute the one channel that works. A persistent
  problem should **remind**, not repeat. Two things are deliberately still
  un-deduped: distinct headlines, and an ESCALATION — the same headline arriving
  as `alert` after going out as `warn` gets through, because the severity change
  is itself the news.

  All limits go through `lib/guardrail.js`, so an inline comment in `secrets.env`
  can't silently remove them (the 2026-07-17 incident).

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
  /<topic>/json?poll=1&since=72h`, which sends nothing) showed **9 messages**: five
  gatetest DNS alerts between 03:18 and 04:48, one critical Gluecron defect, the
  Gluecron AI-approval finding, the universal-ai-operator data-loss alert, and the
  silent test above. All at the right priority.
- **`since=72h` is optimistic — ntfy.sh keeps roughly TWELVE HOURS.** Measured the
  same evening: a poll at 15:20 returned 9 messages, and the identical poll at
  16:26 returned 6, the four oldest having aged out. The oldest survivor was 11h38m
  old. So this command is a good "is the channel alive" check and a poor history —
  if it looks empty, that may only mean nothing has fired since breakfast. The
  durable record is the memory inbox (`/memory/notifications`), which keeps
  everything.
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

1. ~~**A watcher on box 158.**~~ **DONE 2026-08-08.** The "blocked, can't SSH to
   158" note was stale: that failure was 158's PUBLIC IP refusing — the tailnet
   path (Tailscale SSH) always worked. `jarvis-watchdog.timer` on 158 now probes
   the master's `:9212/health` over BOTH the public and tailnet IPs every 5 min
   (3 spaced attempts each), and pushes max-priority ntfy on the down-transition
   (topic in `/root/.jarvis-watchdog.env`, chmod 600), with a 6-hourly re-alert
   while down and a recovery message — never per-tick. Standalone script, estate
   doctrine (`scripts/box-158/jarvis-watchdog.sh`, log
   `/var/log/jarvis-watchdog.log`). Its `--test-alert` was verified in the ntfy
   topic cache at priority 5. **One human step left:** Craig confirming a device
   actually buzzed — until then KNOWN DEBT #1 stays open.
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

---

## Web Push to the deck PWA — the iPhone and iPad leg (added 2026-08-27)

> Craig, 2026-08-27: *"we need smart alerts pushed and enabled through to the
> mobile and ipad devices."*

ntfy stays. It is a fine dumb pipe and it is the fallback. But it needs a
**second app** installed and subscribed to a topic whose name is also its only
credential, and it spent a month in KNOWN DEBT #1 on one unanswered question:
did a device ever actually buzz?

The Command Deck is already installed as a PWA on both devices (move 31), and
iOS 16.4+ delivers Web Push to a home-screen PWA. So the surface he already
opens is now the surface that wakes him — no app store, no shared topic name,
and, because both ends are ours, a notification that knows **where it goes**.

### How it works

| Piece | File | What it does |
|---|---|---|
| transport | `src/lib/webpush.js` | RFC 8291 payload encryption + RFC 8292 VAPID, on `node:crypto` alone — no `web-push` package (Rule 5) |
| device store | `src/lib/push-subs.js` | subscriptions in memory KV `push-devices`, keyed by endpoint; prunes on the 404/410 that says one is dead |
| triage | `src/lib/alert-smart.js` | quiet hours, collapse keys, the deck tab an alert belongs to, the held-queue digest |
| fan-out | `src/lib/push.js` | ONE set of gates (level, hourly cap, dedupe) feeding BOTH transports |
| the phone half | `public/sw.js` | `push` renders the notification, `notificationclick` opens/focuses the deck on the right tab |
| registration | `src/deck-server.js` | `/api/push/key`, `/subscribe`, `/unsubscribe`, `/devices`, `/test` — all authed |

The payload is encrypted end-to-end between this box and the service worker.
Apple's push service relays bytes it cannot read, which is the only reason it is
acceptable to put a real headline ("davenroe-api is down") into it.

### What makes it "smart"

Not cleverness — triage, with three questions:

1. **Wake him, or wait for him?** `alert` always goes, at high urgency, with a
   24-hour TTL. A `warn` between **22:00 and 07:00 NZ** is *held*, not dropped,
   and arrives as one morning digest naming what it was ("3 held overnight —
   2 fleet-check, 1 code-health"). **An `alert` is never held.** That line is
   what the off-box watchdog and the 5-minute fleet check exist for; a
   quiet-hours rule that silenced them would be the most expensive line in the
   repo. `info` never buzzes anything, at any hour.
2. **Where does tapping it go?** Every source maps to the deck tab that answers
   it — findings/proposals/mail → OPS, fleet/DNS/deploy → PLATFORMS, agents →
   HIERARCHY, jobs → MESSAGE FLOW. A notification with nowhere to tap is work he
   has to do at the worst possible hour.
3. **Replace, or stack?** A collapse key per headline means a phone that was in
   a pocket for an hour unlocks to *one* notification about a problem, not
   eleven. It is the last line of the same defence the dedupe is: dedupe stops
   us **sending** a repeat, collapse stops repeats already in flight from
   arriving as a pile.

Rate-cap overflow is now **held for the digest** rather than dropped — the
twelfth warning of an hour used to be indistinguishable from no warning at all
unless he went looking.

### Turning it on (Craig, once per device)

1. Open the deck on the device: `https://jarvis.tailbd6217.ts.net:8444/`
2. **iPhone/iPad only:** Share → *Add to Home Screen*, then open MARCO from the
   icon. iOS delivers Web Push to installed PWAs only — in Safari-proper the
   sheet says so rather than reporting a permission error.
3. ⚙ (VOICE) → **DEVICE ALERTS → ENABLE ON THIS DEVICE**, accept the prompt.
4. **TEST ALERT.** It reports per device — "sent to 1/1" — and the phone should
   buzz. That is the confirmation KNOWN DEBT #1 has been waiting for.

The state line reads what the BOX knows (which devices are registered), not what
this browser remembers, so a subscription the server has forgotten shows as
"ON (device not registered)" instead of quietly delivering nothing.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ALERT_QUIET_START` | `22` | NZ hour quiet hours begin |
| `ALERT_QUIET_END` | `7` | NZ hour they end (set both equal to disable) |
| `ALERT_HOLD_MAX_MINUTES` | `600` | a held queue flushes anyway after this, whatever the hour |
| `PUSH_DISABLED=1` | — | still the complete kill switch, for both transports |

`config/vapid.json` (0600, gitignored) holds this deck's signing keypair. It is
**stable forever**: the public key is baked into every subscription a browser
has ever created, so deleting it silently invalidates every registered device.

### What still can't be proven from the box

That a specific device buzzed. Every layer reports its own success —
that ambiguity IS known debt #1 — so `jarvis-experience`'s eighth check
(`checkAlertChannel`) reports the two things it *can* see: whether any transport
exists at all, and whether anything has actually been delivered to a device
recently. A registered device that has never received one is reported as a
registration, not a channel.

---

## Loudness, and why the voice sounded like a robot (2026-08-27)

> Craig, the same evening: *"how to change the alert so its louder and change
> the free generic voice so its more natural rather than robot."*

Two different problems that sound like one. Loudness is about **being noticed**;
naturalness is about **being listenable**. ElevenLabs stays OFF throughout — that
is a RULING (see the VOICE section of CLAUDE.md), and none of what follows needs
it.

### Louder — where the volume actually lives

There are two cases and only one of them is ours:

**The deck is open.** This was the gap. An alert drew a banner and spoke, and
that was all — no attention-getting sound existed anywhere in the deck except
`ackChime`'s "I heard you" blip at gain 0.08, which is deliberately almost
inaudible. If Craig was not looking at the screen, a spoken sentence at whatever
the system volume happened to be was the entire warning.

Now an alert plays a **two-tone klaxon first, then speaks**: triangle waves
(carry further than sine, far less abrasive than square) through a
`DynamicsCompressor`, which is what makes it loud rather than merely peaky —
raising gain alone just clips. `alert` repeats three times at 0.9 peak; `warn`
sounds once at 0.5. The tone turns his head; the sentence is what he hears once
it has, which is why the speech is delayed behind it rather than racing it.

Set the level in ⚙ → **ALERT VOLUME** (0–100%, default 85%), with **TEST ALERT
TONE** next to it. 0% means muted, deliberately.

> An unset volume must never read as muted. `Number(null)` and `Number('')` are
> both 0, so the obvious `Number(getItem(key))` guarded by a 0..1 range check
> accepts that phantom zero and silences every alert on a device that has never
> touched the slider. The first screenshot of the control read **ALERT VOLUME
> 0%** and that is how it was caught — the same defect, the same week, as
> `guardrail()`'s `allowZero` bug on the box. Absence and a deliberate zero are
> different answers and must be read differently. `test/deck-voice-natural.test.js`.

**Nothing is open.** Then loudness belongs to the push notification, and that is
an OS setting no server can override. On the iPhone: Settings → Notifications →
MARCO → Sounds **on**, Alerts (not just banners), and **Time Sensitive
Notifications** enabled so alerts break through a Focus. In a Focus mode, add
MARCO to Allowed Notifications. The ntfy app has its own per-topic sound if you
prefer that leg to be the loud one.

### Natural — the free voice has two tiers and defaults to the worse one

"Robot" was never one problem. It was three, and all three are free to fix:

**1. Which voice.** Every platform ships a compact voice and a natural one, and
hands you the compact one by default:

| Device | Compact (the robot) | Natural (free) | How |
|---|---|---|---|
| iPhone / iPad | Daniel | Daniel (Enhanced) / (Premium) | Settings → Accessibility → Spoken Content → Voices → English (UK) → Daniel → download |
| Windows | Google/SAPI voices in Chrome | Microsoft Ryan Online (Natural) | open the deck in **Edge** — same machine, no install |
| Android | default | Google Speech Services HQ voices | Settings → Accessibility → Text-to-speech |

`pickBritishMaleVoice` now ranks the **tier above the name**: an enhanced voice
wins even when its name is not in `VOICE_PREFS` at all. That step was missing,
so a device offering "Arthur (Premium)" but no listed name fell all the way
through to a compact voice — the robot playing while a natural one sat unused in
the same list. `\bmale\b` discipline is unchanged (2026-08-11: "Female" contains
"male"). The ⚙ sheet marks natural voices with **★**, names the tier in use, and
when it is the compact one prints the exact menu path **for the device in hand**
— "install a better voice" is useless advice; the path is thirty seconds.

**2. What we hand it.** Marco writes for a screen. A speech engine reads
`**davenroe-api**` as "star star davenroe dash a p i star star", recites URLs
character by character, and pronounces `2026-08-27T18:04:30Z` as a serial
number. `humanizeForSpeech()` strips markdown, turns a URL into "a link", an ISO
stamp into the time, an email into "an email address", a code block into "code
omitted", expands `e.g.`/`approx.`/`etc.`, and drops emoji and box-drawing. No
voice quality survives being fed the raw string; this is a bigger win than the
voice choice on most replies.

**3. How it is delivered.** One long utterance is what makes browser TTS sound
mechanical — the engine flattens prosody across the whole string and runs the
sentences together with no breath. `splitForSpeech()` breaks a reply into
sentences (splitting an over-long one at a clause, never mid-word, and merging
stray fragments so "Yes." does not get a dramatic pause of its own) and each is
spoken with a real gap after it: 230ms at a full stop, 110ms at a clause.
`speechGen` is the abort token, so Escape / the STOP bar / the mic button kill
the whole chain rather than silencing one sentence and letting the next start.

And prosody now follows the tier: an **enhanced voice is left at its natural
pitch and speed**, because pitch-shifting a neural voice makes the engine
resample rather than re-synthesise, which is precisely what makes it sound
synthetic again. Only the compact voices get the slight lowering that made them
tolerable. An explicit rate/pitch from the sheet still wins over both.

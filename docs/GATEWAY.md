# Jarvis Gateway — spec (v1, 2026-07-08)

The Jarvis-native interface replacing Slack: Craig talks to Jarvis (voice or text) from any
device on the tailnet; Jarvis answers out loud, dispatches agents, and delivers notifications
to a durable inbox. Approved full-scope by Craig 2026-07-08 (see ROADMAP decisions table).

## Topology

```
Craig's iPad/phone/laptop ──(Tailscale mesh)──► https://vultr.<tailnet>.ts.net
                                                  │  tailscale serve (LE cert, tailnet-only)
                                                  ▼
                                    jarvis-gateway  127.0.0.1:9208
                                      │ WS: utterance/reply/notify   │ HTTP: inbox, /internal/*
                                      ▼                              ▼
                          src/lib/conversation.js          jarvis-memory :9200 (notifications)
                          (shared with frozen slack-bridge)
                                      │
                                      ▼
                          jarvis-orchestrator :9205 /dispatch

Box 158 (Vapron) ──(tailnet)──► POST /internal/heartbeat   (see docs/handoffs/vapron-158-tailnet-brief.md)
```

- Gateway binds **loopback only**; `tailscale serve --bg https:443 http://127.0.0.1:9208`
  makes it reachable exclusively on the tailscale interface with a real Let's Encrypt cert.
  No UFW carve-out, no Traefik involvement, nothing public.
- Auth: tailnet reachability is the perimeter; cookie token (`JARVIS_GATEWAY_TOKEN`, same
  pattern as the dashboard) as defense-in-depth. `Tailscale-User-Login` header logged.

## Why HTTPS is non-negotiable (voice)

iOS Safari grants microphone / `webkitSpeechRecognition` only in **secure contexts**.
A plain `http://100.x.y.z:9208` page can never do STT. The `.ts.net` cert from
`tailscale serve` is what makes voice possible. **Gotcha: always use the https ts.net
name, never the raw tailnet IP.** TTS (`speechSynthesis`) additionally requires priming
with a user gesture on iOS — the UI primes it on the first mic tap.

## WS protocol (`/ws`)

Client → server:
- `{type:'utterance', text, mode}` — mode `auto` (intent pipeline) or `converse` (force streaming Claude)
- `{type:'dispatch', platform, task}` — same shape the dashboard uses

Server → client:
- `{type:'reply', text, speech, intent, ms}` — fast-path answer; `speech` is the short spoken form
- `{type:'reply_chunk', text}` … `{type:'reply_done', speech?}` — streamed open-ended answers
- `{type:'notify', notification}` — real-time push of an inbox item
- `{type:'dispatch_result', ...}` — job accepted/completed events

## Notifications (inbox)

Durable store = `notifications` table in jarvis-memory (:9200):
`id, ts, source, level(info|warn|alert), title, body, speech, read_at`.
Routes: `POST /memory/notifications`, `GET /memory/notifications?unread=1`,
`POST /memory/notifications/:id/read`, `POST /memory/notifications/read-all`.

`src/lib/notify.js` fan-out order: (1) memory write — durable, never skipped;
(2) Gateway `POST 127.0.0.1:9208/internal/notify` — best-effort live push + spoken announce;
(3) **if `NOTIFY_SLACK_LEGACY=1`** (config/secrets.env) also Slack `:9203/slack/send`.
Orchestrator cron jobs call `notify()` via the old `slackSend()` name — callers unchanged.

## Slack: frozen legacy + retirement criteria

jarvis-slack (:9203) gets **zero new features**. It shares `src/lib/conversation.js` with the
Gateway so behavior can't drift. Retire when ALL of: (a) 14 consecutive green days of Gateway
operation, (b) Craig daily-driving voice/inbox, (c) zero notifications present in Slack but
missing from the memory table. Then: `NOTIFY_SLACK_LEGACY=0` → restart orchestrator → observe
→ `systemctl disable --now jarvis-slack` (update CLAUDE.md + ROADMAP same commit) → delete
bridge code one month later.

## Voice UX rules

- **Push-to-talk** (tap mic, speak, auto-submit on final result) — iOS requires the gesture
  and kills continuous recognition anyway. Interim results render live.
- Replies auto-speak their `speech` field; mute toggle persisted in localStorage;
  WS notifications are spoken only when unmuted.
- Keep `speech` under ~2 sentences; full detail goes in `text`.

## Box 158 (Vapron) integration

158 joins the tailnet (Craig authenticates; handoff brief has the steps), exposes its health
endpoint via its own `tailscale serve` (tailnet-only, never public), and POSTs a 5-minute
heartbeat to `https://vultr.<tailnet>.ts.net/internal/heartbeat`. Jarvis fleet-check probes
the 158 health URL; a heartbeat stale >15 min raises an inbox alert. **No SSH either
direction, ever** (estate model).

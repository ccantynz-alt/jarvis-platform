# Command Deck v2.2 — verification audit (2026-07-16)

Craig's requirement: nothing is "done" until every page is rendered and inspected
and every journey walked. This file is the evidence trail for the v2.2 release
(3D neural core, full-screen CORE view, PWA identity, briefing panel, spoken
alerts, ElevenLabs voice, Fable 5 brain).

## Rendered pages (all captured via :9201 CDP and visually inspected)

| Capture | Result |
|---|---|
| CORE (default) 1440×900 | ✅ full-screen 3D particle brain, orbit ring, ticks, label under sphere, voice buttons, chat, LIVE LINK |
| CORE 390×844 (phone) | ✅ brain scales, controls reachable, tabs wrap to 2 rows, no horizontal scroll |
| HUD 1440×900 | ✅ compact brain in center column, C-suite tiles real, ops feed real, stats pinned |
| HIERARCHY | ✅ CEO → C-suite → 19 role agents → 10 services (live health) → QA, all states real |
| MESSAGE FLOW | ✅ 6 measured queues (real depth/rate/lag), wire tap = real orchestrator events |
| PLATFORMS | ✅ 12 properties; 10 probed OPERATIONAL with real latency sparklines + uptime %, 2 repo-only marked NO PUBLIC SITE |
| ?demo-briefing=1 | ✅ BRIEFING modal — healthy/attention/unaudited/jobs/issues sections, close ✕/ESC/outside-tap |
| ?demo-alert=1 | ✅ red alert banner top-center; brain red-flash confirmed in code (virtual-time capture catches decay tail — real-time flash is 3s) |
| deck-icon.html at 1024/512/192/180 | ✅ arc-reactor mark crisp at all sizes → public/icons/deck-*.png |
| 403 lock page | ✅ branded orb mark + sign-in guidance |

## Journeys (live WebSocket, real services)

1. **Command** → `{type:'command','status report'}` → chat reply with real CPU/RAM/platform counts. ✅
2. **Briefing** → `'morning briefing'` → `{type:'briefing'}` structured broadcast (10 healthy / 2 attention) + spoken chat summary. ✅
3. **Alert** → POST warn/alert notification → feed line + `{type:'notify'}` broadcast (title+speech) to connected clients. ✅
4. **Voice** → `GET /tts?text=…` → 200 `audio/mpeg` (ElevenLabs "James — Professional British Male"); second call served from disk cache in 6 ms. ✅
5. **Auth** → no cookie → branded 403; `?token=` → cookie → 200; gateway cookie accepted; tailnet HTTPS `https://jarvis.tailbd6217.ts.net:8444/health` → 200. ✅
6. **PWA** → `/deck.webmanifest` 200 `application/manifest+json`; `/icons/deck-192.png` 200 `image/png`; head carries manifest + apple-touch-icon + standalone metas. ✅

## Known constraints (not defects)

- Brain runs the intent pipeline until Anthropic API credits are added (then Fable 5 streaming activates automatically).
- Screenshot service uses `--virtual-time-budget`: live WS pushes can never appear in captures — that's why `?demo-alert` / `?demo-briefing` QA hooks exist.
- Mic/speech itself can only be truly tested on a device with a microphone (code paths mirror the proven gateway implementation).
- iOS arms the microphone after one tap per page-open (platform requirement); the orb label says TAP TO ARM VOICE until then.

## On-device checklist for Craig

- [ ] Safari → share → **Add to Home Screen** → JARVIS icon appears, launches full-screen
- [ ] Tap once → say "Jarvis, morning briefing" → hear James + see the briefing panel
- [ ] Watch the brain: amber while thinking, red flash when an alert lands
- [ ] Toggle voice button: WAKE → MIC LIVE → OFF

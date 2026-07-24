# Jarvis Voice v2 — real-time streaming voice (2026-07-25)

Craig's ask: "a professional Jarvis, the most intelligent possible" — after
three days of patching the v1 voice loop (browser SpeechRecognition →
request/response brain → per-sentence GET /tts fetches), whose turn-based
architecture is the root of the "feels slow / can't interrupt" complaints.

## What v2 changes

| | v1 (default) | v2 (flagged) |
|---|---|---|
| TTS | one GET /tts fetch **per sentence**; ~1–2s gap before each | **one ElevenLabs websocket stream per reply** (`stream-input`, eleven_flash_v2_5); first audio ~300–500ms, continuous prosody |
| Playback | `<audio>` per blob | MediaSource stream on the same `jarvisAudio` element (orb/analyser wiring unchanged) |
| Interrupt | client kills local audio; server keeps generating | client sends `{type:'interrupt'}` → **server aborts the ElevenLabs stream + discards the rest of the turn's audio at source** |
| Barge-in | wake-word only | **any real speech** (final result, ≥3 words) cuts him off and becomes the next command; wake word still instant. Echo filter: heard text ≥60% word-overlap with what Jarvis is currently saying → it's his own voice through the speakers → ignored |

## Architecture

```
mic (browser, always hot on desktop)
  └─ SpeechRecognition (unchanged)
deck WS /jarvis  ── {type:'command', text, v2:true} ──► deck-server
  brain runAgent() chat_chunks ──► sentence segmenter ──► lib/tts-stream.js
                                                      (EL websocket session)
  ◄── JSON frames (chat_chunk / audio_ctl start|end|fallback)
  ◄── BINARY frames = mp3 chunks ──► MediaSource sourceBuffer ──► jarvisAudio
  {type:'interrupt'} ──► abort EL stream, stop audio + chunk forwarding
```

- **Flag:** `?v2=1` on the deck URL turns it on (persisted in localStorage;
  `?v2=0` reverts). Requires desktop + MediaSource; iOS always uses v1.
- **Budget:** same daily-char KV budget as v1 (chars counted as sent to the
  stream); `TTS_DISABLED=1` kills v2 exactly like v1. No cache for streams
  (each reply is unique — the v1 cache still serves repeated notify lines).
- **Fallback:** any EL stream failure mid-turn → `audio_ctl:fallback` → the
  client speaks the reply's final text through the v1 path. A v2 client on a
  v1 server (or vice versa) degrades to v1 silently — the flag only adds
  fields, never changes existing message shapes.

## Files
- `src/lib/tts-stream.js` — ElevenLabs stream-input session wrapper
- `src/deck-server.js` — v2 command path (segmenter + audio frames + interrupt)
- `src/lib/tts.js` — exports shared VOICE_ID/MODEL_ID/budget helpers
- `public/command-deck.html` — MediaSource player, v2 flag, echo-filtered barge-in

## Verified
- Server-side smoke test on the box: EL websocket opened, text sent, real
  mp3 bytes received (see deploy notes in git log for byte counts).
- End-to-end audio/barge-in feel: Craig's ears — flag on with `?v2=1`.

## Not in v2 (honest scope)
- Streaming STT (still browser SpeechRecognition; a Deepgram/whisper server
  path is the next leap if v2's barge-in still isn't enough)
- iOS barge-in (Safari one-shot recognition + speaker bleed)
- Server-side VAD (interruption is still transcript-triggered, not raw audio)

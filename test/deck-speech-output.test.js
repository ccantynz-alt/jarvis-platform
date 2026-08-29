// Why Marco went mute on Craig's iPhone for two days (2026-08-27 → 08-29).
//
// Craig: "the deck is not been able to speak we can't get a briefing nor can
// we hear Marco in response. Two days now with this error on iPhone."
//
// Both symptoms are one symptom — speech OUTPUT produced nothing — and the
// deck showed no sign of it. Three defects, each independently able to do it,
// each guarded below:
//
//   1. A Chrome-desktop workaround shipped to every platform. The 08-27
//      keep-alive nudge (speechSynthesis.resume() right after speak(), then
//      every 4s) was written for Blink, on the reasoning that "resume() on a
//      healthy engine is a harmless no-op, and iOS ignores it". Asserted,
//      never tested — and it was the ONLY change to the audio path in the
//      window Craig's phone went silent. It is gated to Blink now.
//
//   2. speak() was gated on voiceMode — the MICROPHONE's mode. The mic button
//      cycles WAKE → LIVE → OFF and PERSISTS the choice, so one extra tap
//      muted Marco on that device forever, under a pill reading "MIC OFF".
//      Worse: voiceMode is forced to 'off' whenever the browser has no
//      SpeechRecognition (an iPhone home-screen PWA, Lockdown Mode, an in-app
//      browser), and the mic button returns EARLY on !SRCls before it can
//      cycle back out. A device that could not LISTEN was made permanently
//      unable to TALK, with no on-screen control able to undo it.
//
//   3. loadVoices() runs once synchronously at parse time, from above every
//      `let` in the voice section, and called renderVoiceSheet() — which reads
//      voiceEngine / ttsPrimed / speechMuted. On any browser whose getVoices()
//      answers synchronously that is a TDZ ReferenceError at boot, which kills
//      the entire deck script.
//
// Static assertions where the bug was a shape, behavioural runs where the bug
// was a decision — the deck is one long inline script, so both are extracted
// from the shipped HTML the way test/deck-voice.test.js does it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

// CRLF-normalised: a Windows checkout gives \r\n, and `.` never matches \r.
const html = readFileSync(new URL('../public/command-deck.html', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');

// Pull one top-level `function name(...) { ... }` out of the page. Anchored at
// column 0 and closed by the matching column-0 brace, which is how every
// function in the deck's script is formatted.
function fnSrc(name) {
  const re = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`, 'm');
  const m = html.match(re);
  assert.ok(m, `${name}() not found — did the voice section move?`);
  return m[0];
}

// ── 1. The keep-alive belongs to the engine it was written for ──────────────

const KEEPALIVE_SRC = html.match(/const SPEECH_KEEPALIVE = \(\(\) => \{[\s\S]*?\}\)\(\);/);
assert.ok(KEEPALIVE_SRC, 'SPEECH_KEEPALIVE not found');

const keepAliveFor = (userAgent, platform = 'Win32', maxTouchPoints = 0) =>
  new Function('navigator', `${KEEPALIVE_SRC[0]}\nreturn SPEECH_KEEPALIVE;`)({ userAgent, platform, maxTouchPoints });

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0 Mobile/15E148 Safari/604.1',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};

test('the keep-alive nudge never runs on an iPhone', () => {
  assert.equal(keepAliveFor(UA.iphone), false);
});

test('the keep-alive nudge never runs on iPadOS, which masquerades as a Mac', () => {
  // Same trick IS_IOS uses: iPadOS reports a desktop Mac UA, so the UA string
  // alone cannot see it — maxTouchPoints can.
  assert.equal(keepAliveFor(UA.ipadOS, 'MacIntel', 5), false);
});

test('Chrome on iOS is still WebKit underneath — no nudge there either', () => {
  assert.equal(keepAliveFor(UA.iosChrome), false);
});

test('Craig’s laptop keeps the fix it was written for', () => {
  assert.equal(keepAliveFor(UA.chrome), true);
  assert.equal(keepAliveFor(UA.edge), true);
});

test('desktop Safari does not get a Blink workaround either', () => {
  assert.equal(keepAliveFor(UA.macSafari, 'MacIntel', 0), false);
});

test('speakBrowserAsync calls resume() only behind the gate', async () => {
  const run = (keepAlive) => {
    const calls = [];
    const speechSynthesis = {
      speaking: false,
      cancel: () => calls.push('cancel'),
      speak: () => calls.push('speak'),
      resume: () => calls.push('resume'),
    };
    const fn = new Function(
      'SPEECH_KEEPALIVE', 'speechSynthesis', 'SpeechSynthesisUtterance', 'window',
      'pickBritishMaleVoice', 'voiceCache', 'voiceSetting', 'S', 'updateOrbLabel', 'setLastEnd',
      `${fnSrc('speakBrowserAsync').replace(/lastSpeechEndAt = Date\.now\(\)/g, 'setLastEnd()')}
       return speakBrowserAsync;`,
    )(
      keepAlive, speechSynthesis,
      class { constructor(t) { this.text = t; } },
      { speechSynthesis },
      () => null, [], (k, d) => d, {}, () => {}, () => {},
    );
    const p = fn('Good morning, sir.');
    return { calls, p };
  };

  const off = run(false);
  assert.deepEqual(off.calls, ['cancel', 'speak'], 'iOS must see speak() and nothing else');

  const on = run(true);
  assert.deepEqual(on.calls, ['cancel', 'speak', 'resume'], 'Blink still gets its nudge');
});

test('the raw resume() is not left reachable outside the gate', () => {
  const src = fnSrc('speakBrowserAsync');
  const gate = src.indexOf('if (SPEECH_KEEPALIVE)');
  assert.ok(gate > 0, 'the keep-alive is no longer gated by SPEECH_KEEPALIVE');
  assert.ok(
    !/speechSynthesis\.resume\(\)/.test(src.slice(0, gate)),
    'a resume() escaped above the gate — that is the shape that muted the iPhone',
  );
});

// ── 2. The mouth is not wired to the ear ────────────────────────────────────

// speak() with everything it touches stubbed, so the ONLY thing under test is
// which switches it consults.
function makeSpeak({ muted = false, voiceParam = null } = {}) {
  const queued = [];
  const fn = new Function(
    'qs', 'speechMuted', 'voiceMode', 'rememberSpoken', 'speechQ', 'updatePendingBadge', 'pumpSpeech',
    `${fnSrc('speak')}\nreturn speak;`,
  )(
    { get: (k) => (k === 'voice' ? voiceParam : null) },
    muted,
    'off',                      // the mic is OFF for every case below
    () => {}, queued, () => {}, () => {},
  );
  return { speak: fn, queued };
}

test('the mic being OFF does not silence Marco', () => {
  // THE regression. voiceMode === 'off' used to return early, so the third tap
  // of the mic button — persisted to localStorage — was a permanent mute.
  const { speak, queued } = makeSpeak();
  speak('Your morning briefing, sir.');
  assert.deepEqual(queued, ['Your morning briefing, sir.']);
});

test('a browser with no speech recognition still gets a talking Marco', () => {
  // !SRCls forces voiceMode to 'off' at boot — an iPhone home-screen PWA, an
  // in-app browser, Lockdown Mode. The deck may not be able to HEAR him. It
  // must still be able to ANSWER him, and the mic button could never have
  // cycled back out of that state.
  const { speak, queued } = makeSpeak();
  speak('Eleven services green, sir.');
  assert.equal(queued.length, 1);
});

test('the deliberate mute is the one thing that silences him', () => {
  const { speak, queued } = makeSpeak({ muted: true });
  speak('Your morning briefing, sir.');
  assert.deepEqual(queued, []);
});

test('?voice=0 still silences the tab', () => {
  const { speak, queued } = makeSpeak({ voiceParam: '0' });
  speak('Your morning briefing, sir.');
  assert.deepEqual(queued, []);
});

test('speak() consults no microphone state at all', () => {
  // Belt and braces on the shape: a future edit that reintroduces ANY mic
  // condition into the mouth's gate fails here, not on Craig's phone.
  const src = fnSrc('speak');
  for (const mic of ['voiceMode', 'armed', 'SRCls', 'listening']) {
    assert.ok(!new RegExp(`\\b${mic}\\b`).test(src), `speak() must not consult ${mic}`);
  }
});

test('the mute has its own key — the mic’s key can never mute him', () => {
  const src = html.match(/let speechMuted = \(\(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(src, 'speechMuted declaration not found');
  assert.match(src[0], /jarvis_speech_muted/);
  assert.ok(!/jarvis_voice\b/.test(src[0]), 'the mute must not read the mic’s persisted mode');
  assert.match(fnSrc('setSpeechMuted'), /jarvis_speech_muted/);
});

test('turning the mic off is a one-shot stop, never a persisted mute', () => {
  const src = fnSrc('setVoiceMode');
  assert.match(src, /stopAllAudio\(\)/, 'mic-off should still shut him up now');
  assert.ok(
    !/speechMuted\s*=/.test(src) && !/setSpeechMuted\(/.test(src),
    'setVoiceMode must never write the speech mute — that is the conflation itself',
  );
});

// ── 3. A deck that cannot speak has to SAY so ───────────────────────────────

test('the state pill reports MUTED and NO VOICE above the mic states', () => {
  const src = fnSrc('updateVoiceState');
  const muted = src.indexOf('MARCO MUTED');
  const noVoice = src.indexOf('NO VOICE');
  const micOff = src.indexOf('MIC OFF');
  assert.ok(muted > 0 && noVoice > 0 && micOff > 0, 'pill labels missing');
  assert.ok(muted < micOff, 'MUTED must outrank MIC OFF — otherwise silence hides behind it');
  assert.ok(noVoice < micOff, 'NO VOICE must outrank MIC OFF');
});

test('the voice sheet explains the silence and can undo it', () => {
  assert.match(html, /id="vs-mute"/, 'no mute control in the voice sheet');
  assert.match(html, /\$\('vs-mute'\)\.onclick/, 'the mute control is not wired');
  const render = fnSrc('renderVoiceSheet');
  assert.match(render, /Marco is MUTED on this device/, 'the sheet must name the mute as the cause');
  assert.match(render, /no speech synthesis at all/, 'the sheet must name a missing engine');
});

test('the mic button no longer calls itself VOICE OFF', () => {
  // It was labelled VOICE OFF back when the third tap really did mute Marco.
  // It stops the ear only; a button that claims the voice is off, while the
  // voice is fine, is how the two days got misdiagnosed in the first place.
  const labels = html.match(/const MODE_LABEL = \{[^}]*\}/);
  assert.ok(labels, 'MODE_LABEL not found');
  assert.ok(!/VOICE OFF/.test(labels[0]), 'the mic button must not claim to control the voice');
  assert.match(labels[0], /MIC OFF/);
});

// ── 4. Boot must survive a browser whose voice list is already warm ─────────

test('loadVoices does not render the sheet during the parse-time call', () => {
  // iOS usually returns [] until a gesture — usually. Chrome with a warm
  // profile answers immediately, and that first call happens above every `let`
  // renderVoiceSheet reads. Rendering there is a TDZ ReferenceError that takes
  // the whole deck script down, voice and all.
  let rendered = 0;
  const load = new Function(
    'window', 'speechSynthesis', 'setCache', 'voicesReady', 'renderVoiceSheet',
    `${fnSrc('loadVoices').replace(/voiceCache = v/, 'setCache(v)')}\nreturn loadVoices;`,
  );
  const warm = { getVoices: () => [{ name: 'Daniel', lang: 'en-GB' }] };
  let cached = [];

  load({ speechSynthesis: warm }, warm, (v) => { cached = v; }, false, () => { rendered++; })();
  assert.equal(rendered, 0, 'the boot call must not touch the sheet');
  assert.equal(cached.length, 1, 'but it must still fill the voice cache');

  load({ speechSynthesis: warm }, warm, () => {}, true, () => { rendered++; })();
  assert.equal(rendered, 1, 'once the section is initialised, voiceschanged renders as before');
});

test('voicesReady flips only after every dependency of the sheet exists', () => {
  const script = html.slice(html.indexOf('<script'), html.lastIndexOf('</script>'));
  const flip = script.indexOf('\nvoicesReady = true;');
  assert.ok(flip > 0, 'voicesReady is never set — the sheet would never render');
  for (const dep of ['let ttsPrimed', 'let voiceEngine', 'let speechMuted']) {
    const at = script.indexOf(dep);
    assert.ok(at > 0, `${dep} not found`);
    assert.ok(at < flip, `${dep} must be initialised before voicesReady flips`);
  }
  assert.ok(script.indexOf('\n  loadVoices();') < flip, 'the parse-time loadVoices() must run before the flip');
});

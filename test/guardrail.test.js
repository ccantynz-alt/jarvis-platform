// lib/guardrail.js — the 2026-07-17 lesson, generalised.
//
// systemd's EnvironmentFile keeps inline comments as part of the value, so
// "6 # per day" reaches the process verbatim. Number() makes that NaN and every
// comparison against NaN is false, so `attempts < MAX` stops blocking. All four
// self-heal gates disabled themselves at once and the box fired 117 repair
// dispatches in a day against a cap of 6, silently.

import test from 'node:test';
import assert from 'node:assert/strict';
import { guardrail } from '../src/lib/guardrail.js';

const NAME = 'JARVIS_TEST_GUARDRAIL';
const quiet = (fn) => {
  const real = console.error; const seen = [];
  console.error = (m) => seen.push(String(m));
  try { return { value: fn(), logs: seen }; } finally { console.error = real; }
};

test.afterEach(() => { delete process.env[NAME]; });

test('a clean value is used', () => {
  process.env[NAME] = '6';
  assert.equal(guardrail(NAME, 3), 6);
});

test('an inline comment does not become NaN — the original incident', () => {
  process.env[NAME] = '6 # per day';
  assert.equal(quiet(() => guardrail(NAME, 3)).value, 6);
});

test('a tab-separated comment is handled too', () => {
  process.env[NAME] = '12\t# minutes';
  assert.equal(quiet(() => guardrail(NAME, 3)).value, 12);
});

test('unset falls back silently', () => {
  const { value, logs } = quiet(() => guardrail(NAME, 3));
  assert.equal(value, 3);
  assert.equal(logs.length, 0, 'an unset optional limit is normal, not an error');
});

test('garbage falls back AND is reported', () => {
  process.env[NAME] = '# 40000';
  const { value, logs } = quiet(() => guardrail(NAME, 40000, { source: 'tts' }));
  assert.equal(value, 40000);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[tts\] BAD GUARDRAIL/);
});

test('a negative or zero limit is refused — it would disable the gate', () => {
  for (const bad of ['-1', '0']) {
    process.env[NAME] = bad;
    assert.equal(quiet(() => guardrail(NAME, 5)).value, 5, bad);
  }
});

test('zero is accepted when it is a meaningful setting', () => {
  process.env[NAME] = '0';
  assert.equal(guardrail(NAME, 5, { allowZero: true }), 0);
});

test('the result is ALWAYS finite — nothing downstream can compare against NaN', () => {
  for (const v of ['', '   ', 'abc', 'NaN', 'Infinity', '# nope']) {
    process.env[NAME] = v;
    assert.equal(Number.isFinite(quiet(() => guardrail(NAME, 7)).value), true, JSON.stringify(v));
  }
});

// ── clampLimit: a negative LIMIT is no limit at all (2026-07-30) ─────────────
// `Math.min(parseInt(raw, 10) || 50, 500)` clamps the top and not the bottom, so
// ?limit=-1 yields -1 — and SQLite documents a negative LIMIT as "no upper bound
// on the number of rows returned". One query param and a paged endpoint dumps the
// whole table. Five endpoints had it (memory-server ×4, orchestrator ×1).

import { clampLimit } from '../src/lib/guardrail.js';

test('a negative limit falls back instead of becoming unbounded', () => {
  assert.equal(clampLimit('-1', 50, 500), 50, 'SQLite reads LIMIT -1 as no limit');
  assert.equal(clampLimit('-99999', 50, 500), 50);
  assert.equal(clampLimit(-5, 50, 500), 50);
});

test('zero is not a useful page size either', () => {
  assert.equal(clampLimit('0', 50, 500), 50);
});

test('a sane limit is honoured and the ceiling still applies', () => {
  assert.equal(clampLimit('10', 50, 500), 10);
  assert.equal(clampLimit('9999', 50, 500), 500);
  assert.equal(clampLimit('500', 50, 500), 500);
});

test('junk and absence fall back', () => {
  for (const raw of [undefined, null, '', 'abc', 'NaN', {}, []]) {
    assert.equal(clampLimit(raw, 50, 500), 50, JSON.stringify(raw));
  }
});

test('a numeric-prefixed string is read as its number, like parseInt', () => {
  assert.equal(clampLimit('25 rows', 50, 500), 25);
  // parseInt(_, 10) stops at the 'e', so this is 1 — a harmless page size, not
  // the infinity the notation suggests. Worth pinning so nobody "fixes" it into
  // Number(), which WOULD yield Infinity here.
  assert.equal(clampLimit('1e999', 50, 500), 1);
});

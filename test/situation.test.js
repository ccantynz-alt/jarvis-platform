// test/situation.test.js — the deck's synthesis, and the cache that pays for it.
//
// 2026-08-05. The OPS tab showed tables at equal weight: a critical
// unauthenticated payment endpoint rendered exactly like a drafted LinkedIn
// post. This turns that into a ranked judgement.
//
// The fingerprint is the load-bearing part. Every synthesis is a subscription
// turn from the SAME window the voice brain and every repair agent draw from,
// and there is no metered fallback — so "regenerate only when the facts
// materially changed" is a cost control, not an optimisation.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  situationFingerprint, situationPrompt, parseSituation, needsAttention,
} from '../src/lib/situation.js';

const data = () => ({
  findings: [
    { id: 195, severity: 'critical', platform: 'zoobicon', title: 'Stripe portal unauthenticated', file: 'src/x.ts:17' },
    { id: 149, severity: 'critical', platform: 'gatetest', title: '/api/heal/ssh has no auth' },
  ],
  proposals: [
    { id: 2, status: 'proposed', platform: 'gatetest', title: 'Lock down /api/heal/ssh' },
    { id: 3, status: 'escalated', platform: 'bookaride', title: 'Refund duplicate charges' },
    { id: 9, status: 'rejected', platform: 'x', title: 'old' },
  ],
  platforms: [{ name: 'gatetest.ai', status: 'DOWN' }, { name: 'zoobicon.com', status: 'OPERATIONAL' }],
  jobs: [{ id: 'a1', platform: 'gluecron', task: 'fix merge', status: 'completed', exit_code: 0 }],
});

// ── the cache that keeps this affordable ────────────────────────────────────

test('identical facts fingerprint identically', () => {
  assert.equal(situationFingerprint(data()), situationFingerprint(data()));
});

test('CHURN that changes no advice does NOT bust the cache', () => {
  // These move constantly. If they busted the cache, a 30-minute timer would
  // burn ~48 subscription turns a day restating an unchanged picture.
  const a = data();
  const b = data();
  b.findings[0].last_seen = '2026-08-05T13:00:00Z';
  b.findings[0].seen = 12;
  b.jobs[0].finished_at = '2026-08-05T13:00:00Z';
  b.proposals[2].status = 'withdrawn';           // already-decided proposal
  b.inbox = { unread: 999 };
  assert.equal(situationFingerprint(a), situationFingerprint(b));
});

test('a NEW finding busts it', () => {
  const b = data();
  b.findings.push({ id: 300, severity: 'high', platform: 'voxlen', title: 'new' });
  assert.notEqual(situationFingerprint(data()), situationFingerprint(b));
});

test('a severity ESCALATION busts it even at the same count', () => {
  const b = data();
  b.findings[1].severity = 'medium';
  assert.notEqual(situationFingerprint(data()), situationFingerprint(b));
});

test('a proposal changing state busts it', () => {
  const b = data();
  b.proposals[0].status = 'escalated';
  assert.notEqual(situationFingerprint(data()), situationFingerprint(b));
});

test('a platform going down busts it', () => {
  const b = data();
  b.platforms[1].status = 'DOWN';
  assert.notEqual(situationFingerprint(data()), situationFingerprint(b));
});

test('a FAILED job busts it; a completed one does not', () => {
  const ok = data(); ok.jobs.push({ id: 'z', platform: 'x', task: 't', status: 'completed', exit_code: 0 });
  assert.equal(situationFingerprint(data()), situationFingerprint(ok));
  const bad = data(); bad.jobs.push({ id: 'z', platform: 'x', task: 't', status: 'failed' });
  assert.notEqual(situationFingerprint(data()), situationFingerprint(bad));
});

test('finding ORDER is not a change', () => {
  const b = data();
  b.findings.reverse();
  assert.equal(situationFingerprint(data()), situationFingerprint(b));
});

test('empty data fingerprints without throwing', () => {
  assert.equal(typeof situationFingerprint({}), 'string');
  assert.equal(typeof situationFingerprint(), 'string');
});

// ── the prompt ──────────────────────────────────────────────────────────────

test('the prompt forbids reading the screen back to him', () => {
  const p = situationPrompt(data());
  assert.match(p, /Do NOT list it back to him/);
  assert.match(p, /what it MEANS and what to do/);
});

test('the prompt demands ranking by real exposure, not by label', () => {
  const p = situationPrompt(data());
  assert.match(p, /worst FIRST/);
  assert.match(p, /not by severity\s*\n?\s*label/);
});

test('escalated proposals are marked as needing Craig specifically', () => {
  const p = situationPrompt(data());
  assert.match(p, /#3 \[escalated\].*ESCALATED TO CRAIG/);
});

test('already-decided proposals are not put in front of him', () => {
  const p = situationPrompt(data());
  assert.doesNotMatch(p, /#9/);
});

test('the prompt forbids invention', () => {
  assert.match(situationPrompt(data()), /Never invent anything not present/);
});

test('THE FIRST LIVE ERROR: it must not assert how a change landed', () => {
  // The first real synthesis said "all completed on branches, none merged to
  // main". Half of those had been pushed straight to main the day before,
  // pre-governance. Nothing in the data says how anything landed — that was an
  // inference presented as fact, in the one panel meant to be trusted at a
  // glance.
  const p = situationPrompt(data());
  assert.match(p, /do NOT state HOW a change landed/);
  assert.match(p, /merged, ?\n?pushed to a branch, deployed, or released/);
});

test('an empty fleet still produces a usable prompt', () => {
  const p = situationPrompt({});
  assert.match(p, /none/);
  assert.match(p, /all operational/);
  assert.match(p, /NEEDS YOU/);
});

// ── parsing ─────────────────────────────────────────────────────────────────

const good = `NEEDS YOU
- Zoobicon's Stripe portal mints a billing session for any email, on a live site taking payments.
- gatetest.ai is down because its domain does not resolve; only the registrar can fix it.

CHANGED
- Two confirmed criticals moved to Zoobicon after a registry correction.

HANDLED
- Four repair branches were prepared and are awaiting your review.`;

test('the three sections parse into bullets', () => {
  const r = parseSituation(good);
  assert.equal(r.ok, true);
  assert.equal(r.sections['NEEDS YOU'].length, 2);
  assert.equal(r.sections['CHANGED'].length, 1);
  assert.equal(r.sections['HANDLED'].length, 1);
  assert.match(r.sections['NEEDS YOU'][0], /Stripe portal/);
});

test('headings with colons and bullet variants are tolerated', () => {
  const r = parseSituation('NEEDS YOU:\n* one thing\n\nHANDLED:\n• another');
  assert.equal(r.ok, true);
  assert.equal(r.sections['NEEDS YOU'][0], 'one thing');
  assert.equal(r.sections['HANDLED'][0], 'another');
});

test('an unparseable synthesis is kept as raw text, never silently dropped', () => {
  // A blank panel reads as "all clear". Silence must never be good news.
  const r = parseSituation('The fleet looks fine to me today.');
  assert.equal(r.ok, false);
  assert.equal(r.raw, 'The fleet looks fine to me today.');
  assert.match(r.error, /no recognisable sections/);
});

test('an empty synthesis is reported as an error, not as calm', () => {
  const r = parseSituation('');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty/);
  assert.equal(parseSituation(null).ok, false);
});

// ── the attention badge ─────────────────────────────────────────────────────

test('the badge counts real attention items', () => {
  assert.equal(needsAttention(parseSituation(good)), 2);
});

test('"nothing needs you" is not an attention item', () => {
  const r = parseSituation('NEEDS YOU\n- Nothing needs you right now.\n\nHANDLED\n- Routine sweeps ran.');
  assert.equal(needsAttention(r), 0);
});

test('a broken parse does not fabricate a badge', () => {
  assert.equal(needsAttention(parseSituation('garbage')), 0);
  assert.equal(needsAttention(null), 0);
});

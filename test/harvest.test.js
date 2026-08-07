// The flywheel's pure logic (src/lib/harvest.js).
//
// The two tests that matter most carry their incidents:
//   - the conversation exclusion (2026-08-06: 23 minutes of private household
//     talk went through the brain — that channel must never enter the flywheel)
//   - redaction (transcripts echo env vars; the memory DB is quoted into
//     prompts, and this repo is public)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  redactSecrets, parseSessionJsonl, isConversationSession, isTrivialSession,
  platformFromCwd, buildExcerpt, normalizeLesson, lessonFingerprint, eligibleFiles,
} from '../src/lib/harvest.js';

// ── redaction ──────────────────────────────────────────────────────────────

test('API keys, tokens, and key-material are redacted', () => {
  const dirty = [
    'sk-ant-api03-abcdefghijklmnop',
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrst1234',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789012-abcdefghij',
    'JARVIS_GATEWAY_TOKEN=supersecretvalue123',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
  ].join('\n');
  const clean = redactSecrets(dirty);
  assert.ok(!clean.includes('abcdefghijklmnop'), 'anthropic key survived');
  assert.ok(!clean.includes('ghp_abcdefghijklmnopqrst1234'), 'github token survived');
  assert.ok(!clean.includes('AKIAIOSFODNN7EXAMPLE'), 'aws key survived');
  assert.ok(!clean.includes('supersecretvalue123'), 'named env secret survived');
  assert.ok(clean.includes('JARVIS_GATEWAY_TOKEN=[REDACTED]'), 'env name should remain for context');
});

test('git SHAs and ordinary prose are NOT redacted', () => {
  const s = 'fixed in 98adb70 and 0011645f3a2b4c5d6e7f98adb70aa11645f3a2b4c5; the password policy doc';
  assert.equal(redactSecrets(s), s);
});

// ── parsing ────────────────────────────────────────────────────────────────

const jl = (o) => JSON.stringify(o);
const CODING_SESSION = [
  jl({ timestamp: '2026-08-07T01:00:00Z', cwd: '/opt/gatetest', message: { role: 'user', content: 'Fix the auth check on /api/heal/ssh' } }),
  jl({ timestamp: '2026-08-07T01:00:10Z', message: { role: 'assistant', content: [
    { type: 'text', text: 'Reading the route first.' },
    { type: 'tool_use', name: 'Read', input: { file_path: '/opt/gatetest/src/api/heal.ts' } },
  ] } }),
  jl({ timestamp: '2026-08-07T01:01:00Z', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: '/opt/gatetest/src/api/heal.ts' } },
    { type: 'text', text: 'Added the token check and a test. Done.' },
  ] } }),
].join('\n');

test('a coding session parses to turns, tools, and files', () => {
  const p = parseSessionJsonl(CODING_SESSION);
  assert.equal(p.userTurns, 1);
  assert.equal(p.assistantTurns, 2);
  assert.equal(p.toolCalls, 2);
  assert.deepEqual(p.toolCounts, { Read: 1, Edit: 1 });
  assert.deepEqual(p.filesTouched, ['/opt/gatetest/src/api/heal.ts']);
  assert.equal(p.cwd, '/opt/gatetest');
  assert.equal(p.lastAssistantText, 'Added the token check and a test. Done.');
});

test('garbage lines and unknown shapes are skipped, not fatal', () => {
  const p = parseSessionJsonl('not json\n{"weird":true}\n' + CODING_SESSION);
  assert.equal(p.userTurns, 1);
});

// ── the conversation exclusion (the 2026-08-06 rule) ───────────────────────

test('a brain conversation session is recognized and excluded', () => {
  const conv = jl({ timestamp: '2026-08-07T01:00:00Z', cwd: '/opt/jarvis', message: {
    role: 'user',
    content: '[Live status, background only — do not recite this unprompted…] morning briefing',
  } });
  const p = parseSessionJsonl(conv + '\n' + CODING_SESSION);
  assert.equal(isConversationSession(p), true, 'one marker anywhere must exclude the whole session');
  assert.equal(isConversationSession(parseSessionJsonl(CODING_SESSION)), false);
});

test('canary probes and empty shells are trivial', () => {
  const canary = jl({ message: { role: 'user', content: 'Reply with exactly: CANARY-OK' } });
  assert.equal(isTrivialSession(parseSessionJsonl(canary)), true);
  assert.equal(isTrivialSession(parseSessionJsonl(CODING_SESSION)), false);
});

// ── platform mapping ───────────────────────────────────────────────────────

const REGISTRY = {
  gatetest: { path: '/opt/gatetest' },
  zoobicon: { path: '/root/zoobicon' },
  'universal-ai-operator': { path: '/root/universal-ai-operator' },
};

test('cwd maps to the registered platform, longest path wins', () => {
  assert.equal(platformFromCwd('/opt/gatetest', REGISTRY), 'gatetest');
  assert.equal(platformFromCwd('/opt/gatetest/src', REGISTRY), 'gatetest');
  assert.equal(platformFromCwd('/opt/jarvis', REGISTRY), 'jarvis');
  assert.equal(platformFromCwd('/opt/elsewhere', REGISTRY), null);
  // the nested-checkout trap from LESSONS.md: a prefix match alone would file
  // this under the OUTER platform only by ordering luck
  const nested = { ...REGISTRY, zoobicontarget: { path: '/root/universal-ai-operator/target_code/zoobicon' } };
  assert.equal(platformFromCwd('/root/universal-ai-operator/target_code/zoobicon/src', nested), 'zoobicontarget');
});

test('a path that merely shares a prefix string is not a match', () => {
  assert.equal(platformFromCwd('/opt/gatetest-extras', REGISTRY), null);
});

// ── distillation plumbing ──────────────────────────────────────────────────

test('excerpts are redacted and bounded', () => {
  const p = parseSessionJsonl(jl({ cwd: '/opt/gatetest', message: { role: 'user', content: 'set STRIPE_SECRET_KEY=sk-live-abcdefghijklmnopqrstuv please' } }));
  const ex = buildExcerpt(p);
  assert.ok(!ex.includes('sk-live-abcdefghijklmnopqrstuv'), 'secret leaked into excerpt');
  assert.ok(buildExcerpt(p, { maxChars: 100 }).length <= 100);
});

test('lessons are clamped: bad kinds/confidence default, short ones die', () => {
  assert.equal(normalizeLesson({ kind: 'evil', lesson: 'x', confidence: 'sure' }, 'gatetest'), null);
  const l = normalizeLesson({ kind: 'evil', lesson: 'The build only works from the repo root, not src/.', confidence: 'sure' }, 'GateTest');
  assert.equal(l.kind, 'gotcha');
  assert.equal(l.confidence, 'medium');
  assert.equal(l.platform, 'gatetest');
});

test('the same lesson rephrased in whitespace/case is one fingerprint', () => {
  const a = lessonFingerprint({ platform: 'gatetest', kind: 'gotcha', lesson: 'Run bun, not npm.' });
  const b = lessonFingerprint({ platform: 'gatetest', kind: 'gotcha', lesson: '  run BUN,  not npm.  ' });
  const c = lessonFingerprint({ platform: 'zoobicon', kind: 'gotcha', lesson: 'Run bun, not npm.' });
  assert.equal(a, b);
  assert.notEqual(a, c, 'platform must be part of identity');
});

// ── file eligibility ───────────────────────────────────────────────────────

test('live files wait, quiet new/grown files harvest, unchanged files skip', () => {
  const now = 1_000_000_000;
  const q = 10 * 60 * 1000;
  const entries = [
    { path: 'a.jsonl', size: 100, mtimeMs: now - 1000 },        // still being written
    { path: 'b.jsonl', size: 100, mtimeMs: now - q - 1 },       // quiet + new
    { path: 'c.jsonl', size: 200, mtimeMs: now - q - 1 },       // quiet + grown
    { path: 'd.jsonl', size: 300, mtimeMs: now - q - 1 },       // quiet + unchanged
  ];
  const state = { 'c.jsonl': { size: 100 }, 'd.jsonl': { size: 300 } };
  assert.deepEqual(eligibleFiles(entries, state, now).map(e => e.path), ['b.jsonl', 'c.jsonl']);
});

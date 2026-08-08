// pc-actions.js — the vocabulary of things Jarvis may do to Craig's PC.
//
// These tests exist because this module decides two things that are dangerous
// to get wrong on someone's personal machine:
//   1. whether an argument can escape into the command it is embedded in, and
//   2. whether an action runs immediately or has to be confirmed first.
//
// A false "read-only" is the worse of the two: it means a misheard sentence
// restarts something without Craig ever being asked.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  psQuote, planAction, VERBS, isKnownVerb,
  encodeActionJob, decodeActionJob, ACTION_RUNTIME,
} from '../src/lib/pc-actions.js';

// ── Quoting: the whole injection defence ────────────────────────────────────

test('psQuote wraps in single quotes and doubles internal quotes', () => {
  assert.equal(psQuote('Spooler'), "'Spooler'");
  assert.equal(psQuote("it's"), "'it''s'");
});

test('psQuote neutralises every PowerShell metacharacter', () => {
  // Inside '...' PowerShell has NO escapes except '' — so none of these can
  // terminate the literal or expand. The only character that matters is the
  // quote itself, and it is doubled.
  for (const evil of [
    '$(Remove-Item C:\\ -Recurse)',
    '`n Stop-Computer',
    'a; Stop-Computer',
    'a | Stop-Computer',
    'a & calc',
    '$env:USERPROFILE',
    'a\\"; calc; "',
  ]) {
    const q = psQuote(evil);
    assert.ok(q.startsWith("'") && q.endsWith("'"), evil);
    // Exactly one opening and one closing quote survive as delimiters: every
    // internal quote was doubled, so the count between them is even.
    const inner = q.slice(1, -1);
    const quotes = (inner.match(/'/g) || []).length;
    assert.equal(quotes % 2, 0, `unbalanced quotes for ${evil}`);
  }
});

test('a service name carrying an injection is rejected outright', () => {
  // Belt and braces — psQuote would already contain it, but a clear error
  // beats a confusing PowerShell one.
  assert.throws(() => planAction('service.restart', { name: 'Spooler; Stop-Computer' }), /service name/);
  assert.throws(() => planAction('service.restart', { name: '$(calc)' }), /service name/);
  assert.throws(() => planAction('service.restart', { name: '' }), /service name/);
});

test('a legitimate service name with dots and dollars is accepted', () => {
  // Real Windows service names look like this — MSSQL$SQLEXPRESS, Winmgmt.
  for (const name of ['MSSQL$SQLEXPRESS', 'Winmgmt', 'Jarvis.Worker', 'W3SVC', 'Dhcp']) {
    assert.doesNotThrow(() => planAction('service.status', { name }), name);
  }
});

// ── The gate classification ─────────────────────────────────────────────────

test('diagnostics are read-only and run without confirmation', () => {
  for (const verb of ['service.status', 'service.list', 'process.list', 'system.info', 'eventlog.errors']) {
    const plan = planAction(verb, { name: 'Spooler' });
    assert.equal(plan.mutates, false, verb);
  }
});

test('anything that changes the machine is gated', () => {
  const cases = [
    ['service.restart', { name: 'Spooler' }],
    ['service.start', { name: 'Spooler' }],
    ['service.stop', { name: 'Spooler' }],
    ['process.kill', { name: 'notepad' }],
    ['shell', { command: 'Get-Date' }],
  ];
  for (const [verb, args] of cases) {
    assert.equal(planAction(verb, args).mutates, true, verb);
  }
});

test('every verb in the table declares mutates explicitly', () => {
  // The default is "mutating" (see planAction), but leaving it implicit is how
  // a future verb quietly becomes ungated. Declare it.
  for (const [name, spec] of Object.entries(VERBS)) {
    assert.equal(typeof spec.mutates, 'boolean', `${name} must declare mutates`);
    assert.equal(typeof spec.needsAdmin, 'boolean', `${name} must declare needsAdmin`);
  }
});

test('an unknown verb throws rather than being passed through', () => {
  assert.equal(isKnownVerb('service.obliterate'), false);
  assert.throws(() => planAction('service.obliterate', {}), /unknown PC action/);
});

test('service control is marked as needing admin — the reason for elevation', () => {
  for (const verb of ['service.restart', 'service.start', 'service.stop']) {
    assert.equal(planAction(verb, { name: 'Spooler' }).needsAdmin, true, verb);
  }
  assert.equal(planAction('process.list', {}).needsAdmin, false);
});

// ── Argument clamping ───────────────────────────────────────────────────────

test('counts and hours are clamped, never trusted', () => {
  const huge = planAction('process.list', { top: 99999 }).script;
  assert.match(huge, /-First 60\b/); // clamped to the max, not 99999
  const nonsense = planAction('process.list', { top: 'lots' }).script;
  assert.match(nonsense, /-First 15\b/); // falls back to the default
  const hours = planAction('eventlog.errors', { hours: 99999 }).script;
  assert.match(hours, /AddHours\(-720\)/);
});

test('shell refuses an empty or oversized command', () => {
  assert.throws(() => planAction('shell', { command: '   ' }), /command required/);
  assert.throws(() => planAction('shell', { command: 'x'.repeat(8001) }), /too long/);
});

test('process.kill requires a real pid when one is given', () => {
  assert.throws(() => planAction('process.kill', { pid: 'abc' }), /pid must be/);
  assert.throws(() => planAction('process.kill', { pid: -3 }), /pid must be/);
  assert.doesNotThrow(() => planAction('process.kill', { pid: 4242 }));
});

// ── Flywheel harvest verbs (2026-08-08) ─────────────────────────────────────

test('harvest verbs are read-only — they must never hit the confirmation gate', () => {
  assert.equal(planAction('harvest.list', {}).mutates, false);
  assert.equal(planAction('harvest.get', { path: 'C:\\x\\.claude\\projects\\a.jsonl' }).mutates, false);
});

test('harvest.list validates the since timestamp', () => {
  assert.throws(() => planAction('harvest.list', { since: 'yesterday' }), /ISO timestamp/);
  assert.doesNotThrow(() => planAction('harvest.list', { since: '2026-08-01T00:00:00Z' }));
  // default (no since) is allowed — full history on first run
  assert.doesNotThrow(() => planAction('harvest.list', {}));
});

test('harvest.get pins the path to the transcript root, in the SCRIPT not just JS', () => {
  // The path guard runs on the PC (StartsWith $root), so the built script must
  // carry it — a JS-side check would be bypassed by a crafted job row.
  const s = planAction('harvest.get', { path: 'C:\\evil\\secrets.txt' }).script;
  assert.match(s, /StartsWith\(\$root/);
  assert.match(s, /EndsWith\('\.jsonl'/);
  assert.throws(() => planAction('harvest.get', { path: '' }), /path required/);
  assert.throws(() => planAction('harvest.get', { path: 'x'.repeat(501) }), /path required/);
});

// ── Job round-trip ──────────────────────────────────────────────────────────

test('an action survives the trip through a job row', () => {
  const plan = planAction('service.restart', { name: 'Spooler' });
  const job = encodeActionJob(plan);
  assert.equal(job.runtime, ACTION_RUNTIME);
  assert.match(job.task, /RESTART the "Spooler" service/);

  const back = decodeActionJob({ runtime: job.runtime, prompt: job.prompt });
  assert.equal(back.verb, 'service.restart');
  assert.equal(back.args.name, 'Spooler');
  assert.equal(back.script, plan.script);
});

test('a claude job is not mistaken for an action job', () => {
  assert.equal(decodeActionJob({ runtime: 'claude', prompt: 'fix the build' }), null);
  assert.equal(decodeActionJob(null), null);
});

test('the worker rebuilds the script from the verb table, not from the wire', () => {
  // The job row is not a trust boundary we want to widen: even if a prompt
  // carried a `script` field, decode ignores it and rebuilds from the verb.
  const job = { runtime: ACTION_RUNTIME, prompt: JSON.stringify({
    verb: 'service.status', args: { name: 'Spooler' }, script: 'Stop-Computer',
  }) };
  const back = decodeActionJob(job);
  assert.doesNotMatch(back.script, /Stop-Computer/);
  assert.match(back.script, /Get-Service/);
});

test('an unreadable action prompt is an error, not a silent no-op', () => {
  assert.throws(() => decodeActionJob({ runtime: ACTION_RUNTIME, prompt: '{not json' }), /unreadable/);
  assert.throws(() => decodeActionJob({ runtime: ACTION_RUNTIME, prompt: '{}' }), /unknown PC action/);
});

test('descriptions are human-readable — they become the confirmation preview', () => {
  assert.equal(planAction('service.restart', { name: 'JarvisPcWorker' }).description,
    'RESTART the "JarvisPcWorker" service');
  assert.match(planAction('eventlog.errors', { hours: 24 }).description, /last 24h/);
});

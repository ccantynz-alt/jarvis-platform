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
  psQuote, planAction, VERBS, isKnownVerb, workerKnowsVerb,
  encodeActionJob, decodeActionJob, ACTION_RUNTIME,
  SPECS_PROBE, parseSpecsSummary, sanitizeSpecs, describeRam,
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
  for (const verb of ['service.status', 'service.list', 'process.list', 'system.info', 'system.specs', 'eventlog.errors']) {
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

// ── The specs verb (2026-08-17) ─────────────────────────────────────────────
// Craig asked what his PC's specs were and the platform had no path to the
// answer: system.info reports how much memory is IN USE and nothing about what
// the memory IS, and no other verb touched hardware. A read-only inventory.

test('system.specs is read-only and needs no admin — it must run instantly', () => {
  const plan = planAction('system.specs', {});
  assert.equal(plan.mutates, false);
  assert.equal(plan.needsAdmin, false);
});

test('system.specs reads the hardware, not the live load', () => {
  const { script } = planAction('system.specs', {});
  // The four things "what are the specs" actually means:
  assert.match(script, /Win32_Processor/);        // CPU model, cores, clock
  assert.match(script, /Win32_PhysicalMemory/);   // installed sticks, not free MB
  assert.match(script, /Win32_VideoController/);  // GPU
  assert.match(script, /Get-PhysicalDisk/);       // drives, with a Win32 fallback
  assert.match(script, /Win32_DiskDrive/);
});

test('the memory answer covers type, slots and headroom, not just the total', () => {
  // "Specifically ram" (2026-08-17). On a laptop that died at 96% memory
  // pressure, "16 GB installed" is the number that hides the problem — the
  // useful answer is what type, how many slots are used, and what the board
  // will take.
  const { script } = planAction('system.specs', {});
  assert.match(script, /Win32_PhysicalMemoryArray/);   // slot count + board maximum
  assert.match(script, /MaxCapacityEx/);               // uint32 MaxCapacity overflows
  assert.match(script, /SMBIOSMemoryType/);            // DDR4 vs DDR5, not a raw code
  assert.match(script, /34='DDR5'/);
  assert.match(script, /12='SODIMM'/);                 // laptop form factor
  assert.match(script, /board maximum/);
});

test('every optional spec source degrades instead of failing the whole action', () => {
  // A machine with no discrete GPU, or a build without the Storage module,
  // must still return the CPU and memory — a spec sheet is useful in parts.
  const { script } = planAction('system.specs', {});
  for (const cls of ['Win32_BIOS', 'Win32_PhysicalMemory', 'Win32_VideoController', 'Get-PhysicalDisk']) {
    const line = script.split('\n').find((l) => l.includes(cls));
    assert.match(line, /-ErrorAction SilentlyContinue/, `${cls} must not be fatal`);
  }
});

test('system.specs bounds its output like every other verb', () => {
  // Unbounded text blows up a job row and a spoken reply.
  const { script } = planAction('system.specs', {});
  for (const m of script.match(/Select-Object -First (\d+)/g) || []) {
    assert.ok(Number(m.match(/(\d+)/)[1]) <= 8, m);
  }
  assert.equal((script.match(/Select-Object -First/g) || []).length, 4);
});

test('system.specs takes no arguments — nothing untrusted reaches the script', () => {
  const a = planAction('system.specs', {}).script;
  const b = planAction('system.specs', { name: "'; Remove-Item C:\\ -Recurse; '", top: 9999 }).script;
  assert.equal(a, b);
});

// ── The specs probe: an answer that outlives the machine (2026-08-17) ───────
// Craig, out shopping with only his phone, asked what RAM the laptop has. Every
// route needed the laptop: dispatch the verb -> worker online -> worker
// restarted to know the verb. The machine was at home. A static hardware fact
// must not require the hardware to be present.

test('the probe reports the RAM facts that need answering offline', () => {
  for (const key of ['ram_gb', 'ram_type', 'ram_modules', 'ram_slots', 'ram_max_gb', 'cpu', 'host']) {
    assert.match(SPECS_PROBE, new RegExp(`"${key}=`), key);
  }
});

test('parseSpecsSummary takes only allowlisted keys', () => {
  const specs = parseSpecsSummary([
    'ram_gb=16', 'ram_type=DDR4', 'ram_modules=2', 'ram_slots=2', 'ram_max_gb=64',
    'evil=whatever', 'not a pair', '=novalue',
  ].join('\r\n'));
  assert.equal(specs.ram_gb, '16');
  assert.equal(specs.ram_max_gb, '64');
  assert.equal(specs.evil, undefined);
});

test('a probe that returns nothing usable yields null, never an empty record', () => {
  // The heartbeat omits the field entirely in this case, so the server keeps
  // the good specs it already had. Overwriting them with {} defeats the point.
  assert.equal(parseSpecsSummary(''), null);
  assert.equal(parseSpecsSummary('PowerShell exploded'), null);
  assert.equal(parseSpecsSummary(null), null);
});

test('sanitizeSpecs refuses to trust the wire', () => {
  // A worker is a machine that can be running edited code.
  assert.equal(sanitizeSpecs('16 GB'), null);
  assert.equal(sanitizeSpecs(['ram_gb']), null);
  assert.equal(sanitizeSpecs({ dropTable: 'x' }), null);
  const clean = sanitizeSpecs({ ram_gb: 16, cpu: 'x'.repeat(500), rogue: 'no' });
  assert.equal(clean.ram_gb, '16');
  assert.equal(clean.cpu.length, 120);
  assert.equal(clean.rogue, undefined);
});

test('describeRam says something useful from whatever survived', () => {
  assert.equal(
    describeRam({ ram_gb: '16', ram_type: 'DDR4', ram_modules: '2', ram_slots: '2', ram_max_gb: '64' }),
    '16 GB DDR4, 2 of 2 slots used, 64 GB board maximum');
  // Partial is still worth speaking when he is standing in a shop.
  assert.equal(describeRam({ ram_gb: '16' }), '16 GB');
  assert.equal(describeRam({ ram_gb: '16', ram_type: 'unknown' }), '16 GB');
  assert.equal(describeRam(null), null);
  assert.equal(describeRam({ cpu: 'no ram here' }), null);
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

// ── Worker capability: the verb-table deployment gap (2026-08-10) ───────────
// Shipping a verb in this repo does not ship it to the PC — the worker
// re-validates against its OWN copy of the table (correct: the job row is not
// a trust boundary). A worker that was never restarted refused harvest.list
// on every hourly dispatch for two days: 41 failed jobs manufactured for a
// condition only a human restart could clear. The worker now reports its verb
// list in heartbeats; workerKnowsVerb lets /pc/action refuse UP FRONT, with
// the remedy in the error, instead of enqueuing a job that can never succeed.

test('a worker that reports its verbs pins dispatch to them', () => {
  // The exact table the stale worker was running when it refused harvest.list:
  const staleWorker = { elevated: false, verbs: [
    'service.status', 'service.list', 'process.list', 'system.info', 'eventlog.errors',
    'service.restart', 'service.start', 'service.stop', 'process.kill', 'shell',
  ] };
  assert.equal(workerKnowsVerb(staleWorker, 'harvest.list'), false);
  assert.equal(workerKnowsVerb(staleWorker, 'system.info'), true);
  // Shipping system.specs in this repo does not put it on the PC: until the
  // worker is restarted it reports the older table and /pc/action refuses the
  // dispatch up front, with the restart as the remedy.
  assert.equal(workerKnowsVerb(staleWorker, 'system.specs'), false);
  // A current worker reports the full table and everything dispatches:
  const current = { elevated: false, verbs: Object.keys(VERBS) };
  for (const verb of Object.keys(VERBS)) {
    assert.equal(workerKnowsVerb(current, verb), true, verb);
  }
});

test('an older worker that reports no verb list gets the benefit of the doubt', () => {
  // Default-denying on missing data would turn this fix into an outage for
  // every un-updated worker; the worker-side refusal still backstops it.
  assert.equal(workerKnowsVerb(null, 'harvest.list'), true);
  assert.equal(workerKnowsVerb({ elevated: true }, 'harvest.list'), true);
  assert.equal(workerKnowsVerb({ verbs: 'not-an-array' }, 'harvest.list'), true);
});

// shell.read / shell split (2026-08-19, audit move 39).
//
// A question the verb table had no verb for used to become `shell`: staged,
// spoken as a mangled PowerShell one-liner (clipped at 200 chars), confirmed
// half-heard. Now a provably read-only pipeline runs instantly as `shell.read`;
// anything the validator cannot prove stays `shell`, gated, with the WHOLE
// command on the deck and a short spoken summary.
//
// The validator is deliberately conservative: a false negative costs a
// confirmation turn; a false positive runs a mutation unconfirmed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyShell, planAction } from '../src/lib/pc-actions.js';

const ok = (c) => assert.equal(isReadOnlyShell(c).ok, true, c);
const no = (c) => assert.equal(isReadOnlyShell(c).ok, false, c);

test('plain query pipelines are read-only', () => {
  ok('Get-Process');
  ok("Get-Service | Where-Object Status -eq 'Running' | Select-Object -First 5 Name");
  ok('Get-ChildItem C:\\dev -Recurse -Filter *.log | Measure-Object');
  ok('Get-Date');
  ok("Get-Content 'C:\\Users\\x\\notes.txt' | Select-Object -First 20");
  ok('Get-NetTCPConnection -State Listen | Sort-Object LocalPort | Format-Table -AutoSize');
  ok('Test-Path C:\\temp');
});

test('anything that could change the machine is refused', () => {
  no('Stop-Process -Name notepad');
  no('Get-Process | Stop-Process');
  no('Remove-Item C:\\x');
  no('Get-Service; Restart-Service Spooler');
  no('Get-Process | ForEach-Object { Stop-Process $_ }');
  no("Get-Process | Where-Object { kill $_.Id }");      // script block → aliases slip past verb lists
  no('Get-Process | Where-Object { $_.Name -eq "x" }');  // ANY script block is refused
  no('Get-Item x | % { (Get-Item x).Delete() }');
  no('(Get-Item C:\\x).Delete()');                         // method call
  no('Get-Content x > y');
  no('Get-Content x | Out-File y');
  no('Invoke-Expression "rm x"');
  no('iex "rm x"');
  no('& notepad.exe');
  no('Get-Process $(Remove-Item x)');
  no('[IO.File]::Delete("x")');
  no('$x = Get-Process');
  no('Get-Process `; Remove-Item x');
  no('Start-Process calc');
  no('New-Item x');
  no('Set-Content x y');
  no('powershell -c "rm x"');
  no("Get-Process\nRemove-Item x");
  no('gps');                                               // aliases are not provable
});

test('shell.read builds an instant read-only plan; shell stays gated', () => {
  const r = planAction('shell.read', { command: 'Get-Process | Select-Object -First 3 Name' });
  assert.equal(r.mutates, false);
  assert.match(r.script, /Out-String -Width 200$/);
  assert.throws(() => planAction('shell.read', { command: 'Remove-Item x' }), /not provably read-only/);
  const s = planAction('shell', { command: 'Remove-Item x' });
  assert.equal(s.mutates, true);
});

test('shell: the description carries the WHOLE command; the spoken form is a summary', () => {
  const long = Array.from({ length: 40 }, (_, i) => `Get-Item C:\\path\\number\\${i}`).join('\n');
  const p = planAction('shell', { command: long });
  assert.ok(p.description.includes(long), 'no 200-char clip');
  assert.match(p.speech, /run a 40-line PowerShell command on the PC, starting "Get-Item/);
  assert.match(p.speech, /the full command is on your screen/);
  assert.ok(p.speech.length < 200);
});

test('read-only verbs speak their description unchanged', () => {
  const p = planAction('system.info', {});
  assert.equal(p.speech, p.description);
});

// ── Spoken result (move 40): "Done, sir." no longer swallows the answer ─────
import { spokenPcResult } from '../src/lib/conversation.js';

test('short plain output is spoken as-is', () => {
  assert.equal(spokenPcResult('check the Spooler service', 'Status : Running'), 'Done, sir. Status : Running');
});
test('a table is summarised with a pointer to the screen', () => {
  const table = 'Name   Id CPU%\n----   -- ----\nchrome 12 8.1\ndwm    44 1.0';
  const s = spokenPcResult('sample the CPU', table);
  assert.match(s, /^Done, sir — sample the CPU\./);
  assert.match(s, /full result is on your screen/);
  assert.doesNotMatch(s, /----/);
});
test('a prose first line leads a long answer', () => {
  const long = 'Reboot pending: False\n' + Array.from({ length: 12 }, (_, i) => `KB50000${i}  Update  2026-08-0${i % 9}`).join('\n');
  const s = spokenPcResult('check Windows Update', long);
  assert.match(s, /Reboot pending: False — the full result is on your screen/);
});
test('no output at all still confirms the action', () => {
  assert.equal(spokenPcResult('restart the Spooler service', ''), 'Done, sir — restart the Spooler service.');
});

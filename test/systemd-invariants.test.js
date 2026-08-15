/**
 * Invariants over the systemd units in systemd/.
 *
 * These assert the RULE rather than the instance, because the audit of
 * 2026-08-15 found the same shape three times: a lesson learned, written into a
 * comment, applied to the units that existed that day — and the next unit added
 * never got it. Nine oneshots carried TimeoutStartSec and the tenth did not, and
 * the tenth was the database backup.
 *
 * A test that pins one file would have caught none of them. A test that pins the
 * rule catches the next one too.
 *
 * NOTE: drop-ins win over unit files on the real box (see CLAUDE.md), so a green
 * run here is necessary, not sufficient — verify limits with
 * `systemctl show <svc> -p TimeoutStartUSec`, never by reading a unit alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SYSTEMD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'systemd');

const units = readdirSync(SYSTEMD_DIR)
  .filter((f) => f.endsWith('.service'))
  .map((f) => ({ name: f, text: readFileSync(join(SYSTEMD_DIR, f), 'utf8') }));

const directives = (text) => text
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const has = (text, key) => directives(text).some((l) => l.startsWith(`${key}=`));
const valueOf = (text, key) => {
  const line = directives(text).find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
};
const isOneshot = (text) => valueOf(text, 'Type') === 'oneshot';

test('there are units to check (the glob did not silently match nothing)', () => {
  assert.ok(units.length >= 10, `expected the fleet's units, found ${units.length}`);
});

test('EVERY oneshot unit sets TimeoutStartSec explicitly', () => {
  // systemd's default for a oneshot is NO timeout. A hung ExecStart leaves the
  // unit in `activating` forever, and systemd then skips every subsequent timer
  // activation — the job stops running permanently while `list-timers` still
  // shows it scheduled and nothing goes red.
  //
  // This bit jarvis-fleet-check (2026-07-30) and was still live on
  // jarvis-backup.service until 2026-08-15, where it meant the SQLite backup
  // could stop forever after a tailnet partition mid-SSH-push.
  const missing = units
    .filter((u) => isOneshot(u.text))
    .filter((u) => !has(u.text, 'TimeoutStartSec'))
    .map((u) => u.name);

  assert.deepEqual(missing, [], `oneshot units with no TimeoutStartSec: ${missing.join(', ')}`);
});

test('every TimeoutStartSec is a plain positive integer of seconds', () => {
  // Guards against `TimeoutStartSec=0` (which means "no limit" in systemd, i.e.
  // the exact bug above wearing a disguise) and against `infinity`.
  for (const u of units) {
    const v = valueOf(u.text, 'TimeoutStartSec');
    if (v === null) continue;
    assert.match(v, /^\d+$/, `${u.name}: TimeoutStartSec=${v} should be bare seconds`);
    assert.ok(Number(v) > 0, `${u.name}: TimeoutStartSec=0 disables the timeout entirely`);
  }
});

test('a timer-driven oneshot is not also pulled in by multi-user.target', () => {
  // Anti-storm delays live on the timers (OnBootSec=25min on code-health,
  // 35min on fix-runner, with comments reading "a restart storm must not turn
  // into a dispatch storm"). An [Install] WantedBy=multi-user.target on the
  // SERVICE defeats that completely: once enabled, boot starts it immediately
  // and the timer's delay never applies.
  //
  // The four original oneshots correctly have no [Install]; five newer ones
  // carry it. Listed explicitly so that fixing them tightens this test rather
  // than leaving a hole for the next unit.
  const timerNames = new Set(
    readdirSync(SYSTEMD_DIR).filter((f) => f.endsWith('.timer')).map((f) => f.replace(/\.timer$/, '')),
  );

  const offenders = units
    .filter((u) => isOneshot(u.text))
    .filter((u) => timerNames.has(u.name.replace(/\.service$/, '')))
    .filter((u) => directives(u.text).some((l) => l === 'WantedBy=multi-user.target'))
    .map((u) => u.name);

  assert.deepEqual(
    offenders, [],
    'timer-driven oneshots must be pulled ONLY by their timer, so OnBootSec applies: ' + offenders.join(', '),
  );
});

test('every long-running service has the Rule 4 co-tenant limits', () => {
  // This box also runs AlecRae, Gluecron, GateTest and the Coolify stack.
  for (const u of units) {
    assert.ok(has(u.text, 'MemoryMax'), `${u.name}: no MemoryMax (Rule 4)`);
  }
});

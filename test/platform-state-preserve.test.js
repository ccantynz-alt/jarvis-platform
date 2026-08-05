/**
 * platform_state writes must not destroy columns they don't manage.
 *
 * This bug has now shipped FOUR times, each time as a fresh instance of the
 * same pattern rather than a new mistake:
 *   2026-07-23  last_audit / last_screenshot / consecutive_critical wiped by
 *               fleet-check.sh's 10-minute write (Vapron flip-flopping).
 *   2026-07-24  the same INSERT OR REPLACE in audit-runner.js wiped `notes`.
 *   2026-07-30  the 07-23 fix preserved the three columns it listed and left
 *               last_known_errors and health_score being zeroed by omission.
 *   2026-08-05  audit_fingerprint / audit_repeat, added to support audit repeat
 *               suppression, were nulled every 10 minutes — so the counter could
 *               never reach its threshold and the feature silently did nothing.
 *
 * The cause was never the individual omission. With INSERT OR REPLACE a column
 * is destroyed by NOT being named, so every column any other service adds later
 * is wiped by default, silently. memory-server.js now upserts, which touches
 * only the named columns; this test pins that property against the REAL SQL so
 * the next added column is covered without anyone remembering to come back
 * here.
 *
 * Runs the endpoint's statement against an in-memory DB rather than the live
 * service, which opens /opt/jarvis/memory/jarvis.db at import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

let Database = null;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (e) {
  // Dev checkouts have no node_modules; skip loudly rather than fail.
  console.warn(`[platform-state-preserve.test] skipped — better-sqlite3 unavailable (${e.code || e.message})`);
}
const it = Database ? test : test.skip;

// Verbatim from src/memory-server.js's POST /memory/platform/update.
const UPSERT = `
  INSERT INTO platform_state (platform, status, last_known_errors, health_score, notes, updated_at)
  VALUES (@platform, COALESCE(@status, 'unknown'), @last_known_errors, COALESCE(@health_score, 0), @notes, @updated_at)
  ON CONFLICT(platform) DO UPDATE SET
    status            = COALESCE(@status,            platform_state.status),
    last_known_errors = COALESCE(@last_known_errors, platform_state.last_known_errors),
    health_score      = COALESCE(@health_score,      platform_state.health_score),
    notes             = COALESCE(@notes,             platform_state.notes),
    updated_at        = @updated_at
`;

function freshDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE platform_state (
      platform TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_known_errors TEXT,
      last_audit TEXT,
      last_screenshot TEXT,
      health_score INTEGER DEFAULT 0,
      notes TEXT,
      updated_at TEXT NOT NULL
    );
  `);
  db.exec('ALTER TABLE platform_state ADD COLUMN consecutive_critical INTEGER DEFAULT 0');
  db.exec('ALTER TABLE platform_state ADD COLUMN audit_fingerprint TEXT');
  db.exec('ALTER TABLE platform_state ADD COLUMN audit_repeat INTEGER DEFAULT 0');
  return db;
}

/** One call to the endpoint, with only the fields a caller actually sent. */
function update(db, fields) {
  db.prepare(UPSERT).run({
    platform: fields.platform,
    status: fields.status ?? null,
    last_known_errors: fields.last_known_errors === undefined || fields.last_known_errors === null
      ? null : JSON.stringify(fields.last_known_errors),
    health_score: fields.health_score ?? null,
    notes: fields.notes ?? null,
    updated_at: fields.updated_at ?? '2026-08-05T00:00:00.000Z',
  });
}

const row = (db, p) => db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(p);

/** Everything audit-runner.js owns on this row. */
function seedAuditColumns(db) {
  db.prepare(`
    INSERT INTO platform_state
      (platform, status, last_known_errors, last_audit, last_screenshot, health_score,
       consecutive_critical, notes, audit_fingerprint, audit_repeat, updated_at)
    VALUES ('vapron', 'critical', '["HTTP: x"]', '2026-08-04T18:00:00Z', '/shots/v.png', 50,
            3, 'a note', 'critical|50|HTTP: x', 7, '2026-08-04T18:00:00Z')
  `).run();
}

it('THE 2026-08-05 BUG: a fleet-check write does not reset the audit repeat counter', () => {
  const db = freshDb();
  seedAuditColumns(db);
  // Exactly what fleet-check.sh posts every 10 minutes: status + health_score.
  update(db, { platform: 'vapron', status: 'healthy', health_score: 95 });
  const r = row(db, 'vapron');
  assert.equal(r.audit_repeat, 7, 'repeat counter survived');
  assert.equal(r.audit_fingerprint, 'critical|50|HTTP: x', 'fingerprint survived');
});

it('the three earlier regressions stay fixed in the same write', () => {
  const db = freshDb();
  seedAuditColumns(db);
  update(db, { platform: 'vapron', status: 'healthy', health_score: 95 });
  const r = row(db, 'vapron');
  assert.equal(r.last_audit, '2026-08-04T18:00:00Z');       // 2026-07-23
  assert.equal(r.last_screenshot, '/shots/v.png');           // 2026-07-23
  assert.equal(r.consecutive_critical, 3);                   // 2026-07-23
  assert.equal(r.notes, 'a note');                           // 2026-07-24
  assert.equal(r.last_known_errors, '["HTTP: x"]');          // 2026-07-30
});

it("orchestrator's status-and-notes-only write does not zero health_score", () => {
  const db = freshDb();
  seedAuditColumns(db);
  update(db, { platform: 'vapron', status: 'healthy', notes: 'job done' });
  const r = row(db, 'vapron');
  assert.equal(r.health_score, 50, 'health_score untouched');  // the 2026-07-30 case
  assert.equal(r.notes, 'job done');
});

it('an explicit 0 or [] still writes — omission and zero are different', () => {
  const db = freshDb();
  seedAuditColumns(db);
  update(db, { platform: 'vapron', health_score: 0, last_known_errors: [] });
  const r = row(db, 'vapron');
  assert.equal(r.health_score, 0);
  assert.equal(r.last_known_errors, '[]');
});

it('a brand-new platform inserts with sane defaults, NOT NULL included', () => {
  const db = freshDb();
  update(db, { platform: 'newthing' });
  const r = row(db, 'newthing');
  assert.equal(r.status, 'unknown', 'NOT NULL status defaulted rather than throwing');
  assert.equal(r.health_score, 0);
  assert.equal(r.audit_repeat, 0);
  assert.equal(r.audit_fingerprint, null);
});

it('a new row created with a real status keeps it', () => {
  const db = freshDb();
  update(db, { platform: 'newthing', status: 'error', health_score: 10 });
  const r = row(db, 'newthing');
  assert.equal(r.status, 'error');
  assert.equal(r.health_score, 10);
});

it('a status-less update never overwrites a real status with "unknown"', () => {
  // The trap in using excluded.status: the INSERT half has to spell out
  // 'unknown' for the NOT NULL column, and excluded.* would then carry it into
  // the UPDATE half.
  const db = freshDb();
  update(db, { platform: 'vapron', status: 'error' });
  update(db, { platform: 'vapron', health_score: 42 });
  const r = row(db, 'vapron');
  assert.equal(r.status, 'error');
  assert.equal(r.health_score, 42);
});

it('updated_at always advances, even when nothing else is sent', () => {
  const db = freshDb();
  seedAuditColumns(db);
  update(db, { platform: 'vapron', updated_at: '2026-08-05T09:00:00.000Z' });
  assert.equal(row(db, 'vapron').updated_at, '2026-08-05T09:00:00.000Z');
});

it('a column added LATER by another service survives without touching this SQL', () => {
  // The actual property being pinned: this is what failed four times.
  const db = freshDb();
  db.exec("ALTER TABLE platform_state ADD COLUMN some_future_column TEXT DEFAULT 'keep me'");
  seedAuditColumns(db);
  db.prepare("UPDATE platform_state SET some_future_column = 'set by another service' WHERE platform = 'vapron'").run();
  update(db, { platform: 'vapron', status: 'healthy', health_score: 95 });
  assert.equal(row(db, 'vapron').some_future_column, 'set by another service');
});

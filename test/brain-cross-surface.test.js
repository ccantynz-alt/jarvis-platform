// Cross-surface continuity (2026-08-19, audit move 15).
//
// The deck and gateway each hold their own warm SDK session; a turn spoken on
// one is invisible to the other's live context and only reaches the shared KV
// transcript. missedSinceLastReply injects just the turns another surface
// interleaved since this warm session last replied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { missedSinceLastReply } from '../src/lib/transcript.js';

const u = (c) => ({ role: 'user', content: c });
const a = (c) => ({ role: 'assistant', content: c });

test('nothing to bridge when the session has not replied yet', () => {
  assert.equal(missedSinceLastReply([u('hi'), a('hello')], {}), '');
});

test('nothing to bridge when this session produced the last reply and the only new thing is the current turn', () => {
  const t = [u('hi'), a('hello, sir'), u('what time is it')];   // current user turn is last
  assert.equal(missedSinceLastReply(t, { lastReply: 'hello, sir' }), '');
});

test('THE CASE: turns from another surface since our last reply are bridged in', () => {
  const t = [
    a('hello, sir'),                 // our last reply
    u('remind me to call the bank'), // said on the OTHER device
    a('Done, I will remind you.'),   // the other surface answered
    u('did you set that reminder'),  // current turn (this surface), last entry
  ];
  const s = { lastReply: 'hello, sir' };
  const out = missedSinceLastReply(t, s);
  assert.match(out, /CRAIG: remind me to call the bank/);
  assert.match(out, /YOU: Done, I will remind you\./);
  assert.match(out, /do not mention this note/);
});

test('a watermark that cannot be found injects nothing (never worse than before)', () => {
  const t = [u('a'), a('b'), u('c')];
  assert.equal(missedSinceLastReply(t, { lastReply: 'not in here' }), '');
});

test('long interleaved messages are bounded', () => {
  const t = [a('base'), u('x'.repeat(500)), u('current')];
  const out = missedSinceLastReply(t, { lastReply: 'base' });
  assert.ok(out.includes('CRAIG: ' + 'x'.repeat(200)));
  assert.ok(!out.includes('x'.repeat(220)));
});

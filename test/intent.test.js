import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIntent, matchPlatform, normalizeText } from '../src/intent.js';

const PLATFORMS = ['zoobicon', 'vapron', 'bookaride', 'gatetest', 'alecrae', 'jarvis', 'voxlen', 'gluecron'];

test('normalizeText strips the "hey jarvis" address prefix', () => {
  assert.equal(normalizeText('hey jarvis, fix the header on zoobicon'), 'fix the header on zoobicon');
  assert.equal(normalizeText('Jarvis: status'), 'status');
  assert.equal(normalizeText('ok jarvis restart vapron'), 'restart vapron');
});

test('normalizeText strips stacked polite prefixes', () => {
  assert.equal(normalizeText('please can you fix the login on vapron'), 'fix the login on vapron');
  assert.equal(normalizeText('can you please just repair bookaride'), 'repair bookaride');
});

test('"can you fix X" is a dispatch, not a question', () => {
  const intent = detectIntent('can you fix the signup flow on vapron', PLATFORMS);
  assert.equal(intent.type, 'dispatch');
  assert.equal(intent.platform, 'vapron');
  assert.equal(intent.confident, true);
});

test('"hey jarvis ..." does not route to the jarvis platform', () => {
  const intent = detectIntent('hey jarvis, repair the booking page on bookaride', PLATFORMS);
  assert.equal(intent.type, 'dispatch');
  assert.equal(intent.platform, 'bookaride');
});

test('"jarvis status" is a general status query', () => {
  const intent = detectIntent('jarvis status', PLATFORMS);
  assert.equal(intent.type, 'status');
  assert.equal(intent.confident, true);
});

test('asking about the jarvis platform explicitly still works', () => {
  const intent = detectIntent('how is jarvis doing', PLATFORMS);
  assert.equal(intent.type, 'platform-status');
  assert.equal(intent.platform, 'jarvis');
});

test('unrecognized text is unclear — never auto-dispatched', () => {
  const intent = detectIntent('the weather in auckland looks rough today', PLATFORMS);
  assert.equal(intent.type, 'unclear');
});

test('mute intents', () => {
  assert.equal(detectIntent('mute', PLATFORMS).type, 'mute');
  assert.equal(detectIntent('jarvis mute 2h', PLATFORMS).type, 'mute');
  assert.equal(detectIntent('stop sending me notifications', PLATFORMS).type, 'mute');
  assert.equal(detectIntent('jarvis shut up', PLATFORMS).type, 'mute');
  const all = detectIntent('mute all', PLATFORMS);
  assert.equal(all.type, 'mute');
  assert.equal(all.all, true);
});

test('unmute / digest / notifications intents', () => {
  assert.equal(detectIntent('unmute', PLATFORMS).type, 'unmute');
  assert.equal(detectIntent('notifications on', PLATFORMS).type, 'unmute');
  assert.equal(detectIntent('digest', PLATFORMS).type, 'digest');
  assert.equal(detectIntent('notifications', PLATFORMS).type, 'notif-status');
});

test('ask still extracts the question', () => {
  const intent = detectIntent('ask jarvis what broke on vapron this week', PLATFORMS);
  assert.equal(intent.type, 'ask');
  assert.equal(intent.question, 'what broke on vapron this week');
});

test('jobs / briefing / help unchanged', () => {
  assert.equal(detectIntent("what's running", PLATFORMS).type, 'jobs');
  assert.equal(detectIntent('briefing', PLATFORMS).type, 'briefing');
  assert.equal(detectIntent('help', PLATFORMS).type, 'help');
});

test('matchPlatform: 4-char false positives are gone', () => {
  // "booking" used to prefix-match bookaride, "gateway" used to match gatetest
  assert.equal(matchPlatform('fix the booking page', PLATFORMS), null);
  assert.equal(matchPlatform('the gateway timed out', PLATFORMS), null);
  // 5-char prefixes still help with typos/shorthand
  assert.equal(matchPlatform('check zoobi homepage', PLATFORMS), 'zoobicon');
});

test('dispatch verb mid-sentence is low-confidence (Haiku takes a look)', () => {
  const intent = detectIntent('the header on zoobicon needs someone to fix it soon', PLATFORMS);
  assert.equal(intent.type, 'dispatch');
  assert.equal(intent.confident, false);
});

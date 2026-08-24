import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STAGES, newBuildState, nextStage, applyStageResult, resume, validateSlug, describe as describeState,
} from '../src/lib/build-pipeline.js';

const fresh = () => newBuildState({ slug: 'demo-site', brief: 'A demo marketing site for testing.' });

test('slug rules: DNS-label + registry-key safe', () => {
  assert.equal(validateSlug('demo-site'), null);
  for (const bad of ['ab', 'UPPER', '1starts-digit', 'has--double', 'ends-', 'way-too-long-for-a-slug-name-limit-x', 'has_underscore']) {
    assert.ok(validateSlug(bad), `expected rejection: ${bad}`);
  }
});

test('stages run strictly in order and finish done', () => {
  let s = fresh();
  for (const stage of STAGES) {
    assert.equal(nextStage(s), stage);
    const result = stage === 'deploy' ? { slug: 'demo-site', status: 'live' }
      : stage === 'build' ? { files: { 'index.html': 'x' } }
      : stage === 'verify' ? { httpStatus: 200 }
      : { ok: true };
    s = applyStageResult(s, stage, { ok: true, result });
  }
  assert.equal(s.status, 'done');
  assert.equal(nextStage(s), null);
  assert.match(describeState(s), /demo-site\.vapron\.app/);
});

test('pause is resumable and re-runs the SAME stage', () => {
  // The real case: no GLUECRON_PAT yet — repo stage pauses AFTER the build
  // succeeded; when the PAT arrives the pipeline resumes at repo with the
  // built site kept, not from scratch.
  let s = fresh();
  s = applyStageResult(s, 'plan', { ok: true, result: {} });
  s = applyStageResult(s, 'build', { ok: true, result: { files: { 'index.html': 'x' } } });
  s = applyStageResult(s, 'repo', { ok: false, pause: 'GLUECRON_PAT not set' });
  assert.equal(s.status, 'paused');
  assert.match(s.pausedReason, /GLUECRON_PAT/);
  assert.equal(nextStage(s), null);          // paused pipelines run nothing
  s = resume(s);
  assert.equal(nextStage(s), 'repo');        // same stage, prior work kept
  assert.equal(s.stages.build.status, 'done');
});

test('a MOCKED build result is a hard failure, never an advance', () => {
  // Zoobicon's pushToVapron returns { mocked: true } with a plausible URL
  // when its key is unset — the pipeline must treat that as a lie.
  let s = fresh();
  s = applyStageResult(s, 'plan', { ok: true, result: {} });
  s = applyStageResult(s, 'repo', { ok: true, result: {} });
  s = applyStageResult(s, 'build', { ok: true, result: { mocked: true, files: { 'index.html': 'x' } } });
  assert.equal(s.status, 'failed');
  assert.match(s.stages.build.error, /MOCKED/);
});

test('a build with no files cannot advance', () => {
  let s = fresh();
  s = applyStageResult(s, 'plan', { ok: true, result: {} });
  s = applyStageResult(s, 'repo', { ok: true, result: {} });
  s = applyStageResult(s, 'build', { ok: true, result: { files: {} } });
  assert.equal(s.status, 'failed');
});

test('deploy at the wrong slug fails loudly — the -suffix trap', () => {
  // Vapron appends -abc123 when the name is taken: the deploy "succeeds"
  // at a URL nobody asked for. Recon caveat, pinned here.
  let s = fresh();
  for (const st of ['plan', 'repo', 'push']) s = applyStageResult(s, st, { ok: true, result: {} });
  s = applyStageResult(s, 'build', { ok: true, result: { files: { 'index.html': 'x' } } });
  s = applyStageResult(s, 'deploy', { ok: true, result: { slug: 'demo-site-a1b2c3', status: 'live' } });
  assert.equal(s.status, 'failed');
  assert.match(s.stages.deploy.error, /demo-site\.vapron\.app/);
});

test('a non-live deployment status is a failure even when the executor said ok', () => {
  let s = fresh();
  for (const st of ['plan', 'repo', 'push']) s = applyStageResult(s, st, { ok: true, result: {} });
  s = applyStageResult(s, 'build', { ok: true, result: { files: { 'index.html': 'x' } } });
  s = applyStageResult(s, 'deploy', { ok: true, result: { slug: 'demo-site', status: 'failed' } });
  assert.equal(s.status, 'failed');
});

test('verify demands a serving HTTP status — Rule 2 in code', () => {
  let s = fresh();
  for (const st of ['plan', 'repo', 'push', 'register']) s = applyStageResult(s, st, { ok: true, result: {} });
  s = applyStageResult(s, 'build', { ok: true, result: { files: { 'index.html': 'x' } } });
  s = applyStageResult(s, 'deploy', { ok: true, result: { slug: 'demo-site', status: 'live' } });
  s = applyStageResult(s, 'verify', { ok: true, result: { httpStatus: 503 } });
  assert.equal(s.status, 'failed');
});

test('an executor returning nothing is a failure, not a success', () => {
  let s = fresh();
  s = applyStageResult(s, 'plan', undefined);
  assert.equal(s.status, 'failed');
  assert.match(s.stages.plan.error, /no outcome/);
});

test('state is never mutated in place — resume/apply return new objects', () => {
  const s = fresh();
  const s2 = applyStageResult(s, 'plan', { ok: true, result: {} });
  assert.equal(s.stages.plan.status, 'pending');
  assert.equal(s2.stages.plan.status, 'done');
});

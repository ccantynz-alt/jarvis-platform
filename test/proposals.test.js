// test/proposals.test.js — the review gate between an agent and the world.
//
// 2026-08-05. The org had 7 officers and 44 agents with reports routing upward,
// and nothing whatsoever sitting between an agent's action and that action
// taking effect. A repair agent dispatched for a one-line merge defect in
// gluecron committed 1,028 lines across 9 files instead, exited 0, and pushed.
// The guardrails deciding WHICH work to start were fine; there was no gate on
// what came back.
//
// These tests are the control. Separation of duties and the
// never-agent-approved classes are the two properties an acquirer's diligence
// actually asks about, so both are pinned in both directions.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOMAINS, STATES, RISK_LEVELS, ALWAYS_HUMAN,
  requiresHuman, canTransition, validateProposal, auditEntry, describeDecision,
} from '../src/lib/proposals.js';

const CRAIG = { id: 'craig', kind: 'human' };
const CTO   = { id: 'cto', kind: 'agent' };
const MEDIC = { id: 'site-medic-gluecron', kind: 'agent' };

const p = (over = {}) => ({
  id: 1, domain: 'cto', status: 'under_review',
  title: 'Fix blind force-move in performMerge',
  rationale: 'A second auto-merge discards the first merge\'s commits',
  evidence: 'src/lib/pr-merge.ts:123 runs git update-ref with no old-value arg',
  change_class: 'code_fix', risk: 'medium',
  created_by: 'site-medic-gluecron', reviewed_by: null, ...over,
});

// ── separation of duties ────────────────────────────────────────────────────

test('THE CONTROL: an agent cannot decide its own proposal', () => {
  for (const next of ['approved', 'rejected', 'escalated']) {
    const r = canTransition(p(), next, MEDIC);
    assert.equal(r.allowed, false, next);
    assert.match(r.reason, /separation of duties/);
  }
});

test('a different agent — the domain officer — can', () => {
  assert.equal(canTransition(p(), 'approved', CTO).allowed, true);
});

test('an officer cannot decide another domain\'s proposals', () => {
  const r = canTransition(p({ domain: 'cfo' }), 'approved', CTO);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /only cfo may decide/);
});

test('Craig may decide anything, including his own', () => {
  assert.equal(canTransition(p({ created_by: 'craig' }), 'approved', CRAIG).allowed, true);
});

test('every transition must name an actor', () => {
  assert.equal(canTransition(p(), 'approved', {}).allowed, false);
});

// ── beyond an agent's authority ─────────────────────────────────────────────

test('no agent may approve a payment, credential, filing, publication, data or infra change', () => {
  for (const cls of ALWAYS_HUMAN) {
    const prop = p({ change_class: cls, risk: 'low' });
    const r = canTransition(prop, 'approved', CTO);
    assert.equal(r.allowed, false, cls);
    assert.match(r.reason, /escalate instead/);
    // ...but escalating it is exactly what it should do.
    assert.equal(canTransition(prop, 'escalated', CTO).allowed, true, cls);
  }
});

test('Craig can approve what an agent cannot', () => {
  assert.equal(canTransition(p({ change_class: 'payment', status: 'escalated' }), 'approved', CRAIG).allowed, true);
});

test('high risk is never agent-approved regardless of class', () => {
  assert.equal(requiresHuman({ change_class: 'code_fix', risk: 'high' }).required, true);
  assert.equal(canTransition(p({ risk: 'high' }), 'approved', CTO).allowed, false);
});

test('an unrecognised risk resolves UP to human, never down to low', () => {
  // Suppression by ambiguity is the failure mode; being noisy is survivable.
  for (const risk of [undefined, null, '', 'unknown', 'spicy', 0]) {
    assert.equal(requiresHuman({ change_class: 'code_fix', risk }).required, true, String(risk));
  }
});

test('ordinary low/medium code fixes ARE agent-approvable — the gate is not a wall', () => {
  // A control that blocks everything gets switched off. This must stay true.
  assert.equal(requiresHuman({ change_class: 'code_fix', risk: 'low' }).required, false);
  assert.equal(canTransition(p({ risk: 'low' }), 'approved', CTO).allowed, true);
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test('only legal edges are walkable', () => {
  assert.equal(canTransition(p({ status: 'draft' }), 'approved', CTO).allowed, false);
  assert.equal(canTransition(p({ status: 'proposed' }), 'executed', CTO).allowed, false);
  assert.equal(canTransition(p({ status: 'rejected' }), 'approved', CRAIG).allowed, false);
  assert.equal(canTransition(p({ status: 'executed' }), 'proposed', CRAIG).allowed, false);
});

test('execution requires a recorded approval', () => {
  const r = canTransition(p({ status: 'approved', reviewed_by: null }), 'executed', CTO);
  assert.equal(r.allowed, false);
  assert.match(r.reason, /requires a recorded approval/);
  assert.equal(canTransition(p({ status: 'approved', reviewed_by: 'cto' }), 'executed', CTO).allowed, true);
});

test('an escalated proposal cannot be talked back down by an agent', () => {
  const esc = p({ status: 'escalated', change_class: 'code_fix', risk: 'low' });
  assert.equal(canTransition(esc, 'approved', CTO).allowed, false);
  assert.equal(canTransition(esc, 'approved', CRAIG).allowed, true);
});

test('a failed execution may be re-proposed, a rejected one may not', () => {
  assert.equal(canTransition(p({ status: 'failed' }), 'proposed', MEDIC).allowed, true);
  assert.equal(canTransition(p({ status: 'rejected' }), 'proposed', MEDIC).allowed, false);
});

test('a malformed proposal is refused rather than throwing', () => {
  assert.equal(canTransition(null, 'approved', CTO).allowed, false);
  assert.equal(canTransition(p({ status: 'nonsense' }), 'approved', CTO).allowed, false);
  assert.equal(canTransition(p(), 'nonsense', CTO).allowed, false);
});

// ── reviewability ───────────────────────────────────────────────────────────

test('a proposal without evidence or rationale is not reviewable', () => {
  const r = validateProposal({ domain: 'cto', title: 'fix it', created_by: 'x', change_class: 'code_fix', risk: 'low' });
  assert.equal(r.valid, false);
  assert.ok(r.missing.some(m => m.startsWith('rationale')));
  assert.ok(r.missing.some(m => m.startsWith('evidence')));
});

test('a complete proposal validates', () => {
  assert.equal(validateProposal(p()).valid, true);
});

test('an unknown domain is refused', () => {
  assert.equal(validateProposal(p({ domain: 'cxo' })).valid, false);
});

test('all six officers from the org chart are wired', () => {
  assert.deepEqual(Object.keys(DOMAINS).sort(), ['cfo', 'clo', 'cmo', 'coo', 'cro', 'cto']);
  for (const d of Object.keys(DOMAINS)) assert.equal(validateProposal(p({ domain: d })).valid, true);
});

// ── audit trail ─────────────────────────────────────────────────────────────

test('an audit entry records who, what, and when — enough to answer diligence', () => {
  const e = auditEntry({
    proposal: p({ id: 7 }), from: 'under_review', to: 'approved',
    actor: CTO, notes: 'diff matches the finding', at: '2026-08-05T12:00:00Z',
  });
  assert.deepEqual(e, {
    proposal_id: 7, from_status: 'under_review', to_status: 'approved',
    actor_id: 'cto', actor_kind: 'agent', notes: 'diff matches the finding',
    at: '2026-08-05T12:00:00Z',
  });
});

test('decisions describe themselves in one readable line', () => {
  assert.match(describeDecision(p({ status: 'approved', reviewed_by: 'cto', review_notes: 'scoped' })), /approved by cto — scoped/);
  assert.match(describeDecision(p({ status: 'escalated' })), /escalated to Craig/);
  assert.match(describeDecision(p({ status: 'proposed' })), /awaiting cto/);
});

test('every declared state is actually reachable from draft', () => {
  // Guards against adding a state to STATES and forgetting to wire an edge to
  // it — an unreachable state is dead code that reads like a feature. Walks the
  // real transition table through canTransition rather than a copy of it, so
  // this cannot pass while the implementation says otherwise.
  const seen = new Set(['draft']);
  const queue = ['draft'];
  while (queue.length) {
    const from = queue.shift();
    for (const to of STATES) {
      if (seen.has(to)) continue;
      // Craig, on a benign proposal: the most permissive actor there is. If an
      // edge is not walkable by him it is not walkable at all.
      const prop = p({ status: from, change_class: 'code_fix', risk: 'low', reviewed_by: 'cto' });
      if (canTransition(prop, to, CRAIG).allowed) { seen.add(to); queue.push(to); }
    }
  }
  const unreachable = STATES.filter(s => !seen.has(s));
  assert.deepEqual(unreachable, [], `unreachable states: ${unreachable.join(', ')}`);
});

test('RISK_LEVELS and requiresHuman agree on what exists', () => {
  for (const r of RISK_LEVELS) {
    // Every declared level must be a level requiresHuman actually recognises,
    // or the "unknown resolves up" rule would silently catch a valid one.
    const req = requiresHuman({ change_class: 'code_fix', risk: r }).required;
    assert.equal(req, r === 'high', r);
  }
});

// ── The deck's APPROVE/REJECT buttons could never work ──────────────────────
// 2026-08-07 finding. POST /api/ops/review forwarded {to:'approved',
// actor_kind:'human'} straight to the transition endpoint, but TRANSITIONS
// .proposed is ['under_review','withdrawn'] — no edge to any verdict. Every
// open proposal sat at 'proposed' (REVIEW_RUNNER_MODE=dry-run never transitions
// anything), so Craig armed the button, tapped CONFIRM, and got 409 REFUSED
// for every proposal in the queue. The deck now picks a proposal up into
// 'under_review' first, which is why this two-step must keep working.


test('a human verdict straight from proposed is still refused — the gate is unchanged', () => {
  for (const to of ['approved', 'rejected', 'escalated']) {
    assert.equal(canTransition({ status: 'proposed' }, to, CRAIG).allowed, false,
      `proposed → ${to} must not be a legal edge`);
  }
});

test('the deck\'s two-step walks a human decision from proposed to approved', () => {
  const pickup = canTransition({ status: 'proposed' }, 'under_review', CRAIG);
  assert.equal(pickup.allowed, true, 'Craig must be able to pick a proposal up');
  const verdict = canTransition({ status: 'under_review' }, 'approved', CRAIG);
  assert.equal(verdict.allowed, true, 'and then decide it');
});

test('the same two-step works for reject and escalate', () => {
  for (const to of ['rejected', 'escalated']) {
    assert.equal(canTransition({ status: 'under_review' }, to, CRAIG).allowed, true, to);
  }
});

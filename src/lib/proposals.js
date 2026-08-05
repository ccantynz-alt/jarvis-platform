/**
 * Jarvis governance — src/lib/proposals.js
 *
 * ONE review mechanism, shared by every officer in the org
 * (Craig, 2026-08-05: the CTO/COO/CFO/CLO/CMO/CRO hierarchy, each with a REVIEW
 * gate; "this needs to be built for production and acquisition later down the
 * track").
 *
 * The org already existed — 7 officers, 44 agents, reports routing upward. What
 * did not exist was anything sitting BETWEEN an agent's action and that action
 * taking effect. Reports flowed up; approvals never came down. The cost of that
 * was demonstrated on 2026-08-05: a repair agent dispatched for a one-line merge
 * defect in gluecron instead committed a 1,028-line feature across 9 files,
 * exited 0, and pushed. Nothing was wrong with the guardrails deciding WHICH
 * work to start; there was simply no gate on what came back.
 *
 * The model, and why each part is load-bearing:
 *
 *   PROPOSE   an agent describes a change and attaches evidence. It does not
 *             apply it. The artifact for a code change is a PULL REQUEST, never
 *             a push to a default branch.
 *   REVIEW    a DIFFERENT agent — the domain's officer — judges it against the
 *             stated rationale. Separation of duties is enforced here in code,
 *             not by convention: `proposer !== reviewer` is checked on every
 *             transition, because a reviewer that can be the proposer is not a
 *             control, it is paperwork.
 *   DECIDE    approve, reject, or escalate to Craig. Anything the risk rules
 *             classify as high — money movement, credentials, production data,
 *             legal filings, anything irreversible — cannot be approved by an
 *             agent at all and escalates by construction.
 *   EXECUTE   only an approved proposal may act, and only once. The execution
 *             is recorded against the approval that authorised it.
 *
 * Every transition is appended to an immutable trail. That is not decoration:
 * an acquirer's technical due diligence asks "who approved this change, on what
 * basis, and can you show me" — and the honest answer has to be a query, not a
 * story.
 *
 * Pure functions only — no I/O, no clock, no randomness. The store lives in
 * memory-server; the officers live in the agent scheduler. Tests:
 * test/proposals.test.js.
 */

/** The six domains from the org chart, plus the office that owns each. */
export const DOMAINS = {
  cto: { officer: 'cto', scope: 'dispatch, builds, deploys' },
  coo: { officer: 'coo', scope: 'self-heal, backups, fleet' },
  cfo: { officer: 'cfo', scope: 'ledgers, filings, budgets' },
  clo: { officer: 'clo', scope: 'contracts, compliance, filings' },
  cmo: { officer: 'cmo', scope: 'social, SEO, campaigns' },
  cro: { officer: 'cro', scope: 'monitoring, audits, intel' },
};

/**
 * Lifecycle. `escalated` is a terminal state for the AGENT org — it means the
 * decision has left the machines and is Craig's. He resolves it to approved or
 * rejected, which is why those edges exist from `escalated`.
 */
export const STATES = ['draft', 'proposed', 'under_review', 'approved', 'rejected', 'escalated', 'executed', 'failed', 'withdrawn'];

const TRANSITIONS = {
  draft:        ['proposed', 'withdrawn'],
  proposed:     ['under_review', 'withdrawn'],
  under_review: ['approved', 'rejected', 'escalated'],
  escalated:    ['approved', 'rejected'],   // Craig only — see requiresHuman()
  approved:     ['executed', 'failed', 'withdrawn'],
  rejected:     [],
  executed:     [],
  failed:       ['proposed'],               // a failed execution may be re-proposed
  withdrawn:    [],
};

export const RISK_LEVELS = ['low', 'medium', 'high'];

/**
 * Change classes an agent may never approve, whatever the domain. Each is
 * irreversible, externally visible, or moves money — the three properties that
 * make "an agent said it was fine" an unacceptable audit answer.
 */
export const ALWAYS_HUMAN = new Set([
  'payment',          // moving funds, refunds, payouts
  'credential',       // keys, tokens, access grants
  'legal_filing',     // anything filed with a registry or authority
  'production_data',  // deleting or migrating customer data
  'public_content',   // anything published under a brand
  'infrastructure',   // DNS, domains, hosting, certificates
]);

/**
 * Is this proposal beyond an agent's authority?
 * High risk OR a listed change class → Craig decides, full stop.
 */
export function requiresHuman(proposal = {}) {
  if (ALWAYS_HUMAN.has(proposal.change_class)) {
    return { required: true, reason: `${proposal.change_class} changes are never agent-approved` };
  }
  if (proposal.risk === 'high') {
    return { required: true, reason: 'high-risk changes are never agent-approved' };
  }
  // An unrecognised risk is not quietly treated as low. Unknown means unknown,
  // and unknown goes to a human.
  if (!RISK_LEVELS.includes(proposal.risk)) {
    return { required: true, reason: `unrecognised risk ${JSON.stringify(proposal.risk)} — treated as high` };
  }
  return { required: false, reason: '' };
}

/**
 * May this transition happen, by this actor, right now?
 *
 * @param {object} proposal          current row
 * @param {string} next              desired state
 * @param {object} actor             {id, kind: 'agent'|'human', domain?}
 * @returns {{allowed: boolean, reason: string}}
 */
export function canTransition(proposal, next, actor = {}) {
  if (!proposal || !STATES.includes(proposal.status)) {
    return { allowed: false, reason: 'proposal has no valid current state' };
  }
  if (!STATES.includes(next)) return { allowed: false, reason: `unknown state ${next}` };

  const legal = TRANSITIONS[proposal.status] || [];
  if (!legal.includes(next)) {
    return { allowed: false, reason: `cannot go ${proposal.status} → ${next}` };
  }
  if (!actor.id) return { allowed: false, reason: 'every transition must name an actor' };

  const isDecision = ['approved', 'rejected', 'escalated'].includes(next);

  // SEPARATION OF DUTIES. The single most important line in this file: an agent
  // may not review its own work. Enforced in code because a convention that is
  // not enforced is not a control.
  if (isDecision && actor.kind === 'agent' && actor.id === proposal.created_by) {
    return { allowed: false, reason: 'separation of duties: the proposer cannot decide its own proposal' };
  }

  // Only the owning officer (or Craig) may decide a domain's proposals.
  if (isDecision && actor.kind === 'agent') {
    const owner = DOMAINS[proposal.domain]?.officer;
    if (!owner) return { allowed: false, reason: `proposal has no known domain (${proposal.domain})` };
    if (actor.id !== owner) {
      return { allowed: false, reason: `only ${owner} may decide ${proposal.domain} proposals` };
    }
  }

  // Beyond-authority proposals: an agent may escalate them, never approve them.
  if (next === 'approved' && actor.kind === 'agent') {
    const h = requiresHuman(proposal);
    if (h.required) return { allowed: false, reason: `${h.reason} — escalate instead` };
  }

  // Leaving `escalated` is Craig's alone; an agent must not talk it back down.
  if (proposal.status === 'escalated' && actor.kind !== 'human') {
    return { allowed: false, reason: 'an escalated proposal is resolved by Craig, not by an agent' };
  }

  // Execution requires a recorded approval — you cannot execute what nobody approved.
  if (next === 'executed' && !proposal.reviewed_by) {
    return { allowed: false, reason: 'execution requires a recorded approval' };
  }
  return { allowed: true, reason: '' };
}

/**
 * A proposal is only reviewable if it says enough to be judged. A reviewer
 * cannot form a real opinion from a title alone, and an approval granted
 * without evidence is the paperwork failure this whole layer exists to prevent.
 */
export function validateProposal(p = {}) {
  const missing = [];
  if (!p.domain || !DOMAINS[p.domain]) missing.push('domain (one of ' + Object.keys(DOMAINS).join('/') + ')');
  if (!p.title) missing.push('title');
  if (!p.rationale) missing.push('rationale (why this change, in the proposer\'s own words)');
  if (!p.evidence) missing.push('evidence (what was observed, and where)');
  if (!p.created_by) missing.push('created_by');
  if (!p.change_class) missing.push('change_class');
  if (!RISK_LEVELS.includes(p.risk)) missing.push('risk (low/medium/high)');
  return { valid: missing.length === 0, missing };
}

/**
 * The audit entry for one transition. Append-only by contract — callers must
 * never update a previous entry, because a trail that can be edited proves
 * nothing.
 */
export function auditEntry({ proposal, from, to, actor, notes, at }) {
  return {
    proposal_id: proposal.id,
    from_status: from,
    to_status: to,
    actor_id: actor.id,
    actor_kind: actor.kind,
    notes: notes || null,
    at,
  };
}

/**
 * A one-line, human-readable account of a decision — what the deck and the
 * daily brief show, and what a due-diligence export reads like.
 */
export function describeDecision(p = {}) {
  const who = p.reviewed_by ? `${p.reviewed_by}` : 'nobody yet';
  switch (p.status) {
    case 'approved':  return `approved by ${who}${p.review_notes ? ` — ${p.review_notes}` : ''}`;
    case 'rejected':  return `rejected by ${who}${p.review_notes ? ` — ${p.review_notes}` : ''}`;
    case 'escalated': return `escalated to Craig${p.review_notes ? ` — ${p.review_notes}` : ''}`;
    case 'executed':  return `executed under approval by ${who}`;
    case 'failed':    return `execution FAILED${p.review_notes ? ` — ${p.review_notes}` : ''}`;
    default:          return `${p.status}, awaiting ${DOMAINS[p.domain]?.officer || 'review'}`;
  }
}

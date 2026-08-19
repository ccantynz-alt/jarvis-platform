/**
 * model-routing.js — one place that decides which Claude model does which job
 * (2026-08-19, audit move 17).
 *
 * Before this, model choice was scattered and wrong-way-round: platform repairs
 * defaulted to Fable 5 (the MOST capable and expensive tier) while the cheap,
 * structured, short-output jobs — a verifier's yes/no, a recheck's
 * still-present, a distilled lesson, the situation ranking, an officer's
 * one-line verdict — ran on whatever the CLI defaulted to, unpinned. On a
 * shared subscription window that both wastes the window and makes "why is it
 * slow/limited" unanswerable.
 *
 * The routing, by PURPOSE:
 *   cheap     (Haiku 4.5) — verify, recheck, distill, situation, officer review
 *                           verdict, canary: focused, structured, low-reasoning.
 *   standard  (Sonnet 5)  — role agents and the code-health FINDER: real work,
 *                           but a strong mid tier is the right balance.
 *   heavy     (Opus 5)    — platform repair / build / fix: the everyday-heavy
 *                           tier, matching the brain doctrine (Opus everyday).
 *   escalation(Fable 5)   — reserved for a deliberate one-shot escalation.
 *
 * Every id is env-overridable so a tier can be re-pointed without a deploy, and
 * an unknown purpose resolves to `heavy` (never silently to the cheapest).
 */

export const MODEL_IDS = {
  cheap:      process.env.MODEL_CHEAP      || 'claude-haiku-4-5',
  standard:   process.env.MODEL_STANDARD   || 'claude-sonnet-5',
  heavy:      process.env.MODEL_HEAVY      || 'claude-opus-5',
  escalation: process.env.MODEL_ESCALATION || 'claude-fable-5',
};

const PURPOSE_TIER = {
  verify: 'cheap',
  recheck: 'cheap',
  distill: 'cheap',
  situation: 'cheap',
  review_verdict: 'cheap',   // review-runner officer: one line of judgement
  canary: 'cheap',
  role: 'standard',
  code_review: 'standard',   // the code-health finder
  repair: 'heavy',
  build: 'heavy',
  fix: 'heavy',
  escalation: 'escalation',
};

/** Model id for a purpose. Unknown purpose → heavy (never the cheapest). */
export function modelFor(purpose) {
  return MODEL_IDS[PURPOSE_TIER[purpose] || 'heavy'];
}

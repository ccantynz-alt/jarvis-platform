/**
 * Jarvis review-runner — src/review-runner.js
 *
 * The REVIEW box in Craig's org chart, made real (2026-08-05, docs/GOVERNANCE.md).
 * Every officer has one; this is the single process that runs it for all of them.
 *
 * One tick = take proposals awaiting a decision, and for each one spawn the
 * owning officer as a REVIEWER — a different agent from the proposer, by
 * construction — to read the artifact against the stated rationale and return
 * a verdict. The verdict is applied through /memory/proposals/:id/transition,
 * which re-checks the gate server-side; this runner cannot talk its way past
 * anything canTransition() refuses.
 *
 * What a reviewer is asked to do is deliberately narrow: judge whether the
 * ARTIFACT matches the RATIONALE. It is not a second implementer and must not
 * "improve" the change. The failure this exists to catch is a repair agent
 * dispatched for a one-line merge defect returning a 1,028-line feature — a
 * reviewer only has to notice that the diff is not the change that was
 * described, which is a far easier judgement than writing the fix.
 *
 * MODE (env REVIEW_RUNNER_MODE): 'off' | 'dry-run' | 'live'
 *   dry-run — spawn reviewers and LOG their verdicts, apply nothing.
 *
 * Escalation is never a failure state. An officer that is unsure escalates, and
 * the proposal waits for Craig. A reviewer that cannot reach a verdict at all
 * also escalates: silence must never read as approval.
 */

import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import { requiresHuman, DOMAINS } from './lib/proposals.js';
import { spawnClaude } from './lib/spawn-agent.js';
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

/**
 * Where the reviewer runs. The officer needs to READ the branch diff, so it
 * runs in that platform's checkout — the only thing it is there to do. It has
 * no instruction to change anything, and a reviewer that commits is itself a
 * finding.
 */
function checkoutFor(platform) {
  try {
    const reg = JSON.parse(readFileSync('/opt/jarvis/config/platforms.json', 'utf8')).platforms || {};
    const p = reg[platform]?.path;
    if (p) return p;
  } catch { /* fall through */ }
  return '/opt/jarvis';
}

const MEMORY = 'http://127.0.0.1:9200';
const MODE   = process.env.REVIEW_RUNNER_MODE || 'dry-run';

const g = (name, fallback) => guardrail(name, fallback, { source: 'review-runner' });
const MAX_PER_TICK = g('REVIEW_MAX_PER_TICK', 3);
const TIMEOUT_MIN  = g('REVIEW_TIMEOUT_MIN', 10);

const log = (m) => console.log(`[review-runner] ${m}`);

async function jget(url) {
  try { return await fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json()); }
  catch { return null; }
}

async function transition(id, to, actor, notes) {
  const r = await fetch(`${MEMORY}/memory/proposals/${id}/transition`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, actor_id: actor, actor_kind: 'agent', notes }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.reason || body?.error || `transition ${r.status}`);
  return body;
}

function reviewPrompt(p) {
  return [
    `You are the ${DOMAINS[p.domain]?.officer.toUpperCase()} reviewing a change proposal.`,
    `You are the REVIEWER, not the implementer. Do not fix, improve, or extend`,
    `anything. Do not commit or push. Your entire job is one judgement:`,
    ``,
    `  Does the artifact do WHAT THE RATIONALE SAYS, and nothing else?`,
    ``,
    `Proposal #${p.id} — ${p.platform || 'fleet'} — class ${p.change_class}, risk ${p.risk}`,
    `Title:     ${p.title}`,
    `Proposer:  ${p.created_by}`,
    ``,
    `Rationale (the proposer's claim):`,
    p.rationale,
    ``,
    `Evidence recorded when it was raised:`,
    String(p.evidence || '').slice(0, 4000),
    ``,
    `Artifact: ${p.artifact_url || '(NONE ATTACHED)'}`,
    p.artifact_url
      ? `The branch is local. Inspect the actual diff before judging — for a\n`
        + `platform checkout, \`git -C <path> diff <base>...<branch>\`. Read it.`
      : `No artifact was attached. You cannot approve a change you cannot see.`,
    ``,
    `Reject if ANY of these hold:`,
    `- The diff touches files or behaviour unrelated to the rationale. A repair`,
    `  agent once returned a 1,028-line feature for a one-line defect; catching`,
    `  that is precisely why you exist.`,
    `- The change does not actually address the stated defect.`,
    `- It weakens a security control, or removes a test or guard to pass.`,
    `- There is no artifact, or the diff is empty.`,
    ``,
    `Escalate (do not approve, do not reject) if:`,
    `- It touches money, credentials, customer data, published content, legal`,
    `  filings, or infrastructure.`,
    `- It is correct but larger or riskier than the rationale implies.`,
    `- You are genuinely unsure. Escalating is free; a wrong approval is not.`,
    ``,
    `Answer with EXACTLY one line, nothing else, in this form:`,
    `VERDICT: approve|reject|escalate — <one sentence of reasoning>`,
  ].join('\n');
}

/**
 * Parse the reviewer's single line.
 *
 * Anything unparseable becomes an escalation, never an approval. A verdict we
 * could not read is not consent — this is the same rule as fix-dispatch's
 * "unknown resolves up", and it is the difference between a control and a
 * rubber stamp.
 */
export function parseVerdict(text) {
  const m = /VERDICT:\s*(approve|reject|escalate)\b[^\S\n]*[—:-]?\s*(.*)/i.exec(String(text || ''));
  if (!m) return { verdict: 'escalate', reason: 'reviewer returned no parseable verdict' };
  return { verdict: m[1].toLowerCase(), reason: (m[2] || '').trim().slice(0, 400) || 'no reasoning given' };
}

const TO_STATE = { approve: 'approved', reject: 'rejected', escalate: 'escalated' };

async function reviewOne(p) {
  const officer = DOMAINS[p.domain]?.officer;
  if (!officer) { log(`#${p.id}: unknown domain ${p.domain} — skipping`); return; }

  // Cheap pre-checks the officer does not need an agent turn to decide.
  if (!p.artifact_url) {
    log(`#${p.id}: no artifact yet — leaving for the agent to attach`);
    return;
  }
  const h = requiresHuman(p);
  if (h.required) {
    log(`#${p.id}: ${h.reason} — escalating without spending a review turn`);
    if (MODE === 'live') {
      await transition(p.id, 'under_review', officer, 'auto: beyond agent authority').catch(() => {});
      await transition(p.id, 'escalated', officer, h.reason);
      await notify({
        source: 'review-runner', level: 'warn',
        title: `⚖️ Proposal #${p.id} needs you: ${p.title.slice(0, 100)}`,
        body: `${h.reason}. ${p.artifact_url}`,
        speech: `A change proposal needs your decision, sir — it is beyond what an officer may approve.`,
      }).catch(() => {});
    }
    return;
  }

  if (MODE === 'live') await transition(p.id, 'under_review', officer, `review by ${officer}`);

  const cwd = checkoutFor(p.platform);
  const review = await spawnClaude({
    prompt: reviewPrompt(p),
    cwd,
    timeoutMin: TIMEOUT_MIN,
  }).catch(e => ({ code: 1, stdout: '', stderr: e.message }));

  // Both subscription accounts exhausted: hold, do not decide. A proposal left
  // in `proposed` is retried next tick; a proposal wrongly rejected because we
  // could not afford to look at it is a real loss.
  if (review.limitHeld) {
    log(`#${p.id}: both accounts usage-limited — holding for the next tick`);
    if (MODE === 'live') await transition(p.id, 'proposed', officer, 'held: review capacity exhausted').catch(() => {});
    return;
  }
  if (review.code !== 0) {
    log(`#${p.id}: reviewer exited ${review.code}${review.timedOut ? ' (timed out)' : ''} — escalating rather than guessing`);
    if (MODE === 'live') {
      await transition(p.id, 'escalated', officer, `reviewer failed (exit ${review.code})`).catch(() => {});
    }
    return;
  }

  // spawnClaude keeps only the LAST 4000 chars of stdout — fine here, because
  // the verdict is required to be the final line.
  const { verdict, reason } = parseVerdict(review.stdout);
  log(`#${p.id} (${p.platform}) → ${verdict.toUpperCase()}: ${reason}`);

  if (MODE !== 'live') return;

  const to = TO_STATE[verdict];
  try {
    await transition(p.id, to, officer, reason);
  } catch (e) {
    // The server refused — almost certainly the beyond-authority rule. That is
    // the gate doing its job, so honour it rather than retrying: escalate.
    log(`#${p.id}: ${to} refused (${e.message}) — escalating instead`);
    await transition(p.id, 'escalated', officer, `${reason} [officer could not approve: ${e.message}]`).catch(() => {});
  }

  const level = verdict === 'approve' ? 'info' : 'warn';
  await notify({
    source: 'review-runner', level,
    title: `⚖️ ${officer.toUpperCase()} ${verdict}s #${p.id}: ${p.title.slice(0, 90)}`,
    body: `${reason}\n${p.artifact_url || ''}`,
    speech: verdict === 'approve'
      ? `The ${officer} approved a change proposal, sir.`
      : `The ${officer} ${verdict}d a change proposal, sir.`,
  }).catch(() => {});
}

async function tick() {
  if (MODE === 'off') { log('mode=off — nothing to do'); return; }
  const rows = await jget(`${MEMORY}/memory/proposals?status=proposed&limit=50`);
  if (!Array.isArray(rows)) { log('memory unreachable — skipping this tick'); return; }

  const withArtifact = rows.filter(p => p.artifact_url);
  log(`mode=${MODE} · ${rows.length} awaiting review · ${withArtifact.length} with an artifact`);

  for (const p of rows.slice(0, MAX_PER_TICK)) {
    try { await reviewOne(p); }
    catch (e) { log(`#${p.id} review failed: ${e.message}`); }
  }
}

// Run ONLY when executed as a unit, never on import. Without this guard,
// `import { parseVerdict } from './review-runner.js'` in a test fires a real
// tick against the live memory server — which is how a test suite ends up
// transitioning production proposals (caught by test/review-runner.test.js
// printing "memory unreachable" the first time it ran).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  tick()
    .catch(e => { console.error(`[review-runner] tick failed: ${e.message}`); process.exitCode = 1; })
    .finally(() => log('tick complete'));
}

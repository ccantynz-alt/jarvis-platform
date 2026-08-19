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
 *   dry-run — spawn reviewers and LOG their verdicts, apply nothing. ONCE per
 *             proposal per artifact (KV `review-verdict:<id>` + an info inbox
 *             row), never on a loop — see needsReview().
 *
 * Escalation is never a failure state. An officer that is unsure escalates, and
 * the proposal waits for Craig. A reviewer that cannot reach a verdict at all
 * also escalates: silence must never read as approval.
 */

import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import { requiresHuman, DOMAINS } from './lib/proposals.js';
import { spawnClaude } from './lib/spawn-agent.js';
import { spawnHold } from './lib/claude-auth.js';
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

/**
 * Does this proposal need a (fresh) reviewer turn, given the verdict we already
 * hold for it?
 *
 * 2026-08-19: in dry-run nothing transitions, so `pickForReview`'s rotation —
 * correct as far as it goes — still wrapped around the same 16 `proposed` rows
 * forever: 3 per tick × 72 ticks = up to 216 ten-minute subscription turns a
 * day re-deciding proposals whose artifact had not changed, while the brain
 * and every repair agent drew from the same window. The dry-run's PURPOSE is
 * to give Craig verdicts to read before he flips the mode live; re-deciding
 * the same diff every two hours adds nothing to that. So a verdict is
 * recorded durably (KV `review-verdict:<id>`, with the artifact it was for) and
 * a proposal is re-reviewed only when its artifact moved. Live mode never
 * reaches this: a decided proposal leaves `proposed`.
 *
 * @param {{artifact_url?:string}} p
 * @param {{artifact?:string}|null} prior  the stored verdict, if any
 */
export function needsReview(p, prior) {
  if (!p?.artifact_url) return false;
  if (!prior) return true;
  return String(prior.artifact || '') !== String(p.artifact_url);
}

const VERDICT_PREFIX = 'review-verdict:';

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

  // Already decided for this exact artifact? Then the turn is pure burn.
  const priorKv = await jget(`${MEMORY}/memory/kv/${VERDICT_PREFIX}${p.id}`);
  let prior = null;
  try { prior = priorKv?.value ? JSON.parse(priorKv.value) : null; } catch { prior = null; }
  if (!needsReview(p, prior)) {
    log(`#${p.id}: already reviewed for this artifact (${prior.verdict.toUpperCase()} at ${prior.at}) — not spending a turn`);
    return;
  }

  // Nothing to spend the turn on if every login is limited or dead (2026-08-19).
  const hold = await spawnHold();
  if (hold.held) {
    log(`#${p.id}: claude ${hold.kind} hold until ${hold.at} — holding for the next tick`);
    return 'held';
  }

  if (MODE === 'live') await transition(p.id, 'under_review', officer, `review by ${officer}`);

  const cwd = checkoutFor(p.platform);
  const review = await spawnClaude({
    prompt: reviewPrompt(p),
    cwd,
    timeoutMin: TIMEOUT_MIN,
  }).catch(e => ({ code: 1, stdout: '', stderr: e.message }));

  // Both subscription accounts exhausted, or no login authenticates: hold, do
  // not decide. A proposal left in `proposed` is retried next tick; a proposal
  // wrongly rejected because we could not afford to look at it is a real loss.
  if (review.limitHeld || review.authHeld) {
    log(`#${p.id}: ${review.authHeld ? 'no login can authenticate' : 'both accounts usage-limited'} — holding for the next tick`);
    if (MODE === 'live') await transition(p.id, 'proposed', officer, `held: ${review.authHeld ? 'no Claude login can authenticate' : 'review capacity exhausted'}`).catch(() => {});
    return 'held';
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

  // Record the verdict durably against the artifact it judged, so the next
  // tick (and the next 71) skip it unless the diff moves — and so Craig can
  // actually READ the dry-run verdicts, which is what dry-run is for.
  const at = new Date().toISOString();
  await fetch(`${MEMORY}/memory/kv`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: VERDICT_PREFIX + p.id, value: JSON.stringify({ verdict, reason, officer, artifact: p.artifact_url, at, mode: MODE }) }),
  }).catch(() => {});

  if (MODE !== 'live') {
    await notify({
      source: 'review-runner', level: 'info',
      title: `⚖️ dry-run ${verdict.toUpperCase()} #${p.id}: ${String(p.title || '').slice(0, 90)}`,
      body: `${officer} would ${verdict} — ${reason}\n${p.artifact_url}\n(REVIEW_RUNNER_MODE=dry-run: nothing was applied.)`,
    }).catch(() => {});
    return;
  }

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

/**
 * Choose this tick's proposals — a durable round-robin over the queue.
 *
 * Two defects, both found 2026-08-07 and both live until 2026-08-16.
 *
 * `withArtifact` was computed for the log line and then never used: the loop
 * iterated `rows`, so a proposal an agent had left with no artifact (a STOP
 * CONDITION does exactly that, permanently) was reviewed anyway.
 *
 * Worse, memory-server returns proposals id DESC and dry-run transitions
 * nothing, so the same three newest ids sat at the head of the list forever.
 * The journal caught it: ticks at 19:04, 19:25 and 19:46 each reviewed #11,
 * #10, #9 with fresh but equivalent verdicts, while #4–#8 were never reviewed
 * at all. Three subscription turns every 20 minutes — ~216 a day — spent
 * re-deciding three proposals.
 *
 * So: oldest first, resuming after the last id reviewed, wrapping when it runs
 * off the end. The cursor is durable (KV) because this runs as a oneshot and
 * in-process state dies with the tick.
 *
 * Pure and exported so the rotation is testable without a memory server.
 */
export function pickForReview(rows, { cursor = 0, max = 3 } = {}) {
  const eligible = (Array.isArray(rows) ? rows : [])
    .filter(p => p && p.artifact_url)
    .sort((a, b) => a.id - b.id);
  if (!eligible.length) return [];
  const after = eligible.filter(p => p.id > cursor);
  // Wrap: once the tail is reached, start again from the oldest rather than
  // stalling on an empty slice forever.
  const ordered = after.concat(eligible.filter(p => p.id <= cursor));
  return ordered.slice(0, Math.max(0, max));
}

const CURSOR_KEY = 'review-runner-cursor';

async function tick() {
  if (MODE === 'off') { log('mode=off — nothing to do'); return; }
  const rows = await jget(`${MEMORY}/memory/proposals?status=proposed&limit=50`);
  if (!Array.isArray(rows)) { log('memory unreachable — skipping this tick'); return; }

  const cursorKv = await jget(`${MEMORY}/memory/kv/${CURSOR_KEY}`);
  const cursor = Number(cursorKv?.value) || 0;

  const withArtifact = rows.filter(p => p.artifact_url);
  const batch = pickForReview(rows, { cursor, max: MAX_PER_TICK });
  log(`mode=${MODE} · ${rows.length} awaiting review · ${withArtifact.length} with an artifact · resuming after #${cursor} · this tick: ${batch.map(p => '#' + p.id).join(' ') || 'none'}`);

  for (const p of batch) {
    let outcome;
    try { outcome = await reviewOne(p); }
    catch (e) { log(`#${p.id} review failed: ${e.message}`); }
    // A hold (usage/auth) spent no turn on this proposal and the rest of the
    // batch would hit the same wall: stop WITHOUT moving the cursor, so the
    // held proposals are the first picked up when a login works again.
    if (outcome === 'held') { log('holding the rest of this tick; cursor not advanced'); break; }
    // Advance PER PROPOSAL, not at the end: a tick that dies halfway must not
    // replay the ones it already spent turns on.
    await fetch(`${MEMORY}/memory/kv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: CURSOR_KEY, value: String(p.id) }),
    }).catch(() => {});
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

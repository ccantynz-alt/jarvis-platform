/**
 * Jarvis fix-runner — src/fix-runner.js
 *
 * 2026-08-05, Craig: "jarvis should automatically be fixing them". Code-health
 * had found 25 confirmed criticals and, by explicit design
 * (docs/CODE-HEALTH.md), repaired none of them: findings became work only when
 * Craig confirmed a dispatch out loud. That was the right default while nobody
 * had read the findings; it is the wrong default once they are stacking up on
 * the deck faster than a human can triage them.
 *
 * This closes the loop. One tick = pick the worst confirmed, pushable,
 * unclaimed findings and dispatch ONE repair agent each, at most one per
 * platform. Which findings qualify is decided by lib/fix-dispatch.js (pure,
 * unit-tested) — this file is only plumbing, guardrails and bookkeeping.
 *
 * MODE (env FIX_RUNNER_MODE): 'off' | 'dry-run' | 'live'
 *   off      — do nothing at all.
 *   dry-run  — log what it WOULD propose, create and launch nothing.
 *   live     — open proposals and dispatch agents to produce their branches.
 * Shipped dry-run, exactly like code-health and self-heal before it: a
 * selection this consequential gets read by a human against the real findings
 * table before it is allowed to spend agents.
 *
 * Guardrails (all via lib/guardrail.js, because systemd's EnvironmentFile does
 * NOT strip inline comments and `MAX=6 # per day` silently disables a cap —
 * that is the 2026-07-17 incident where self-heal made 117 dispatches against
 * a cap of 6):
 *   FIX_MAX_PER_DAY       fleet-wide dispatches per day
 *   FIX_MAX_CONCURRENT    per tick, and never more than the orchestrator can chew
 *   FIX_MIN_SEVERITY      severity floor (default critical)
 *
 * Every dispatch stamps `fix_job_id` on the finding, so a repair in flight can
 * never be dispatched twice — the durable claim, not an in-memory set that a
 * restart would forget.
 */

import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import { fixEligibility, selectForDispatch, buildFixTask, fixBranchName, DENIED_PLATFORMS } from './lib/fix-dispatch.js';
import { hasSource } from './lib/checkout.js';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';

const MEMORY       = 'http://127.0.0.1:9200';
const ORCHESTRATOR = 'http://127.0.0.1:9205';
const MODE         = process.env.FIX_RUNNER_MODE || 'dry-run';
const STATE_KEY    = 'fix-runner-state';

const g = (name, fallback) => guardrail(name, fallback, { source: 'fix-runner' });
const MAX_PER_DAY    = g('FIX_MAX_PER_DAY', 4);
const MAX_CONCURRENT = g('FIX_MAX_CONCURRENT', 2);
const MIN_SEVERITY   = (process.env.FIX_MIN_SEVERITY || 'critical').trim().split('#')[0].trim();

const log = (m) => console.log(`[fix-runner] ${m}`);
const today = () => new Date().toISOString().slice(0, 10);

async function jget(url) {
  try { return await fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json()); }
  catch { return null; }
}

// ── Can we actually land a fix for this platform? ────────────────────────────
//
// Two separate questions, and conflating them is a documented trap on this box
// (CLAUDE.md, code-health's hasSource vs audit-runner's checkoutProblem): is
// there SOURCE to edit, and is there a REMOTE to push it to. A repo with code
// but no remote (universal-ai-operator) produces a commit nobody ever deploys.
// Resolved once per tick and cached — this shells out to git.
// Also measures how far behind origin each checkout is. A stale base is not
// safe to fix on — see fix-dispatch.js's staleness gate and the Zoobicon case
// (194 commits behind). This does NOT fetch: a fetch on every tick against
// every platform is network Craig didn't ask for, and `git status`'s stored
// upstream count is what a human would read anyway. It means the count is only
// as fresh as the last fetch — which is the conservative direction, since a
// checkout that LOOKS current but is actually behind still gets caught by the
// agent's own "check whether it is already fixed upstream and STOP" rule.
function buildCheckoutState(registry) {
  const pushable = new Set();
  const behind = new Map();
  for (const [name, entry] of Object.entries(registry)) {
    const path = entry?.path;
    if (!path || entry?.executor === 'pc' || entry?.server === 'vercel') continue;
    if (!hasSource(path)) continue;
    try {
      const url = execFileSync('git', ['-C', path, 'remote', 'get-url', 'origin'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
      if (!url) continue;
      pushable.add(name);
      try {
        // HEAD..@{u} = commits on the upstream we do not have, i.e. how far BEHIND.
        const b = execFileSync('git', ['-C', path, 'rev-list', '--count', 'HEAD..@{u}'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
        behind.set(name, Number(b) || 0);
      } catch { /* no upstream configured — treat as current, other gates still apply */ }
    } catch { /* no .git, or no origin — not pushable, which is the answer */ }
  }
  return { pushable, behind };
}

async function loadState() {
  const kv = await jget(`${MEMORY}/memory/kv/${STATE_KEY}`);
  let s = null;
  try { s = kv?.value ? (typeof kv.value === 'string' ? JSON.parse(kv.value) : kv.value) : null; } catch { s = null; }
  if (!s || typeof s !== 'object') s = { day: today(), attemptsToday: 0 };
  // Roll the day from the stored day itself. self-heal's version of this
  // re-stamped `day` on every tick while carrying the count forward, so the
  // reset could never fire and one bad day disabled repairs permanently
  // (fixed 2026-07-30) — do not reintroduce that shape here.
  if (s.day !== today()) s = { day: today(), attemptsToday: 0 };
  return s;
}

async function saveState(s) {
  try {
    await fetch(`${MEMORY}/memory/kv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: STATE_KEY, value: JSON.stringify(s) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (e) { console.error(`[fix-runner] state save failed: ${e.message}`); }
}

async function busyPlatforms() {
  const rows = await jget(`${ORCHESTRATOR}/jobs`);
  const set = new Set();
  for (const j of Array.isArray(rows) ? rows : []) {
    if (j.status === 'running' || j.status === 'queued' || j.status === 'claimed') set.add(j.platform);
  }
  return set;
}

/**
 * Open the proposal FIRST, then dispatch the agent to produce its evidence.
 *
 * Order matters: the proposal is the durable record that this work was
 * authorised to be attempted and by whom. If the dispatch then fails, we have a
 * proposal with no artifact — visible and reviewable — rather than an agent
 * running with nothing on record (docs/GOVERNANCE.md).
 */
async function openProposal(finding) {
  const r = await fetch(`${MEMORY}/memory/proposals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      domain: 'cto',                 // code changes are the CTO's office
      platform: finding.platform,
      change_class: 'code_fix',
      // Severity is about the DEFECT; risk is about the CHANGE. A critical bug
      // does not make its repair a risky edit — conflating them would send every
      // fix to Craig and the gate would be switched off within a week. A scoped,
      // tested, branch-only fix is medium by default.
      risk: 'medium',
      title: `${finding.platform}: ${finding.title}`.slice(0, 200),
      rationale: `Confirmed ${finding.severity} ${finding.kind} finding #${finding.id}. `
        + `Auto-selected for repair: adversarially verified, checkout current, no duplicate flagged.`,
      evidence: String(finding.evidence || finding.title).slice(0, 6000),
      finding_id: finding.id,
      created_by: `fix-runner`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `proposal ${r.status}`);
  return body.id;
}

async function dispatchFix(finding, proposalId) {
  const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform: finding.platform,
      task: buildFixTask(finding, proposalId),
      enqueued_by: 'fix-runner',
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error || `dispatch ${r.status}`);
  return body.jobId;
}

/** Durable claim — the only thing preventing a double-dispatch across restarts. */
async function claimFinding(id, jobId) {
  const r = await fetch(`${MEMORY}/memory/findings/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fix_job_id: jobId }),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`claim ${r.status}`);
}

async function tick() {
  if (MODE === 'off') { log('mode=off — nothing to do'); return; }

  const findings = await jget(`${MEMORY}/memory/findings?open_only=1&limit=200`);
  if (!Array.isArray(findings)) { log('memory unreachable — skipping this tick'); return; }

  let registry = {};
  try { registry = JSON.parse(readFileSync('/opt/jarvis/config/platforms.json', 'utf8')).platforms || {}; }
  catch (e) { log(`registry unreadable (${e.message}) — skipping`); return; }

  const { pushable, behind } = buildCheckoutState(registry);
  const ctx = {
    canPush: (p) => pushable.has(p),
    behindCount: (p) => behind.get(p) || 0,
    minSeverity: MIN_SEVERITY,
    denied: DENIED_PLATFORMS,
  };
  const state = await loadState();
  const busy = await busyPlatforms();

  const { picked, skipped } = selectForDispatch(findings, ctx, {
    maxConcurrent: MAX_CONCURRENT,
    attemptsToday: state.attemptsToday,
    maxPerDay: MAX_PER_DAY,
    busy,
  });

  const eligibleTotal = findings.filter(f => fixEligibility(f, ctx).eligible).length;
  log(`mode=${MODE} · ${findings.length} open · ${eligibleTotal} eligible · ${picked.length} picked · ` +
      `${state.attemptsToday}/${MAX_PER_DAY} used today · pushable: ${[...pushable].join(',') || 'none'}`);

  // Say WHY out loud, not just what — a silent "0 picked" is indistinguishable
  // from a broken runner, which is how the off-box watchdog went unnoticed for
  // a month.
  if (!picked.length && eligibleTotal === 0 && findings.length) {
    const reasons = {};
    for (const s of skipped) reasons[s.reason] = (reasons[s.reason] || 0) + 1;
    for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4)) {
      log(`  ${n} × ${why}`);
    }
  }

  for (const finding of picked) {
    const where = `${finding.platform} #${finding.id} (${finding.severity}) ${finding.file_path || ''}`;
    if (MODE === 'dry-run') { log(`WOULD propose: ${where} — ${finding.title.slice(0, 90)}`); continue; }
    try {
      // Proposal FIRST, then the agent that produces its evidence. If dispatch
      // then fails we hold a proposal with no artifact — visible and
      // reviewable — rather than an agent running with nothing on record.
      const proposalId = await openProposal(finding);
      const jobId = await dispatchFix(finding, proposalId);
      if (!jobId) throw new Error('orchestrator returned no jobId');
      // Claim BEFORE counting the attempt, so a failed claim cannot leave a
      // running agent that the next tick is blind to and dispatches again.
      await claimFinding(finding.id, jobId);
      state.attemptsToday += 1;
      await saveState(state);
      log(`proposal ${proposalId} + job ${jobId} → ${where}`);
      await notify({
        source: 'fix-runner', level: 'info',
        title: `🔧 Fix PROPOSED for ${finding.platform} #${finding.id}: ${finding.title.slice(0, 100)}`,
        body: `Confirmed ${finding.severity} ${finding.kind} at ${finding.file_path || '?'}:${finding.line ?? '?'}. ` +
              `Agent ${jobId} is preparing branch ${fixBranchName(finding)} for proposal ${proposalId}. ` +
              `Nothing merges without CTO review (${state.attemptsToday}/${MAX_PER_DAY} today).`,
        speech: `I've prepared a fix proposal for a confirmed ${finding.severity} in ${finding.platform}, sir. It awaits review.`,
      }).catch(() => {});
    } catch (e) {
      log(`dispatch FAILED for ${where}: ${e.message}`);
      await notify({
        source: 'fix-runner', level: 'warn',
        title: `Could not auto-fix ${finding.platform} #${finding.id} — ${e.message}`,
        body: `${finding.title}\nThe finding stays open and unclaimed; the next tick will retry it.`,
      }).catch(() => {});
    }
  }
}

tick()
  .catch(e => { console.error(`[fix-runner] tick failed: ${e.message}`); process.exitCode = 1; })
  .finally(() => log('tick complete'));

/**
 * Which code-health findings may be repaired unattended — src/lib/fix-dispatch.js
 *
 * 2026-08-05, Craig: "jarvis should automatically be fixing them". Until now
 * code-health deliberately fixed NOTHING (docs/CODE-HEALTH.md): findings became
 * work only by Craig confirming a dispatch out loud. This module is the
 * narrowing that makes unattended repair safe enough to turn on, and it is
 * deliberately strict — a full-permission agent editing the wrong repo is a
 * worse outcome than a bug sitting one more day in a queue Craig can see.
 *
 * The gauntlet, and why each gate exists:
 *
 *  1. CONFIRMED ONLY. `open` means one review agent said so; `confirmed` means
 *     an adversarial verifier tried to refute it and failed (findings.js). Ten
 *     of the 25 open criticals on 2026-08-05 were `open/unverified` or carried
 *     "verifier produced no usable verdict" — dispatching an agent to fix a
 *     finding nobody could substantiate is how you get invented changes to
 *     working code.
 *
 *  2. NO SUSPECTED DUPLICATES. findings.js appends a "LIKELY DUPLICATE" note
 *     when a reworded finding lands on an existing row. Four of the 25 carried
 *     it. Two agents fixing one bug in one repo race each other's commits.
 *
 *  3. A CHECKOUT WITH A REMOTE. universal-ai-operator holds NINE of the
 *     criticals and has no `.git` at all — there is nowhere to push, so an
 *     agent would burn a full subscription turn and leave the work in a
 *     directory nobody deploys from. Same reason audit-runner carries
 *     `noAutoFix` for it.
 *
 *  4. NOT A DENIED PLATFORM. Three standing exclusions, each already doctrine:
 *     screenshot-to-code is a third-party fork (auto-committing diverges it
 *     from upstream); alecrae is a LIVE co-tenant on this box, and finding #4
 *     is explicitly recorded "No unattended edit to AlecRae mail code — report
 *     only"; jarvis is itself, and an agent editing the orchestrator that is
 *     running it is a foot-gun with no upside.
 *
 *  5. NOT ALREADY BEING FIXED. `fix_job_id` set means a repair is out. One
 *     finding, one agent.
 *
 *  6. SEVERITY FLOOR. critical by default. Widening this is a config change,
 *     not a code change, so it can be walked back without a deploy.
 *
 * Pure functions only. Tests: test/fix-dispatch.test.js.
 */

/** Platforms that never get an unattended fix, and the reason Craig would be told. */
export const DENIED_PLATFORMS = {
  'screenshot-to-code': 'third-party fork — an auto-commit diverges it from upstream',
  alecrae: 'live co-tenant on this box; mail-stack findings are report-only by standing rule',
  jarvis: 'this platform — an agent must not rewrite the orchestrator that is running it',
};

export const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * @param {object} finding                 a code_findings row
 * @param {object} ctx
 * @param {(p:string)=>boolean} ctx.canPush  platform has a checkout AND a git remote
 * @param {string} [ctx.minSeverity]         lowest severity eligible (default 'critical')
 * @param {object} [ctx.denied]              platform → reason
 * @returns {{eligible: boolean, reason: string}}
 */
export function fixEligibility(finding, { canPush, minSeverity = 'critical', denied = DENIED_PLATFORMS } = {}) {
  if (!finding || !finding.platform) return { eligible: false, reason: 'malformed finding' };

  const rank = SEVERITY_RANK[finding.severity];
  const floor = SEVERITY_RANK[minSeverity];
  // An unrecognised severity is not silently treated as urgent.
  if (rank === undefined || floor === undefined || rank > floor) {
    return { eligible: false, reason: `severity ${finding.severity} below ${minSeverity}` };
  }
  if (finding.status !== 'confirmed') {
    return { eligible: false, reason: `status ${finding.status} — only adversarially confirmed findings are auto-fixed` };
  }
  if (finding.fix_job_id) return { eligible: false, reason: `already dispatched as ${finding.fix_job_id}` };
  if (denied[finding.platform]) return { eligible: false, reason: denied[finding.platform] };
  if (!canPush(finding.platform)) {
    return { eligible: false, reason: 'no local checkout with a git remote — nowhere to push a fix' };
  }
  // findings.js writes this marker into the verdict when a reworded finding
  // lands near an existing row. Two agents on one bug race each other.
  if (/LIKELY DUPLICATE/i.test(String(finding.verdict || ''))) {
    return { eligible: false, reason: 'flagged as a likely duplicate of an existing finding' };
  }
  return { eligible: true, reason: 'confirmed, pushable, unclaimed' };
}

/**
 * Choose what to dispatch this tick.
 *
 * ONE per platform per tick, always. The orchestrator serialises by platform
 * anyway (hasJobInFlight), and two agents in one repo produce conflicting
 * commits — the exact shape of gluecron finding #229, where two merges on one
 * base silently discarded each other.
 *
 * @param {object[]} findings              candidate rows, any order
 * @param {object} ctx                     passed through to fixEligibility
 * @param {object} limits
 * @param {number} limits.maxConcurrent    fleet-wide cap on in-flight fixes
 * @param {number} limits.attemptsToday    fixes already dispatched today
 * @param {number} limits.maxPerDay        daily cap
 * @param {Set<string>} [limits.busy]      platforms with a job already in flight
 * @returns {{picked: object[], skipped: {finding: object, reason: string}[]}}
 */
export function selectForDispatch(findings, ctx, limits) {
  const { maxConcurrent, attemptsToday, maxPerDay, busy = new Set() } = limits;
  const picked = [];
  const skipped = [];
  const claimed = new Set();

  const budget = Math.max(0, Math.min(maxConcurrent, maxPerDay - attemptsToday));

  // Worst first, then the longest-standing — a critical seen five times running
  // outranks one filed this morning.
  const ordered = [...(findings || [])].sort((a, b) =>
    (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
    String(a.first_seen || '').localeCompare(String(b.first_seen || '')));

  for (const f of ordered) {
    const e = fixEligibility(f, ctx);
    if (!e.eligible) { skipped.push({ finding: f, reason: e.reason }); continue; }
    if (busy.has(f.platform)) { skipped.push({ finding: f, reason: 'a job is already running for this platform' }); continue; }
    if (claimed.has(f.platform)) { skipped.push({ finding: f, reason: 'another finding for this platform goes first' }); continue; }
    if (picked.length >= budget) {
      skipped.push({ finding: f, reason: budget === 0 ? 'daily cap or concurrency budget exhausted' : 'over this tick\'s budget' });
      continue;
    }
    claimed.add(f.platform);
    picked.push(f);
  }
  return { picked, skipped };
}

/**
 * The prompt a repair agent gets. Deliberately narrow: ONE finding, the
 * evidence that was already verified, and an explicit instruction to down-tools
 * rather than guess. The alternative — "fix the criticals" — is how an agent
 * ends up refactoring a repo unattended.
 */
export function buildFixTask(finding) {
  const loc = finding.file_path ? `${finding.file_path}${finding.line ? ':' + finding.line : ''}` : 'see evidence';
  return [
    `Fix ONE confirmed ${finding.severity} defect in ${finding.platform}. Do not fix anything else.`,
    ``,
    `Finding #${finding.id} (${finding.kind}) at ${loc}:`,
    finding.title,
    ``,
    `Evidence from the review and its adversarial verification:`,
    String(finding.evidence || '(none recorded)').slice(0, 4000),
    finding.suggested_fix ? `\nSuggested direction (not binding):\n${String(finding.suggested_fix).slice(0, 1500)}` : '',
    ``,
    `Rules:`,
    `- Change the minimum needed to close THIS defect. No refactors, no drive-by cleanups.`,
    `- This finding was recorded against commit ${finding.commit_sha || '(unknown)'}. The checkout may be behind its remote — check whether it is already fixed upstream and STOP if so, reporting that.`,
    `- If the finding turns out to be wrong or you cannot verify the defect is real, make NO change and say so plainly. A false finding closed by an unnecessary edit is worse than an open one.`,
    `- Add or extend a test that fails before your change and passes after, where the project has a test suite.`,
    `- Run the project's own build and tests. If they were already failing before you started, say so rather than fixing unrelated breakage.`,
    `- Commit with a message explaining the defect and the fix, then push.`,
    `- Report what you changed, the test evidence, and anything you deliberately left alone.`,
  ].filter(Boolean).join('\n');
}

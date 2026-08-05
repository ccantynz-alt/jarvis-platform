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
 * Phrases a verifier uses when it could not actually stand the finding up.
 * These appear in `verdict` prose on rows whose `status` column still says
 * 'confirmed', so the enum alone is not enough to trust a finding with an
 * unattended agent.
 */
export const CAUTION_RE =
  /NOT confirmed|treat with care|left unproven|no usable verdict|could not (?:verify|reproduce)|unable to (?:verify|confirm)|may (?:already )?(?:be|have been) fixed|verify (?:against|before)/i;

/**
 * @param {object} finding                 a code_findings row
 * @param {object} ctx
 * @param {(p:string)=>boolean} ctx.canPush  platform has a checkout AND a git remote
 * @param {string} [ctx.minSeverity]         lowest severity eligible (default 'critical')
 * @param {object} [ctx.denied]              platform → reason
 * @param {(p:string)=>number} [ctx.behindCount]  commits the checkout is behind origin
 * @returns {{eligible: boolean, reason: string}}
 */
export function fixEligibility(finding, {
  canPush, minSeverity = 'critical', denied = DENIED_PLATFORMS,
  behindCount = () => 0,
} = {}) {
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
  // A checkout BEHIND its remote is not a safe base for an unattended fix
  // (2026-08-05). Found when Craig said "we have a repo its connected": the
  // real Zoobicon checkout lives at universal-ai-operator/target_code/zoobicon
  // and was **194 commits behind origin/main**. An agent there would re-fix
  // bugs already fixed upstream, and commit onto a base that is guaranteed to
  // conflict. code-health already records commit_sha for exactly this reason
  // ("a local checkout can be behind its remote"), but recording it only helps
  // a human reading the finding — this is the gate that stops an agent.
  const behind = behindCount(finding.platform);
  if (behind > 0) {
    return { eligible: false, reason: `checkout is ${behind} commits behind its remote — pull before any unattended fix` };
  }
  // findings.js writes this marker into the verdict when a reworded finding
  // lands near an existing row. Two agents on one bug race each other.
  if (/LIKELY DUPLICATE/i.test(String(finding.verdict || ''))) {
    return { eligible: false, reason: 'flagged as a likely duplicate of an existing finding' };
  }
  // `status` and `verdict` can disagree, and when they do the PROSE is right.
  // Found by running the first dry-run tick (2026-08-05): gluecron #31 is
  // stored `status: confirmed`, but its verifier wrote "PARTIALLY re-verified
  // and NOT confirmed at origin/main — treat with care ... Verify against
  // lib/pr-merge.ts at origin/main before acting on this one." A verifier that
  // hedged in words wrote its doubt somewhere the status enum cannot express,
  // and this was one tick away from spending a full-permission agent on it.
  const caution = CAUTION_RE.exec(String(finding.verdict || ''));
  if (caution) {
    return { eligible: false, reason: `verifier hedged ("${caution[0]}") — needs a human before an agent touches it` };
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
/** The branch an unattended repair is allowed to create. Never a default branch. */
export function fixBranchName(finding) {
  return `jarvis/fix-${finding.id}`;
}

/**
 * The prompt a repair agent gets.
 *
 * Rewritten 2026-08-05 from "commit and push" to "branch and PROPOSE". The
 * previous version asked for the minimum change and got a 1,028-line feature
 * pushed to gluecron's main — a prompt is a request, not a boundary
 * (docs/GOVERNANCE.md). The agent now cannot land anything: it works on
 * `jarvis/fix-<id>`, pushes only that branch, and records the compare URL
 * against a proposal an officer must approve. Merging is nobody's job here.
 *
 * @param {object} finding
 * @param {number} proposalId  the proposal this agent is producing evidence for
 */
export function buildFixTask(finding, proposalId) {
  const loc = finding.file_path ? `${finding.file_path}${finding.line ? ':' + finding.line : ''}` : 'see evidence';
  const branch = fixBranchName(finding);
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
    `HOW THIS LANDS — read before you start:`,
    `You are producing a PROPOSAL, not a release. You may not merge, and you may`,
    `not push to main/master. An officer reviews your branch and decides.`,
    ``,
    `1. git checkout -b ${branch}   (branch from the current HEAD; if the branch`,
    `   already exists, reuse it — do not create a second one)`,
    `2. Make the change. Change the MINIMUM needed to close THIS defect. No`,
    `   refactors, no drive-by cleanups, no unrelated features. If you find`,
    `   yourself touching files unrelated to the finding, stop: that is a`,
    `   separate proposal, and adding it here will get the whole thing rejected.`,
    `3. Add or extend a test that fails before your change and passes after,`,
    `   where the project has a test suite.`,
    `4. Run the project's own build and tests. If they were ALREADY failing`,
    `   before you started, say so rather than fixing unrelated breakage.`,
    `5. Commit with a message explaining the defect and the fix.`,
    `6. git push -u origin ${branch}    ← the branch ONLY. Never main.`,
    `7. Record the artifact so the officer can review it:`,
    `   curl -s -X POST http://127.0.0.1:9200/memory/proposals/${proposalId}/artifact \\`,
    `     -H 'Content-Type: application/json' \\`,
    `     -d '{"artifact_url":"<the branch compare URL>","artifact_kind":"branch"}'`,
    `   The compare URL is https://github.com/<owner>/<repo>/compare/<base>...${branch}`,
    `   (derive owner/repo from \`git remote get-url origin\`; base is the branch`,
    `   you branched from).`,
    ``,
    `STOP CONDITIONS — these are successes, not failures. In each case make NO`,
    `change, push nothing, and report why:`,
    `- The defect is already fixed. This finding was recorded against commit`,
    `  ${finding.commit_sha || '(unknown)'} and the checkout may have moved on.`,
    `- You cannot substantiate the defect. A false finding closed by an`,
    `  unnecessary edit is worse than an open one.`,
    `- The fix would require changes well beyond the finding's scope.`,
    ``,
    `Report what you changed, the test evidence, the branch name, and anything`,
    `you deliberately left alone.`,
  ].filter(Boolean).join('\n');
}

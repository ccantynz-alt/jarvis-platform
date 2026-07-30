/**
 * Jarvis code-health spine — src/code-health.js
 *
 * Craig, 2026-07-30, on his way out the door: "we could run for days finding
 * problems and build a spine health prob not just finding HTTP problems but
 * actually coding issues regardless of how deep they go."
 *
 * Everything Jarvis watched before this answers ONE question — "is it serving?"
 *   fleet-check.sh   pings a public URL every 10 minutes
 *   audit-runner.js  builds, tests, screenshots, scores
 *   deploy-gate.js   scans what shipped
 *   self-heal.js     restarts what stopped answering
 * A codebase full of swallowed errors, unvalidated input, races and money-path
 * bugs passes every one of those cleanly. This runs on a timer and asks the other
 * question — "is it CORRECT?" — one platform and one lens at a time, so the
 * review goes DEEP over days instead of shallow every night.
 *
 * Shape of a sweep:
 *   1. pick the least-recently-swept eligible platform + its next lens
 *   2. spawn ONE read-only review agent, scoped to that lens (lib/findings.js)
 *   3. parse its JSON, clamp every field (model output is untrusted input)
 *   4. spend an ADVERSARIAL VERIFIER on anything critical/high/security/data-loss
 *      — a verifier told to refute, not to agree
 *   5. upsert into code_findings by fingerprint: confirmed, or dismissed with
 *      the refutation recorded so it is never re-reported
 *   6. notify — a digest for the run, a device-push alert for a confirmed critical
 *
 * Hard rules:
 *   - Review and verify agents are READ-ONLY. They may not edit, commit, push,
 *     restart, or run migrations. Nothing here fixes anything: a finding becomes
 *     work only when Craig says so, through the dispatch confirmation gate.
 *   - Every numeric limit goes through guardrail() (the 2026-07-17 lesson).
 *   - MODE=off is a complete kill switch and is checked first.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { loadPlatforms } from './lib/conversation.js';
import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import { spawnClaude, ensureClaudeVerified } from './lib/spawn-agent.js';
import {
  normalizeFinding, parseFindings, needsVerification, pickTarget, severityRank, lensFor, LENSES,
} from './lib/findings.js';

const MEMORY = 'http://127.0.0.1:9200';
const OWN_IP = process.env.OWN_IP || '66.42.121.161';

const MODE = process.env.CODE_HEALTH_MODE || 'dry-run';   // off | dry-run | live
// allowZero because 0 is a meaningful setting for some of these ("never
// re-check"), and guardrail() otherwise treats a deliberate 0 as malformed.
const g = (name, fallback, allowZero = false) => guardrail(name, fallback, { source: 'code-health', allowZero });
const SWEEP_COOLDOWN_H  = g('CODE_HEALTH_COOLDOWN_HOURS', 20);  // per platform
const MAX_FINDINGS       = g('CODE_HEALTH_MAX_FINDINGS', 8);    // per sweep
const MAX_VERIFICATIONS  = g('CODE_HEALTH_MAX_VERIFY', 4);      // per sweep
const MAX_RECHECK        = g('CODE_HEALTH_MAX_RECHECK', 2, true); // old findings re-checked per sweep
const RECHECK_MIN_AGE_H  = g('CODE_HEALTH_RECHECK_MIN_AGE_HOURS', 24); // don't re-check what we just checked
const REVIEW_TIMEOUT_MIN = g('CODE_HEALTH_REVIEW_MIN', 25);
const VERIFY_TIMEOUT_MIN = g('CODE_HEALTH_VERIFY_MIN', 8);

const STATE_DIR = '/var/lib/jarvis/code-health';
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOG = '/var/log/jarvis-code-health.log';
const WORK_DIR = '/tmp/jarvis-code-health';

// Not reviewed by default:
//   craig-pc            — a worker node, not a codebase
//   screenshot-to-code  — a third-party fork; findings there are upstream's, and
//                         audit-runner already refuses to auto-fix it
//   vapron              — lives on box 158, which nothing on this box can SSH to
//                         as of 2026-07-30 (see docs/ALERTS.md)
const DEFAULT_SKIP = ['craig-pc', 'screenshot-to-code', 'vapron'];
const SKIP = new Set((process.env.CODE_HEALTH_SKIP || DEFAULT_SKIP.join(',')).split(',').map(s => s.trim()).filter(Boolean));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG, line); } catch {}
  process.stdout.write(line);
}

function loadState() {
  if (existsSync(STATE_FILE)) { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {} }
  return {};
}
function saveState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

/**
 * Platforms whose code is actually READABLE from this box: active, registered
 * with a path, hosted here, and not on the skip list. A review of a codebase we
 * cannot open would be a review of the model's imagination.
 */
export function eligiblePlatforms(registry, { ownIp = OWN_IP, skip = SKIP, exists = existsSync } = {}) {
  return Object.entries(registry)
    .filter(([name, e]) => e && e.status === 'active' && !skip.has(name) && e.executor !== 'pc')
    .filter(([, e]) => e.server === ownIp && e.path && exists(e.path))
    .map(([name]) => name)
    .sort();
}

/**
 * What commit is this checkout actually on, and how old is it?
 *
 * A finding is only true of the code that was READ. During the first live sweep
 * /opt/alecrae was 28 commits behind its remote (a separate on-box
 * alecrae-drift-check.timer had just recorded exactly that), so a real finding
 * here can be already-fixed upstream — and without the sha nobody can tell those
 * two apart weeks later. Read-only: `git log`, never `git fetch`.
 */
function checkoutInfo(cwd) {
  const git = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
  try {
    const sha = git(['rev-parse', '--short', 'HEAD']);
    const iso = git(['log', '-1', '--format=%cI']);
    const ageDays = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return { sha, iso, ageDays };
  } catch {
    return { sha: null, iso: null, ageDays: null };   // not a git checkout, or git is unhappy
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────
// Both are deliberately long. A vague review prompt produces a vague review, and
// the expensive failure here is not a missed bug — it is an INVENTED one, which
// costs Craig's attention and then an agent's time proving it wrong.

function reviewPrompt(platform, lens, outFile) {
  return [
    `You are performing a READ-ONLY deep code review of the "${platform}" codebase for Jarvis, ` +
    `the system that keeps Craig Canty's platforms healthy. You are in the repository root.`,
    '',
    `REVIEW LENS FOR THIS PASS — stay inside it: ${lens.brief}.`,
    'Other kinds of problem are out of scope for this pass; another pass has its own lens.',
    '',
    'ABSOLUTE RULES:',
    '- READ ONLY. Do not edit, create, delete, or move any file in the repository. Do not run ' +
    'git commit, git push, git checkout, npm install, migrations, builds, restarts, or ANY command ' +
    'that changes state. Reading (cat/grep/git log/git diff) is what you are here for.',
    `- The ONLY file you may write is ${outFile}.`,
    '- Report only defects you can point at IN THE CODE, with a file, a line, and the actual ' +
    'reasoning for why it goes wrong. No speculation, no "consider adding", no style opinions, ' +
    'no TODO hunting, no dependency-version nagging.',
    '- FINDING NOTHING IS A CORRECT AND WELCOME RESULT. An empty array is a good review of clean ' +
    'code. Inventing a plausible-sounding bug to look thorough is the single worst thing you can do ' +
    'here: it wastes a verification agent and, if it survives, Craig\'s trust.',
    '',
    'For each real defect ask yourself: what concrete input or sequence of events makes this ' +
    'misbehave, and what is the consequence? If you cannot answer both, it is not a finding.',
    '',
    `Write your result to ${outFile} as a BARE JSON array (no prose, no markdown fence), at most ` +
    `${MAX_FINDINGS} entries, worst first:`,
    '[{',
    '  "title": "one specific sentence naming the defect",',
    '  "severity": "critical|high|medium|low",',
    '  "kind": "correctness|security|data-loss|reliability|performance|maintainability|dependency",',
    '  "file": "path/relative/to/repo/root.js",',
    '  "line": 123,',
    '  "evidence": "the code path and the input/sequence that makes it go wrong, and the consequence",',
    '  "suggested_fix": "the smallest change that fixes it"',
    '}]',
    '',
    'Severity means impact if it happens in production: critical = data loss, security breach, or ' +
    'the platform down; high = a user-visible failure or a silent wrong result; medium = degraded ' +
    'behaviour or a fragile path; low = a real but minor defect.',
    '',
    `When the file is written, print exactly: WROTE ${outFile} (<n> findings)`,
  ].join('\n');
}

function recheckPrompt(platform, f) {
  return [
    `You are RE-CHECKING an old code-health finding against the CURRENT state of the ` +
    `"${platform}" codebase. You are in the repository root. The question is narrow: is this ` +
    `defect still there?`,
    '',
    `FINDING: ${f.title}`,
    `FILE: ${f.file_path || '(none recorded)'}${f.line ? `:${f.line}` : ''}`,
    `RECORDED WHEN THE REPO WAS AT: ${f.commit_sha || '(unrecorded)'}`,
    `WHY IT WAS A DEFECT: ${f.evidence || '(not recorded)'}`,
    '',
    'Open the file as it is NOW. Line numbers will have moved — find the code, not the line. ' +
    'The file may have been renamed or deleted, and the fix may be somewhere else entirely (a new ' +
    'guard in a caller counts as fixed).',
    '',
    'READ ONLY — change nothing, run nothing that mutates state.',
    '',
    'Be conservative in BOTH directions. Saying "fixed" when it is not buries a real defect ' +
    'permanently; saying "still there" when it is fixed keeps nagging Craig about work he already ' +
    'did. If the code has been restructured so much that you cannot tell, say still_present=true ' +
    'and explain — an unclear answer must not close a finding.',
    '',
    'Print ONLY this JSON, nothing else:',
    '{"still_present": true|false, "why": "one or two sentences quoting what you found now"}',
  ].join('\n');
}

function verifyPrompt(platform, f) {
  return [
    `You are the ADVERSARIAL VERIFIER for a code-review finding on the "${platform}" codebase. ` +
    `You are in the repository root. Your job is to REFUTE this claim, not to agree with it.`,
    '',
    `CLAIM: ${f.title}`,
    `FILE: ${f.file_path || '(none given)'}${f.line ? `:${f.line}` : ''}`,
    `KIND: ${f.kind}   CLAIMED SEVERITY: ${f.severity}`,
    `REASONING GIVEN: ${f.evidence || '(none)'}`,
    '',
    'Open the actual code and check it. Try hard to find the reason this is NOT a real defect: a ' +
    'guard earlier in the call path, a caller that makes the bad input impossible, a framework ' +
    'behaviour that already handles it, a test that proves the opposite, or simply a misreading of ' +
    'the code. READ ONLY — change nothing, run nothing that mutates state.',
    '',
    'Default to refuted when you are unsure. A finding that survives you should be one Craig can ' +
    'act on without checking your work; a wrong "confirmed" is worse than a missed bug.',
    '',
    'Print ONLY this JSON, nothing else:',
    '{"real": true|false, "severity": "critical|high|medium|low", "why": "one or two sentences of ' +
    'concrete evidence from the code — quote the guard you found, or the line that makes it fail"}',
  ].join('\n');
}

// ── Memory ───────────────────────────────────────────────────────────────────

async function upsertFinding(f) {
  const r = await fetch(`${MEMORY}/memory/findings`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f),
  });
  if (!r.ok) throw new Error(`memory findings returned ${r.status}`);
  return r.json();
}

async function patchFinding(id, body) {
  await fetch(`${MEMORY}/memory/findings/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(() => {});
}

// ── One sweep ────────────────────────────────────────────────────────────────

export async function runOnce({ platform: forcePlatform, lensKey } = {}) {
  if (MODE === 'off') { log('mode=off — skipping'); return { skipped: 'off' }; }

  const registry = loadPlatforms();
  const eligible = eligiblePlatforms(registry);
  if (!eligible.length) { log('no eligible platforms (nothing with a readable local checkout)'); return { skipped: 'no-candidates' }; }

  const state = loadState();
  let target;
  if (forcePlatform) {
    if (!eligible.includes(forcePlatform)) { log(`${forcePlatform} is not eligible (eligible: ${eligible.join(', ')})`); return { skipped: 'not-eligible' }; }
    const idx = lensKey ? LENSES.findIndex(l => l.key === lensKey) : (state[forcePlatform]?.lensIndex || 0);
    target = { platform: forcePlatform, lens: lensFor(idx < 0 ? 0 : idx), lensIndex: idx < 0 ? 0 : idx };
  } else {
    target = pickTarget(eligible, state, { cooldownMs: SWEEP_COOLDOWN_H * 3600_000 });
    if (!target) { log(`every eligible platform is inside its ${SWEEP_COOLDOWN_H}h cooldown`); return { skipped: 'cooldown' }; }
  }

  const { platform, lens, lensIndex } = target;
  const cwd = registry[platform].path;
  const checkout = checkoutInfo(cwd);
  log(`sweep start: ${platform} [${lens.key}] in ${cwd} (mode=${MODE})` +
    (checkout.sha ? ` at ${checkout.sha}, HEAD is ${checkout.ageDays}d old` : ''));

  // A stale claude binary takes the whole fleet down quietly — the same gate the
  // orchestrator uses before it spends a job.
  const canary = await ensureClaudeVerified();
  if (!canary.ok) {
    log(`claude canary failed — holding: ${canary.detail}`);
    await notify({ source: 'code-health', level: 'warn', title: 'Code-health sweep held', body: `The claude CLI canary failed, so no review ran: ${canary.detail}`, speech: 'I held the code review — the claude binary needs checking.' });
    return { skipped: 'canary' };
  }

  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  const outFile = join(WORK_DIR, `${platform}-${lens.key}-${Date.now()}.json`);

  const review = await spawnClaude({
    prompt: reviewPrompt(platform, lens, outFile),
    cwd,
    timeoutMin: REVIEW_TIMEOUT_MIN,
  });

  if (review.limitHeld) {
    log('both subscription accounts are usage-limited — holding this sweep for the next tick');
    return { skipped: 'usage-limit' };   // deliberately NOT recorded as swept
  }
  if (review.code !== 0) {
    log(`review agent exited ${review.code} (timedOut=${review.timedOut}) — stderr: ${review.stderr.slice(0, 300)}`);
    await notify({ source: 'code-health', level: 'warn', title: `Code review failed on ${platform}`, body: `The ${lens.key} review agent exited ${review.code}${review.timedOut ? ' (timed out)' : ''}. Nothing was recorded.`, speech: `The code review on ${platform} failed.` });
    // Still advance the rotation: a lens that keeps failing must not block the others.
    state[platform] = { lastSweep: Date.now(), lensIndex: lensIndex + 1 };
    saveState(state);
    return { failed: true };
  }

  // The agent writes to a file rather than stdout because spawnClaude keeps only
  // the LAST 4000 characters of stdout — enough for a marker, not for findings.
  let rawText = '';
  if (existsSync(outFile)) rawText = readFileSync(outFile, 'utf8');
  else { log('agent printed a result but wrote no file — falling back to stdout'); rawText = review.stdout; }

  const { findings: rawFindings, error: parseError } = parseFindings(rawText);
  if (parseError) log(`parse: ${parseError}`);

  const normalized = rawFindings
    .map(r => normalizeFinding(r, { platform, lens: lens.key }))
    .filter(Boolean)
    .map(f => ({ ...f, commit_sha: checkout.sha }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .slice(0, MAX_FINDINGS);

  log(`review returned ${rawFindings.length} raw, ${normalized.length} usable finding(s)`);

  if (MODE === 'dry-run') {
    for (const f of normalized) log(`DRY-RUN would file [${f.severity}/${f.kind}] ${f.title} (${f.file_path}:${f.line || '?'})`);
    // A dry run must NOT consume the rotation slot (2026-07-30). It files
    // nothing, so advancing lastSweep/lensIndex would mark this platform+lens
    // as covered for the next 20 hours on the strength of a review whose results
    // were thrown away — the live sweep would then move on to a different lens
    // and this one would look done. Proving mode must not spend real coverage.
    log('DRY-RUN — rotation state NOT advanced, so a live sweep still owes this platform+lens');
    try { rmSync(outFile, { force: true }); } catch {}
    return { platform, lens: lens.key, dryRun: true, findings: normalized };
  }

  // ── file + verify ──
  const filed = [];
  let verifications = 0;
  for (const f of normalized) {
    let res;
    try { res = await upsertFinding(f); }
    catch (e) { log(`could not file "${f.title}": ${e.message}`); continue; }

    const entry = { ...f, id: res.id, created: res.created, regressed: res.regressed, suppressed: res.suppressed };

    // Only NEW findings get verified. Re-verifying something already judged is
    // pure spend, and a sticky `dismissed` in memory-server means a refuted
    // finding never comes back round to be argued about again.
    if (res.created && needsVerification(f) && verifications < MAX_VERIFICATIONS) {
      verifications++;
      const v = await spawnClaude({ prompt: verifyPrompt(platform, f), cwd, timeoutMin: VERIFY_TIMEOUT_MIN });
      let verdict = null;
      try {
        const m = v.stdout.match(/\{[\s\S]*\}/);
        if (m) verdict = JSON.parse(m[0]);
      } catch { /* unparseable verdict is treated as "unproven" below */ }

      if (verdict && verdict.real === true) {
        entry.status = 'confirmed';
        await patchFinding(res.id, { status: 'confirmed', verdict: String(verdict.why || '').slice(0, 800), severity: verdict.severity });
        if (verdict.severity) entry.severity = verdict.severity;
        log(`CONFIRMED [${entry.severity}] ${f.title}`);
      } else if (verdict && verdict.real === false) {
        entry.status = 'dismissed';
        await patchFinding(res.id, { status: 'dismissed', verdict: String(verdict.why || '').slice(0, 800) });
        log(`refuted — dismissed: ${f.title} (${String(verdict.why || '').slice(0, 120)})`);
      } else {
        entry.status = 'open';
        await patchFinding(res.id, { verdict: 'verifier produced no usable verdict — left unproven' });
        log(`unproven (no verdict) — left open: ${f.title}`);
      }
    }
    filed.push(entry);
  }

  // ── close the loop: has anything already been fixed? ──
  const closed = await recheckOldFindings(platform, cwd);

  state[platform] = { lastSweep: Date.now(), lensIndex: lensIndex + 1 };
  saveState(state);
  try { rmSync(outFile, { force: true }); } catch {}

  await report(platform, lens, filed, checkout, closed);
  return { platform, lens: lens.key, findings: filed, closed };
}

/**
 * Re-check the least-recently-checked confirmed findings for this platform.
 *
 * Without this the table only grows. Nothing else ever sets `fixed`: a defect
 * Craig repaired stayed "confirmed" forever, get_code_findings kept reciting it,
 * and the regression detection (fixed → found again) could never fire because
 * nothing was ever fixed in the first place. That is the firehose failure mode
 * one level up from the one fingerprints solve.
 *
 * Bounded to CODE_HEALTH_MAX_RECHECK agents per sweep, and only for the platform
 * being swept, so the cost per sweep stays flat however large the table grows.
 */
async function recheckOldFindings(platform, cwd) {
  const closed = [];
  if (MAX_RECHECK < 1) return closed;
  let rows = [];
  try {
    rows = await fetch(`${MEMORY}/memory/findings?platform=${encodeURIComponent(platform)}&status=confirmed&limit=100`)
      .then(r => r.json());
  } catch (e) {
    log(`recheck: could not read findings (${e.message})`);
    return closed;
  }
  if (!Array.isArray(rows) || !rows.length) return closed;

  // Don't re-check something we only just looked at. Without this the sweep
  // spends a verifier turn re-checking a finding IT confirmed ninety seconds
  // earlier — observed on the 2026-07-30 jarvis sweep — because a fresh finding
  // has no last_checked and therefore sorts first.
  const cutoff = new Date(Date.now() - RECHECK_MIN_AGE_H * 3600_000).toISOString();
  const staleFirst = rows
    .map(f => ({ f, checkedAt: String(f.last_checked || f.first_seen || '') }))
    .filter(x => x.checkedAt < cutoff)
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt))
    .slice(0, MAX_RECHECK)
    .map(x => x.f);
  if (!staleFirst.length) { log('recheck: nothing old enough to be worth re-checking'); return closed; }

  for (const f of staleFirst) {
    const v = await spawnClaude({ prompt: recheckPrompt(platform, f), cwd, timeoutMin: VERIFY_TIMEOUT_MIN });
    if (v.limitHeld) { log('recheck: usage-limited, stopping re-checks for this sweep'); break; }
    let verdict = null;
    try {
      const m = v.stdout.match(/\{[\s\S]*\}/);
      if (m) verdict = JSON.parse(m[0]);
    } catch { /* unparseable → treated as "still present" below */ }

    // Only an explicit false closes a finding. No verdict, an unparseable
    // verdict, or a dead agent all mean "we still believe it" — burying a real
    // defect is the more expensive mistake.
    if (verdict && verdict.still_present === false) {
      const why = String(verdict.why || '').slice(0, 600);
      await patchFinding(f.id, { status: 'fixed', checked: true, verdict: `RE-CHECKED and gone: ${why}` });
      closed.push({ ...f, why });
      log(`FIXED (re-check) [${f.severity}] ${f.title} — ${why.slice(0, 120)}`);
    } else {
      await patchFinding(f.id, { checked: true });
      log(`still present (re-check) [${f.severity}] ${f.title}`);
    }
  }
  return closed;
}

/**
 * Tell Craig — proportionately. A confirmed critical is a device push; anything
 * else is an inbox item he reads when he wants to. A sweep that found nothing
 * says so only in the log: "I looked and it's clean" is not worth a notification,
 * and this runs every few hours forever.
 */
async function report(platform, lens, filed, checkout = {}, closed = []) {
  const fresh = filed.filter(f => f.created && f.status !== 'dismissed');
  const confirmedCritical = fresh.filter(f => f.status === 'confirmed' && f.severity === 'critical');
  const regressions = filed.filter(f => f.regressed);

  // A sweep that only CLOSED things is worth one quiet line: it is the good news
  // this system otherwise never delivers, and it tells Craig the table is being
  // kept honest rather than just growing.
  if (!fresh.length && !regressions.length) {
    if (closed.length) {
      log(`nothing new; ${closed.length} old finding(s) confirmed fixed`);
      await notify({
        source: 'code-health', level: 'info',
        title: `${platform}: ${closed.length} code finding${closed.length === 1 ? '' : 's'} now fixed`,
        body: `${lens.key} pass found nothing new. Closed:\n` + closed.map(c => `- [${c.severity}] ${c.title}`).join('\n'),
        speech: `Good news on ${platform} — ${closed.length} of the old code findings are fixed.`,
      });
      return;
    }
    log('nothing new to report');
    return;
  }

  const lines = fresh.map(f => `[${f.severity}/${f.kind}] ${f.title} — ${f.file_path || '?'}${f.line ? ':' + f.line : ''}` +
    (f.status === 'confirmed' ? ' (verified)' : f.status === 'open' ? ' (unproven)' : ''));
  for (const r of regressions) lines.push(`[REGRESSION] ${r.title} — was fixed, it is back`);
  for (const c of closed) lines.push(`[FIXED] ${c.title}`);

  const level = confirmedCritical.length ? 'alert' : regressions.length ? 'warn' : 'info';
  const title = confirmedCritical.length
    ? `${confirmedCritical.length} critical code defect${confirmedCritical.length === 1 ? '' : 's'} in ${platform}`
    : `Code review: ${fresh.length} new finding${fresh.length === 1 ? '' : 's'} in ${platform}`;

  // Say which code was read. A finding against a checkout that is weeks behind
  // its remote may already be fixed upstream, and Craig should not have to
  // discover that himself after chasing one.
  const staleNote = checkout.sha
    ? `\n\nReviewed ${checkout.sha}, committed ${checkout.ageDays}d ago.` +
      (checkout.ageDays > 7 ? ' This checkout may be behind its remote — check before fixing.' : '')
    : '';

  await notify({
    source: 'code-health',
    level,
    title,
    body: `${platform} — ${lens.key} pass\n${lines.join('\n')}${staleNote}`,
    speech: confirmedCritical.length
      ? `Code review found ${confirmedCritical.length} critical problem${confirmedCritical.length === 1 ? '' : 's'} in ${platform}.`
      : `Code review on ${platform} found ${fresh.length} new thing${fresh.length === 1 ? '' : 's'} worth a look.`,
  });
}

// CLI entry. `node src/code-health.js [platform] [lensKey]` forces a target,
// which is how a sweep gets verified by hand before the timer is trusted.
if (import.meta.url === `file://${process.argv[1]}`) {
  runOnce({ platform: process.argv[2], lensKey: process.argv[3] })
    .then((r) => { log(`done: ${JSON.stringify(r?.skipped || r?.platform || r)}`); process.exit(0); })
    .catch((e) => { log(`fatal: ${e.message}`); process.exit(1); });
}

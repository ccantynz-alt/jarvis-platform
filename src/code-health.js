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
import { hasSource } from './lib/checkout.js';
import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import { spawnClaude, spawnClaudeRemote, ensureClaudeVerified } from './lib/spawn-agent.js';
import {
  normalizeFinding, parseFindings, needsVerification, pickTarget, severityRank, lensFor, LENSES,
  extractJsonObject, boolish,
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
// vapron came OFF this list 2026-08-08: the "can't SSH to 158" reason died when
// tailnet SSH was proven (Craig amended the no-box-to-box-SSH ruling the same
// day) — vapron now sweeps REMOTELY, see CODE_HEALTH_REMOTE below.
const DEFAULT_SKIP = ['craig-pc', 'screenshot-to-code'];
const SKIP = new Set((process.env.CODE_HEALTH_SKIP || DEFAULT_SKIP.join(',')).split(',').map(s => s.trim()).filter(Boolean));

// Platforms swept ON THEIR OWN BOX over tailnet SSH (2026-08-08). Explicit
// allowlist, not inference from server IPs — a full-permission spawn on the
// wrong machine is the fix-runner lesson one hop over. The remote box needs its
// own claude CLI + subscription login (158 has both, verified 2.1.223).
// Remote spawns bypass claude-auth's two-account failover; a usage-limit exit
// is logged distinctly below rather than flipped-and-retried.
const REMOTE_OK = new Set((process.env.CODE_HEALTH_REMOTE || 'vapron').split(',').map(s => s.trim()).filter(Boolean));

// Read-only remote shell — BatchMode so a broken tailnet fails fast and
// visibly instead of hanging a sweep on an interactive prompt.
function sshRun(server, cmd) {
  return execFileSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=no',
    '-i', '/opt/jarvis/.ssh/orchestrator', `root@${server}`, cmd,
  ], { encoding: 'utf8', timeout: 30_000 }).trim();
}

// Which server a platform's sweep should run on, or null for local.
export function remoteFor(platform, entry, { ownIp = OWN_IP, allow = REMOTE_OK } = {}) {
  if (!allow.has(platform)) return null;
  const s = entry?.server;
  if (!s || s === ownIp || !/^\d+\.\d+\.\d+\.\d+$/.test(s)) return null;
  return s;
}

// hasSource, over ssh — mirrors lib/checkout.js's SOURCE_RE question ("is
// there code to READ") without pulling any product source onto this box.
function remoteHasSource(server, path) {
  try {
    const out = sshRun(server,
      `test -d ${path} && find ${path} -maxdepth 2 ` +
      `\\( -name node_modules -o -name .git -o -name venv -o -name dist -o -name .next \\) -prune -o ` +
      `-type f \\( -name '*.js' -o -name '*.ts' -o -name '*.tsx' -o -name '*.py' -o -name '*.rs' -o -name '*.go' -o -name '*.rb' -o -name '*.sh' -o -name '*.sql' \\) -print 2>/dev/null | head -1`);
    return out.length > 0;
  } catch { return false; }
}

function checkoutInfoRemote(server, cwd) {
  try {
    const sha = sshRun(server, `git -C ${cwd} -c safe.directory=${cwd} rev-parse --short HEAD`);
    const iso = sshRun(server, `git -C ${cwd} -c safe.directory=${cwd} log -1 --format=%cI`);
    const ageDays = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000);
    return { sha, iso, ageDays };
  } catch {
    return { sha: null, iso: null, ageDays: null };
  }
}

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
 * with a path, hosted here, not on the skip list, and with source actually in
 * that path. A review of a codebase we cannot open would be a review of the
 * model's imagination.
 *
 * The last condition was added 2026-07-30 after the timer proved it necessary: it
 * picked `zoobicon` at /root/zoobicon, a directory holding nothing but a `.claude`
 * folder, spent a review agent, returned zero findings in 25 seconds and then
 * recorded the platform as SWEPT — so Craig's flagship would have read as reviewed,
 * with a 20-hour cooldown, having never been read. `exists(path)` was true, which
 * was the whole of the test. Exactly the mistake the audit runner made with
 * /var/www, in a second place, found the same day.
 */
export function eligiblePlatforms(registry, { ownIp = OWN_IP, skip = SKIP, exists = existsSync, source = hasSource, remoteSource = remoteHasSource, allowRemote = REMOTE_OK } = {}) {
  return Object.entries(registry)
    .filter(([name, e]) => e && e.status === 'active' && !skip.has(name) && e.executor !== 'pc')
    .filter(([name, e]) => {
      // Remote platform (2026-08-08): swept on its own box over tailnet SSH.
      // The source check runs there too — "a path is a claim", on any machine.
      const remote = remoteFor(name, e, { ownIp, allow: allowRemote });
      if (remote) {
        if (e.path && remoteSource(remote, e.path)) return true;
        log(`skipping ${name}: remote ${remote}:${e.path || '(no path)'} unreachable or holds no source`);
        return false;
      }
      if (!(e.server === ownIp && e.path && exists(e.path))) return false;
      if (source(e.path)) return true;
      log(`skipping ${name}: ${e.path} exists but contains no source — nothing to review`);
      return false;
    })
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
  // `-c safe.directory` and an explicit HOME, because this silently failed on the
  // one platform where the sha matters most (2026-07-30).
  //
  // /opt/alecrae is owned by alecrae:alecrae and this service runs as root, so git
  // refuses it with "detected dubious ownership" unless an exception is
  // configured. Root's ~/.gitconfig HAS that exception — which is why it works by
  // hand and why this looked fine — but jarvis-code-health.service sets no `User=`
  // and no `Environment=HOME`, so systemd gives the process no HOME at all and git
  // never reads that file. spawn-agent.js sets HOME=/root explicitly for the claude
  // spawns, which is why the review agents worked while this one call did not.
  //
  // The cost was not cosmetic. checkoutInfo() failed, the sweep logged "NOT a git
  // checkout, no commit recorded", and the findings were filed with a NULL
  // commit_sha — against a tree 28 commits behind origin/main. Two of the three
  // confirmed highs from that sweep are already fixed upstream (93d6ac2 "account
  // deletion honors a real 30-day soft-delete window" and 1d7f56b "close
  // cross-tenant passkey deletion"), so an adversarial verifier was spent proving
  // that fixed code is broken, and Craig would have been sent to fix it twice.
  // Recording the sha is the safeguard against exactly that; it has to actually run.
  //
  // Passing the setting on the command line rather than writing anyone's gitconfig
  // keeps this read-only and independent of ambient state — it works whatever HOME
  // is and whoever owns the checkout.
  const git = (args) => execFileSync('git', ['-c', `safe.directory=${cwd}`, ...args], {
    cwd, encoding: 'utf8', timeout: 10_000, env: { ...process.env, HOME: process.env.HOME || '/root' },
  }).trim();
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

  const { platform, lensIndex } = target;
  let { lens } = target;
  const cwd = registry[platform].path;
  // Remote sweep (2026-08-08): agents spawn ON the platform's own box over
  // tailnet SSH; git info and the findings file travel over the same channel.
  const remoteServer = remoteFor(platform, registry[platform]);
  const spawnAgent = (opts) => remoteServer
    ? spawnClaudeRemote({ ...opts, server: remoteServer })
    : spawnClaude(opts);
  const checkout = remoteServer ? checkoutInfoRemote(remoteServer, cwd) : checkoutInfo(cwd);

  // The recent-changes lens is entirely `git log -20 --stat`, so on a directory
  // with no version control it spends a full review agent discovering there is no
  // history. /root/universal-ai-operator is exactly that — no .git at all
  // (2026-07-30) — so skip to the next lens rather than waste the sweep.
  if (lens.key === 'recent-changes' && !checkout.sha) {
    const next = lensFor(lensIndex + 1);
    log(`${platform} is not a git checkout — the ${lens.key} lens has nothing to read, using ${next.key} instead`);
    lens = next;
  }

  log(`sweep start: ${platform} [${lens.key}] in ${remoteServer ? `${remoteServer}:` : ''}${cwd} (mode=${MODE})` +
    (checkout.sha ? ` at ${checkout.sha}, HEAD is ${checkout.ageDays}d old` : ' — NOT a git checkout, no commit recorded'));

  // A stale claude binary takes the whole fleet down quietly — the same gate the
  // orchestrator uses before it spends a job. The canary gates the LOCAL binary;
  // a remote sweep runs the remote box's own binary, whose model-rejection shows
  // up as a nonzero exit below rather than being pre-gated here.
  if (!remoteServer) {
    const canary = await ensureClaudeVerified();
    if (!canary.ok) {
      log(`claude canary failed — holding: ${canary.detail}`);
      await notify({ source: 'code-health', level: 'warn', title: 'Code-health sweep held', body: `The claude CLI canary failed, so no review ran: ${canary.detail}`, speech: 'I held the code review — the claude binary needs checking.' });
      return { skipped: 'canary' };
    }
  }

  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });
  // A remote agent cannot write to this box's WORK_DIR — its findings file
  // lives on ITS box and comes home over ssh after the run.
  const outFile = remoteServer
    ? `/tmp/jarvis-code-health-${platform}-${lens.key}-${Date.now()}.json`
    : join(WORK_DIR, `${platform}-${lens.key}-${Date.now()}.json`);

  const review = await spawnAgent({
    prompt: reviewPrompt(platform, lens, outFile),
    cwd,
    timeoutMin: REVIEW_TIMEOUT_MIN,
  });
  // Remote spawns bypass two-account failover — name a usage-limit for what it
  // is instead of letting it wear a generic failure's clothes.
  if (remoteServer && review.code !== 0 && /usage limit|rate.?limit/i.test(review.stdout + review.stderr)) {
    log(`remote ${remoteServer} claude login is usage-limited — sweep failed there, not here`);
  }

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
  // Remote: the file is on the other box; fetch it over the same ssh channel.
  let rawText = '';
  if (remoteServer) {
    try { rawText = sshRun(remoteServer, `cat ${outFile}`); }
    catch { log('remote agent wrote no findings file — falling back to stdout'); rawText = review.stdout; }
  } else if (existsSync(outFile)) rawText = readFileSync(outFile, 'utf8');
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
    if (remoteServer) { try { sshRun(remoteServer, `rm -f ${outFile}`); } catch { /* remote /tmp clears itself */ } }
    else { try { rmSync(outFile, { force: true }); } catch {} }
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

    // Is there already a DISMISSED finding in this same file? (2026-07-30)
    //
    // Fingerprints key on the SORTED SIGNIFICANT WORDS of the title, which
    // deliberately makes them word-order-independent — but two agents can
    // describe one defect with almost no shared vocabulary. Observed the same
    // day: "a single process-global object shared by every WebSocket connection"
    // and "module-level, shared by every connected deck client" are the same
    // defect and hash differently, so a finding I had dismissed with reasoning
    // came straight back as new, and spent another verifier turn.
    //
    // Deliberately only a NOTE, not suppression: silently merging on
    // same-file-proximity would hide a genuinely different defect behind one
    // dismissal, which is far worse than an occasional duplicate. This just makes
    // the duplicate visible to whoever reads it next.
    // Held in a variable, not just written, because `verdict` belongs to the
    // verifier and it patches the same field a few lines below — so on any
    // finding that got verified, this note was written and then immediately
    // overwritten (2026-07-30, found by the spine reviewing itself). Those are
    // precisely the findings someone reads. Every verdict written after this point
    // appends it.
    let dupNote = null;
    if (res.created && f.file_path) {
      try {
        // Two different questions, and the second one was missing (2026-07-31).
        //
        // DISMISSED siblings in the same file: a paraphrase of something already
        // refuted, worth flagging before anyone spends time on it.
        //
        // OPEN or CONFIRMED siblings at the same file AND THE SAME LINE: almost
        // certainly the SAME defect, re-worded. Proven on the gatetest sweep that
        // prompted this — #108 "On a Stripe webhook retry the MCP tier emails a
        // freshly generated API key that the upsert deliberately does not store"
        // and #18 "MCP subscription webhook e-mails a freshly generated API key on
        // every Stripe retry while the database keeps the original" are the same
        // bug at website/app/api/stripe-webhook/route.ts:223, and fingerprints key
        // on the title's significant words, so the rewording filed a second row.
        // That one sweep then confirmed it TWICE: a fresh adversarial verifier on
        // the new row, and the re-check pass on the old one. Two verifier spends
        // and two entries in Craig's table for one defect.
        //
        // Still a NOTE and not a merge, deliberately: two genuinely distinct
        // defects can share a line, and silently collapsing them would hide one
        // behind the other's verdict. The line match just makes the note worth
        // reading rather than routine.
        const all = await fetch(`${MEMORY}/memory/findings?platform=${encodeURIComponent(platform)}&limit=200`)
          .then(r => r.json());
        const list = Array.isArray(all) ? all : [];
        const sameFile = list.filter(s => s.file_path === f.file_path && s.id !== res.id);
        const dismissed = sameFile.filter(s => s.status === 'dismissed');
        const sameLine = sameFile.filter(s => (s.status === 'open' || s.status === 'confirmed')
          && Number.isFinite(f.line) && s.line === f.line);

        const parts = [];
        if (sameLine.length) {
          const ids = sameLine.map(s => `#${s.id}`).join(', ');
          log(`note: ${f.file_path}:${f.line} ALREADY has open finding(s) ${ids} at the same line — likely the same defect, reworded`);
          parts.push(`LIKELY DUPLICATE: ${ids} ${sameLine.length === 1 ? 'is' : 'are'} already open at `
            + `${f.file_path}:${f.line}. Fingerprints key on the title's significant words, so a rewording of the same `
            + 'defect files a second row and gets verified a second time. Compare before treating this as new work.');
        }
        if (dismissed.length) {
          const ids = dismissed.map(s => `#${s.id}`).join(', ');
          log(`note: ${f.file_path} already has ${dismissed.length} DISMISSED finding(s) (${ids}) — this may be a reworded duplicate`);
          parts.push(`NOTE: ${f.file_path} already carries dismissed finding(s) ${ids} — a paraphrase of an `
            + 'already-refuted defect files again, so check those before spending time on this one.');
        }
        if (parts.length) {
          dupNote = parts.join('\n\n');
          await patchFinding(res.id, { verdict: dupNote });
        }
      } catch { /* advisory only — never let this break a sweep */ }
    }
    const withNote = (verdict) => (dupNote ? `${verdict}\n\n${dupNote}` : verdict);

    // Only NEW findings get verified. Re-verifying something already judged is
    // pure spend, and a sticky `dismissed` in memory-server means a refuted
    // finding never comes back round to be argued about again.
    if (res.created && needsVerification(f) && verifications < MAX_VERIFICATIONS) {
      verifications++;
      const v = await spawnAgent({ prompt: verifyPrompt(platform, f), cwd, timeoutMin: VERIFY_TIMEOUT_MIN });
      // extractJsonObject, not a greedy brace regex. See its comment in
      // lib/findings.js: the regex it replaces lost THREE of four verdicts on the
      // 2026-07-30 jarvis sweep, and a lost verdict silently becomes "unproven".
      const verdict = extractJsonObject(v.stdout, ['real']);
      const real = verdict ? boolish(verdict.real) : null;

      if (real === true) {
        entry.status = 'confirmed';
        await patchFinding(res.id, { status: 'confirmed', verdict: withNote(String(verdict.why || '').slice(0, 800)), severity: verdict.severity });
        if (verdict.severity) entry.severity = verdict.severity;
        log(`CONFIRMED [${entry.severity}] ${f.title}`);
      } else if (real === false) {
        entry.status = 'dismissed';
        await patchFinding(res.id, { status: 'dismissed', verdict: withNote(String(verdict.why || '').slice(0, 800)) });
        log(`refuted — dismissed: ${f.title} (${String(verdict.why || '').slice(0, 120)})`);
      } else {
        entry.status = 'open';
        await patchFinding(res.id, { verdict: withNote('verifier produced no usable verdict — left unproven') });
        log(`unproven (no verdict) — left open: ${f.title}`);
      }
    }
    filed.push(entry);
  }

  // ── close the loop: has anything already been fixed? ──
  const closed = await recheckOldFindings(platform, cwd, spawnAgent);

  state[platform] = { lastSweep: Date.now(), lensIndex: lensIndex + 1 };
  saveState(state);
  if (remoteServer) { try { sshRun(remoteServer, `rm -f ${outFile}`); } catch { /* remote temp file — next boot clears /tmp */ } }
  else { try { rmSync(outFile, { force: true }); } catch {} }

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
async function recheckOldFindings(platform, cwd, spawnAgent = spawnClaude) {
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
    const v = await spawnAgent({ prompt: recheckPrompt(platform, f), cwd, timeoutMin: VERIFY_TIMEOUT_MIN });
    if (v.limitHeld) { log('recheck: usage-limited, stopping re-checks for this sweep'); break; }
    const verdict = extractJsonObject(v.stdout, ['still_present']);
    const stillPresent = verdict ? boolish(verdict.still_present) : null;

    // Only an explicit false closes a finding. No verdict, an unparseable
    // verdict, or a dead agent all mean "we still believe it" — burying a real
    // defect is the more expensive mistake.
    if (stillPresent === false) {
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

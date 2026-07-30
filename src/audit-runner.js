import { spawnSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import express from 'express';
import Database from 'better-sqlite3';
import { notify } from './lib/notify.js';
import { resolveAuditStatus } from './lib/health-status.js';
import { checkoutProblem } from './lib/checkout.js';

mkdirSync('/opt/jarvis/reports', { recursive: true });

const app = express();
app.use(express.json());
const db = new Database('/opt/jarvis/memory/jarvis.db');
// Additive migration (memory-server.js pattern) — this service writes to the
// SAME platform_state table memory-server.js owns, directly via sqlite, so
// it carries its own migration for the column it needs rather than assuming
// startup order.
try { db.exec('ALTER TABLE platform_state ADD COLUMN consecutive_critical INTEGER DEFAULT 0'); } catch { /* already present */ }

const GATETEST_ADMIN_PASSWORD = process.env.GATETEST_ADMIN_PASSWORD;
const ORCHESTRATOR = 'http://127.0.0.1:9205';
// Self-repair for routine audits (2026-07-22, Craig: "so many audits... still
// doing repairs manually" — audits found real errors and scored them for
// weeks but nothing ever acted on the findings). Same guardrail shape as
// deploy-gate.js's auto-fix: cap consecutive auto-dispatches per platform so
// a genuinely unfixable/flaky audit escalates to a human instead of looping.
const AUTO_FIX_MAX_ATTEMPTS = 2;

const PLATFORM_CONFIG = {
  // zoobicon moved to URL_ONLY_CONFIG on 2026-07-30 — see the note there. It has
  // no usable checkout on this box, so there was never anything here to build.
  // Added 2026-07-22 (Craig: audit the other 8 platforms). Path/tech-stack
  // from config/platforms.json; build/test commands inferred from tech
  // stack (npm for TS/React, bun for the Bun-based stack), matching the
  // pattern already used above — not independently verified against each
  // repo's actual package.json scripts, so if these commands don't exist
  // the audit will just show a build failure the first run, not silently
  // succeed on the wrong thing.
  bookaride: {
    path: process.env.BOOKARIDE_PATH || '/root/bookaride',
    urls: ['https://www.bookaride.co.nz'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  gluecron: {
    path: process.env.GLUECRON_PATH || '/root/gluecron',
    urls: ['https://gluecron.com'],
    // 2026-07-24: verified against /root/gluecron/package.json on the box —
    // there IS no `build` script (scripts: dev/start/db:*/test/typecheck/
    // preflight/doctor/e2e). The earlier guessed `bun run build` would have
    // false-criticaled a healthy platform on every nightly audit.
    buildCmd: 'bun run typecheck',
    testCmd: 'bun run test',
    checkCmd: null
  },
  alecrae: {
    // /opt/alecrae, per config/platforms.json and CLAUDE.md — AlecRae runs on
    // THIS box. This said /var/www/alecrae, which has never existed here, so the
    // commands below had never once run; see lib/checkout.js for what that
    // silently produced every day instead.
    path: process.env.ALECRAE_PATH || '/opt/alecrae',
    urls: ['https://alecrae.com'],
    // NON-MUTATING on purpose (Rule 4). Fixing the path meant these commands were
    // about to run for the first time ever inside a LIVE co-tenant: alecrae-api
    // and alecrae-web are both active and /opt/alecrae is their working tree.
    // `npm run build` was configured, which was wrong twice over — the repo is bun
    // (packageManager: bun@1.2.0), and `turbo run build` would regenerate Next.js
    // output underneath the running :4200 server. `bun run typecheck` reads the
    // code and writes nothing; same reasoning and shape as gluecron above.
    //
    // MEASURED 2026-07-30, because the first real run OOM-killed jarvis-audit at
    // 72 seconds: a cold `turbo run typecheck --force` exits 137 under 1536M and
    // exits 0 under 2G, so the unit's ceiling went to 2560M (~25% headroom; the
    // box has 7.9G total and 4.9G available). All 36 tasks pass — AlecRae's
    // TypeScript is clean. A warm run is 807ms and fully cached.
    buildCmd: 'bun run typecheck',
    // testCmd left null deliberately: `turbo run test` in a monorepo that also
    // carries db:migrate/db:push scripts and k6 load-test targets is not something
    // to start unattended against a live co-tenant. Enabling it is Craig's call.
    testCmd: null,
    checkCmd: null
  },
  gatetest: {
    path: process.env.GATETEST_PATH || '/opt/gatetest',
    urls: ['https://gatetest.ai'],
    buildCmd: 'node --test tests/*.test.js',
    testCmd: 'node --test tests/*.test.js',
    checkCmd: 'node bin/gatetest.js --list',
    // Extra env vars injected into every command for this platform
    env: GATETEST_ADMIN_PASSWORD ? { GATETEST_ADMIN_PASSWORD } : {},
  },
  // Web portion only (Craig's call, 2026-07-22) — voxlen's tech stack also
  // includes Rust/Tauri (desktop) + Swift (mobile); a full cross-platform
  // build is too slow/complex for a daily automated audit, so this only
  // builds/tests the web/React part. Desktop/mobile builds are NOT covered.
  voxlen: {
    path: process.env.VOXLEN_PATH || '/root/voxlen',
    urls: ['https://www.voxlen.ai'],
    buildCmd: 'npm run build',
    testCmd: 'npm test',
    checkCmd: null
  },
  // noAutoFix: true (Craig's call, 2026-07-22) — audit for visibility, but
  // never auto-dispatch a fix job for these two:
  //   - universal-ai-operator: no git remote (platforms.json confirms "no
  //     git remote as of 2026-07-06") — a dispatched agent's mandatory
  //     "commit and push" step (buildPrompt() in orchestrator.js) would
  //     have nowhere to push to, wasting the job.
  //   - screenshot-to-code: a third-party fork (abi/screenshot-to-code),
  //     not Craig's own code — auto-committing "fixes" here risks silently
  //     diverging from upstream in a way nobody would notice until an
  //     update conflicts with it.
  'universal-ai-operator': {
    path: process.env.UAO_PATH || '/root/universal-ai-operator',
    urls: [], // no public domain (platforms.json) — screenshots skipped, build/test still run
    buildCmd: 'docker compose build',
    testCmd: null,
    checkCmd: null,
    noAutoFix: true
  },
  'screenshot-to-code': {
    path: process.env.SCREENSHOT_TO_CODE_PATH || '/opt/screenshot-to-code',
    urls: ['http://127.0.0.1:5173', 'http://127.0.0.1:7001'], // loopback-only per platforms.json, no public domain
    buildCmd: 'docker compose build',
    testCmd: null,
    checkCmd: null,
    noAutoFix: true
  },
};

// marcoreid/davenroe (Craig's call, 2026-07-22): Vercel-hosted, no local
// checkout on this box at all (platforms.json path is "") — the normal
// build/test-in-a-local-directory model can't work for them, and dispatch
// can't push a fix for a platform with no local path either. Lighter
// variant: screenshot + live-URL health check only, no build/test, no
// auto-fix-dispatch (there is no local repo to dispatch a fix against).
//
// vapron (moved here 2026-07-23): found chasing Craig's report of Vapron
// flip-flopping between "critical" and "healthy". vapron's `server` in
// config/platforms.json is 100.89.227.39 (box 158), NOT this box, and
// audit-runner was running `bun run build` against /var/www/vapron — failing
// every daily audit and tanking the score to critical, while fleet-check's HTTP
// check correctly reported healthy ten minutes later.
//   CORRECTION 2026-07-30: that fix's note claimed vapron's code "has never
//   existed locally here under any path". Not true — /root/vapron has been a full
//   checkout since 2026-07-01 (last commit 2026-06-30, so ~30 days stale). The
//   CONFIGURED path was simply wrong, which is the very same defect that was
//   still live for zoobicon and alecrae a week later. Staying URL-only is still
//   right: a month-old copy of a codebase deployed from another box would audit
//   the wrong thing. Building on 158 over the tailnet remains the real fix.
//
// zoobicon (moved here 2026-07-30): audited daily for weeks against
// /var/www/zoobicon, which does not exist. config/platforms.json points at
// /root/zoobicon, and that directory holds nothing but a `.claude` folder — no
// source, no package.json — so there is no checkout on this box either way.
// Craig's flagship was handed a fabricated 70/'warning' every day, in silence.
// URL-only until the repo is genuinely cloned here; then it can move back, and
// lib/checkout.js's guard will keep it honest.
const URL_ONLY_CONFIG = {
  marcoreid: { urls: ['https://www.marcoreid.com'] },
  davenroe: { urls: ['https://www.davenroe.com'] },
  vapron: { urls: ['https://vapron.ai'] },
  zoobicon: { urls: ['https://zoobicon.com', 'https://zoobicon.com/builder'] },
};

// Fixed 2026-07-24 (docs/AUDIT-2026-07-17.md finding #3): this used to be
// plain execSync, whose `timeout` only kills the DIRECT child (the shell) —
// any grandchildren a test runner forks (gatetest's own test processes,
// confirmed: 22 of them leaked, oldest 10.5 days, ~2/day accumulating,
// each holding a loopback port and RSS) survive that kill and never get
// reaped. spawnSync + detached:true puts the whole command in its OWN
// process group, so it can be killed as a group afterward regardless of
// whether it finished, timed out, or errored.
function runCmd(cmd, cwd, timeoutMs = 120000, extraEnv = {}) {
  const result = spawnSync(cmd, {
    cwd,
    shell: true,
    detached: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, ...extraEnv },
  });
  if (result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* group already gone — fine */ }
  }
  const ok = result.status === 0 && !result.error && !result.signal;
  const output = ok
    ? (result.stdout || '').slice(0, 8000)
    : ((result.stdout || '') + '\n' + (result.stderr || '') + (result.error ? `\n${result.error.message}` : '')).slice(0, 8000);
  return { ok, output };
}

function extractErrors(output) {
  const errors = [];
  const lines = output.split('\n');
  for (const line of lines) {
    if (
      line.match(/error(\s|:)/i) ||
      line.includes('Error:') ||
      line.includes('error TS') ||
      line.includes('Failed to compile') ||
      line.includes('Cannot find') ||
      line.includes('Module not found') ||
      line.match(/✗|×\s/) ||
      line.includes('FAIL ')
    ) {
      const clean = line.trim();
      if (clean.length > 5 && clean.length < 300) {
        errors.push(clean);
      }
    }
  }
  return [...new Set(errors)].slice(0, 50);
}

function getConsecutiveCritical(platform) {
  const row = db.prepare('SELECT consecutive_critical FROM platform_state WHERE platform = ?').get(platform);
  return row?.consecutive_critical || 0;
}

function getExistingNotes(platform) {
  const row = db.prepare('SELECT notes FROM platform_state WHERE platform = ?').get(platform);
  return row?.notes ?? null;
}

function getExistingStatus(platform) {
  const row = db.prepare('SELECT status FROM platform_state WHERE platform = ?').get(platform);
  return row?.status ?? null;
}

// Is there already a job in flight for this platform? Don't pile a second
// auto-dispatch on top of one still running from a prior audit.
async function hasJobInFlight(platform) {
  try {
    const rows = await fetch(`${ORCHESTRATOR}/jobs`).then(r => r.json());
    return (Array.isArray(rows) ? rows : []).some(j => j.platform === platform && (j.status === 'running' || j.status === 'queued'));
  } catch {
    return false; // orchestrator unreachable — don't block the audit on this
  }
}

async function dispatchAutoFix(platform, report) {
  const errorList = report.errors.slice(0, 15).join('\n');
  const task = `The daily audit for ${platform} scored ${report.health_score}/100 (${report.status}). ` +
    `Build ${report.build?.ok ? 'passed' : 'FAILED'}${report.tests ? `, tests ${report.tests.ok ? 'passed' : 'FAILED'}` : ''}. ` +
    `Errors found:\n${errorList}\n\nInvestigate and fix these, verify with the project's own build/test commands, then commit and push as usual.`;
  try {
    const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, task, enqueued_by: 'audit-runner-auto-fix' }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body?.error || `dispatch ${r.status}`);
    return body.jobId;
  } catch (e) {
    console.error(`[audit] auto-fix dispatch failed for ${platform}: ${e.message}`);
    return null;
  }
}

async function takeScreenshots(platform, urls) {
  const results = [];
  for (const url of urls) {
    try {
      const r = await fetch('http://127.0.0.1:9201/screenshot/capture', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(35000)
      });
      const data = await r.json();
      results.push({ url, ...data });
    } catch (e) {
      results.push({ url, ok: false, error: e.message });
    }
  }
  return results;
}

/**
 * Real HTTP status for each URL — the check the url-only audit never had.
 * Follows redirects (a 301 to www is not a fault) and treats a timeout or DNS
 * failure as status 0 rather than throwing, so one bad URL cannot abort a sweep.
 */
async function probeUrls(urls = []) {
  const out = [];
  for (const url of urls) {
    // TWO attempts before calling a URL down. One dropped request is not an
    // outage, and a false "critical" here auto-dispatches a repair agent — the
    // 2026-07-24 complaint was literally "we are getting false reports of
    // websites being down". self-heal re-probes live for the same reason.
    let last = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
        last = { url, status: r.status, ok: r.ok };
      } catch (e) {
        last = { url, status: 0, ok: false, error: e.message };
      }
      if (last.ok) break;
      if (attempt === 0) await new Promise(r => setTimeout(r, 3000));
    }
    out.push(last);
  }
  return out;
}

// Shared write + notify tail for both audit shapes below — same
// platform_state row shape and self-repair notify pattern either way.
function writeAuditState(platform, report) {
  const priorConsecutive = getConsecutiveCritical(platform);
  const newConsecutive = report.status === 'critical' ? priorConsecutive + 1 : 0;

  // NEVER let a build/test verdict overwrite a live-uptime failure (2026-07-30,
  // the dangerous half of the "platform_state has two writers" problem in the
  // 2026-07-26 audit backlog).
  //
  // status means two different things depending on who wrote it last:
  // fleet-check.sh writes 'error' when the public URL stops answering, and this
  // function writes 'healthy' when a build and its tests pass. An audit landing
  // on a site that is DOWN would write 'healthy' over that 'error' — and
  // self-heal only ever acts on status === 'error', so the repair that outage
  // exists to trigger would silently never happen.
  //
  // A passing build is not evidence the site is up. Only a real HTTP probe is,
  // which is why report.http (not the screenshots — Chromium photographs a 500
  // page quite happily) is the one thing allowed to clear an 'error'. The rule
  // lives in lib/health-status.js so it can be unit-tested: it decides whether an
  // outage gets repaired, and this file opens SQLite at import.
  const resolved = resolveAuditStatus({
    existingStatus: getExistingStatus(platform),
    reportStatus: report.status,
    http: report.http,
  });
  const status = resolved.status;
  if (resolved.preserved) console.log(`[audit] ${platform}: keeping status=error — ${resolved.reason}`);
  // Preserve `notes` (2026-07-24 — same INSERT OR REPLACE column-loss bug
  // found in memory-server.js's /memory/platform/update, mirrored here:
  // this write never included `notes`, so every audit run silently wiped
  // whatever fleet-check.sh had last written there — confirmed live
  // earlier today, "notes":null right after a manual audit trigger).
  const existingNotes = getExistingNotes(platform);
  db.prepare(`
    INSERT OR REPLACE INTO platform_state
    (platform, status, last_known_errors, last_audit, last_screenshot, health_score, consecutive_critical, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    platform, status, JSON.stringify(report.errors), new Date().toISOString(),
    report.screenshots.find(s => s.ok)?.filepath || null, report.health_score, newConsecutive, existingNotes, new Date().toISOString()
  );
  return newConsecutive;
}

// A "critical" audit is about BUILD/TEST health of the local checkout —
// Craig kept reading these as "website down" when the live sites were fine
// (2026-07-24: "we are getting false reports of websites being down").
// Every notification now states the live-site status explicitly, taken from
// the same screenshots the audit just captured.
function liveSiteLine(report) {
  // Prefer real HTTP status where we have it (url-only audits): "it rendered" is
  // a weaker claim than "it answered 200", and a 500 page renders fine.
  const http = report.http || [];
  if (http.length) {
    const up = http.filter(c => c.ok).length;
    const detail = http.map(c => `${c.url} → ${c.status || c.error || 'unreachable'}`).join('; ');
    return up === http.length ? `Live site is UP (${up}/${http.length} URLs answered 2xx).`
      : `Live site is NOT fully answering (${up}/${http.length} 2xx): ${detail}`;
  }
  const shots = report.screenshots || [];
  if (!shots.length) return 'Live site not probed by this audit.';
  const up = shots.filter(s => s.ok).length;
  return up === shots.length ? `Live site is UP (${up}/${shots.length} pages render) — this is about the local build/tests, not uptime.`
    : up > 0 ? `Live site PARTIALLY renders (${up}/${shots.length} pages).`
    : 'Live site pages also failed to render — possibly a real outage.';
}

async function notifyAuditResult(platform, report, newConsecutive, { noAutoFix = false } = {}) {
  if (report.status !== 'critical') return;
  const siteLine = liveSiteLine(report);
  const siteUp = siteLine.startsWith('Live site is UP');
  if (noAutoFix) {
    await notify({
      source: 'audit-runner', level: 'warn',
      title: `⚠️ ${platform} build/test audit critical (${report.health_score}/100) — no auto-fix (${noAutoFix === 'no-remote' ? 'no git remote' : noAutoFix === 'url-only' ? 'no local checkout' : 'third-party code'})`,
      body: `${siteLine} Errors: ${report.errors.slice(0, 5).join('; ')}`,
      speech: `Sir, ${platform}'s audit came back critical${siteUp ? ', though the live site itself is up' : ''} — this one needs your eyes, I can't auto-fix it.`,
    }).catch(() => {});
    return;
  }
  if (await hasJobInFlight(platform)) {
    console.log(`[audit] ${platform}: critical but a job is already running — not piling on`);
  } else if (newConsecutive <= AUTO_FIX_MAX_ATTEMPTS) {
    const jobId = await dispatchAutoFix(platform, report);
    await notify({
      source: 'audit-runner', level: 'warn',
      title: `🔧 ${platform} build/test audit critical (${report.health_score}/100) — auto-fix ${jobId ? 'dispatched' : 'FAILED to dispatch'}`,
      body: `${siteLine} ${jobId
        ? `Job ${jobId}, attempt ${newConsecutive}/${AUTO_FIX_MAX_ATTEMPTS}. Errors: ${report.errors.slice(0, 5).join('; ')}`
        : `Dispatch failed — this needs a human look. Errors: ${report.errors.slice(0, 5).join('; ')}`}`,
      speech: jobId
        ? `Sir, ${platform}'s build checks failed${siteUp ? ' — the live site is still up' : ''} — I've dispatched a fix.`
        : `Sir, ${platform}'s audit is critical and I couldn't auto-dispatch a fix — this needs you.`,
    }).catch(() => {});
  } else {
    await notify({
      source: 'audit-runner', level: 'alert',
      title: `🚨 ${platform} — ${AUTO_FIX_MAX_ATTEMPTS} auto-fix attempts still critical, ESCALATED not re-dispatching`,
      body: `Errors: ${report.errors.slice(0, 8).join('; ')}`,
      speech: `Sir, ${platform} has failed ${AUTO_FIX_MAX_ATTEMPTS} auto-fix attempts in a row and still looks critical — I've stopped re-dispatching, this needs your eyes.`,
    }).catch(() => {});
  }
}

// Lighter shape for Vercel-hosted platforms with no local checkout on this
// box (marcoreid, davenroe) — screenshot + live-URL health check only. No
// build/test (nothing local to build), no auto-fix-dispatch (nothing local
// to push a fix from — orchestrator dispatch needs entry.path/isLocal,
// neither of which exists for these).
async function runUrlOnlyAudit(platform, config) {
  const auditId = Date.now();
  const report = { platform, audit_id: auditId, timestamp: new Date().toISOString(), build: null, tests: null, checks: null, screenshots: [], errors: [], health_score: 100 };

  console.log(`[audit] ${platform}: url-only audit (no local checkout) — probing + capturing screenshots...`);
  // HTTP status FIRST (2026-07-30). This audit used to score purely on whether
  // Chromium could take a picture — and Chromium screenshots a 500 error page
  // perfectly happily, so a dead site scored 100/100 "healthy". Worse:
  // writeAuditState() below writes that status and score into platform_state,
  // the same row fleet-check.sh writes status='error' to and the same row
  // self-heal.js reads — so a URL-only audit could ERASE a real outage signal
  // and stop the repair that signal exists to trigger. CLAUDE.md described this
  // audit as "screenshot + health check"; the health check was never written.
  // Found by the code-health spine's first sweep.
  report.http = await probeUrls(config.urls);
  const httpFailed = report.http.filter(c => !c.ok);

  report.screenshots = await takeScreenshots(platform, config.urls);
  const screenshotsFailed = report.screenshots.filter(s => !s.ok);

  report.errors = [
    ...httpFailed.map(c => `HTTP: ${c.url} — ${c.status ? `status ${c.status}` : c.error || 'unreachable'}`),
    ...screenshotsFailed.map(s => `SCREENSHOT: ${s.url} — ${s.error || 'capture failed'}`),
  ];
  // A non-2xx outranks a failed screenshot: one URL serving 5xx alone is enough
  // to land on 'critical' rather than 'warning'.
  report.health_score = Math.max(0, 100 - httpFailed.length * 50 - screenshotsFailed.length * 30);
  report.status = report.health_score > 80 ? 'healthy' : report.health_score > 50 ? 'warning' : 'critical';

  const newConsecutive = writeAuditState(platform, report);
  await notifyAuditResult(platform, report, newConsecutive, { noAutoFix: 'url-only' });

  const reportPath = join('/opt/jarvis/reports', `${platform}-${auditId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[audit] ${platform}: complete (url-only). Score: ${report.health_score}/100`);

  fetch('http://127.0.0.1:9203/slack/report', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform, status: report.status, issues: report.errors, fixed: [], health_score: report.health_score }),
  }).catch(() => {});

  return report;
}

async function runAudit(platform) {
  if (URL_ONLY_CONFIG[platform]) return runUrlOnlyAudit(platform, URL_ONLY_CONFIG[platform]);

  const config = PLATFORM_CONFIG[platform];
  if (!config) throw new Error(`Unknown platform: ${platform}`);

  // Preflight: never score a checkout that isn't usable. See lib/checkout.js for
  // the full story — the short version is that a dead path went to spawnSync as
  // cwd, the ENOENT text matched no error pattern, and the arithmetic produced a
  // tidy 70/'warning' that the notifier stays silent about. Two platforms were
  // audited daily for weeks and the answer was invented.
  const problem = checkoutProblem(config);
  if (problem) {
    console.error(`[audit] ${platform}: NOT AUDITABLE — ${problem}`);
    const report = {
      platform,
      audit_id: Date.now(),
      timestamp: new Date().toISOString(),
      status: 'unconfigured',
      health_score: null,          // null, not a number — nothing was measured
      build: null, tests: null, checks: null, screenshots: [], errors: [],
      unauditable: problem,
    };
    // Same location the real audits write to, so this appears in the report
    // history instead of vanishing.
    try {
      writeFileSync(join('/opt/jarvis/reports', `${platform}-${report.audit_id}.json`), JSON.stringify(report, null, 2));
    } catch (e) {
      console.warn(`[audit] could not write the unconfigured report: ${e.message}`);
    }
    // Said out loud, which is the part that was missing. 'warn' not 'alert': this
    // is a misconfiguration, and the platform itself may be perfectly healthy —
    // fleet-check still probes its URL every ten minutes. notifyAuditResult is
    // bypassed deliberately: it is built around a numeric score and a
    // critical/healthy split that do not apply, and it would auto-dispatch a
    // repair agent at a codebase that isn't there.
    await notify({
      source: 'audit', level: 'warn', key: `audit-unconfigured:${platform}`,
      title: `${platform}: daily audit cannot run — ${problem}`,
      body: `The audit for ${platform} is misconfigured, so it is now reporting nothing rather than a made-up score. `
        + 'Fix the path in config/secrets.env, or move the platform to URL_ONLY_CONFIG if it has no checkout on this box. '
        + `Re-run with: curl -X POST http://127.0.0.1:9204/audit/run -H 'Content-Type: application/json' -d '{"platform":"${platform}"}'`,
      speech: `Sir, the daily audit for ${platform} cannot run — its checkout is not where the configuration says it is.`,
    });
    return report;
  }

  console.log(`[audit] Starting ${platform} audit at ${new Date().toISOString()}`);

  const auditId = Date.now();
  const report = {
    platform,
    audit_id: auditId,
    timestamp: new Date().toISOString(),
    build: null,
    tests: null,
    checks: null,
    screenshots: [],
    errors: [],
    health_score: 100
  };

  const env = config.env || {};

  // Step 1: Build
  console.log(`[audit] ${platform}: running build...`);
  report.build = runCmd(config.buildCmd, config.path, 180000, env);
  const buildErrors = extractErrors(report.build.output);
  report.errors.push(...buildErrors.map(e => `BUILD: ${e}`));

  // Step 2: Tests
  if (config.testCmd) {
    console.log(`[audit] ${platform}: running tests...`);
    report.tests = runCmd(config.testCmd, config.path, 120000, env);
    const testErrors = extractErrors(report.tests.output);
    report.errors.push(...testErrors.map(e => `TEST: ${e}`));
  }

  // Step 3: Extra checks
  if (config.checkCmd) {
    console.log(`[audit] ${platform}: running checks...`);
    report.checks = runCmd(config.checkCmd, config.path, 60000, env);
    const checkErrors = extractErrors(report.checks.output);
    report.errors.push(...checkErrors.map(e => `CHECK: ${e}`));
  }

  // Step 4: Screenshots + a real HTTP probe
  console.log(`[audit] ${platform}: probing + capturing screenshots...`);
  // The probe is here for TWO reasons, and the second is the important one:
  //   1. it is the honest answer to "is the site up" (a screenshot of a 500 page
  //      is a successful screenshot);
  //   2. writeAuditState() refuses to clear a fleet-check 'error' without it. A
  //      full audit with no probe therefore CANNOT lift an outage flag, which
  //      would leave a recovered platform stuck in 'error' until the next
  //      fleet-check tick. Probing here keeps both directions honest.
  report.http = config.urls?.length ? await probeUrls(config.urls) : null;
  const httpFailed = (report.http || []).filter(c => !c.ok);
  report.errors.push(...httpFailed.map(c => `HTTP: ${c.url} — ${c.status ? `status ${c.status}` : c.error || 'unreachable'}`));

  report.screenshots = await takeScreenshots(platform, config.urls);

  // Step 5: Score
  const errorCount = report.errors.length;
  const screenshotsFailed = report.screenshots.filter(s => !s.ok).length;
  report.health_score = Math.max(0,
    100
    - (errorCount * 8)
    - (screenshotsFailed * 5)
    - (httpFailed.length * 40)          // a URL that will not answer outranks a build error
    - (report.build.ok ? 0 : 20)
    - (report.tests && !report.tests.ok ? 10 : 0)
  );
  report.status = report.health_score > 80 ? 'healthy' : report.health_score > 50 ? 'warning' : 'critical';

  // Step 6: Write to memory + self-repair notify (shared with runUrlOnlyAudit
  // above — consecutive_critical is read BEFORE the write since INSERT OR
  // REPLACE deletes+reinserts the row, so any column left out would reset).
  const newConsecutive = writeAuditState(platform, report);
  await notifyAuditResult(platform, report, newConsecutive, { noAutoFix: config.noAutoFix });

  // Step 7: Save report to disk
  const reportPath = join('/opt/jarvis/reports', `${platform}-${auditId}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[audit] ${platform}: complete. Score: ${report.health_score}/100 | Errors: ${report.errors.length}`);

  // Step 8: Notify Slack
  fetch('http://127.0.0.1:9203/slack/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      platform,
      status: report.status,
      issues: report.errors,
      fixed: [],
      health_score: report.health_score
    })
  }).catch(() => {});

  return report;
}

// POST /audit/run
app.post('/audit/run', async (req, res) => {
  const { platform } = req.body;
  if (!platform) return res.status(400).json({ error: 'platform required' });
  if (!PLATFORM_CONFIG[platform] && !URL_ONLY_CONFIG[platform]) {
    return res.status(400).json({ error: `Unknown platform. Valid: ${[...Object.keys(PLATFORM_CONFIG), ...Object.keys(URL_ONLY_CONFIG)].join(', ')}` });
  }

  res.json({ ok: true, message: `Audit started for ${platform}`, timestamp: new Date().toISOString() });

  runAudit(platform).catch(e => {
    console.error(`[audit] ${platform} failed:`, e.message);
    db.prepare(`
      UPDATE platform_state SET status = 'error', updated_at = ? WHERE platform = ?
    `).run(new Date().toISOString(), platform);
  });
});

// GET /audit/latest/:platform
app.get('/audit/latest/:platform', (req, res) => {
  const state = db.prepare('SELECT * FROM platform_state WHERE platform = ?').get(req.params.platform);
  if (!state) return res.status(404).json({ error: 'No audit data for this platform yet' });
  state.last_known_errors = JSON.parse(state.last_known_errors || '[]');
  res.json(state);
});

// GET /audit/all
app.get('/audit/all', (req, res) => {
  const states = db.prepare('SELECT * FROM platform_state ORDER BY health_score ASC').all();
  states.forEach(s => { s.last_known_errors = JSON.parse(s.last_known_errors || '[]'); });
  res.json({ platforms: states, checked_at: new Date().toISOString() });
});

app.get('/audit/health', (req, res) => {
  res.json({ status: 'ok', platforms: [...Object.keys(PLATFORM_CONFIG), ...Object.keys(URL_ONLY_CONFIG)], uptime: process.uptime() });
});

const PORT = 9204;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-audit] Running on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-audit] Platforms: ${Object.keys(PLATFORM_CONFIG).join(', ')}`);
});

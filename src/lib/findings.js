/**
 * findings.js — the pure half of the code-health spine.
 *
 * Craig, 2026-07-30: "we could run for days finding problems and build a spine
 * health prob not just finding HTTP problems but actually coding issues
 * regardless of how deep they go."
 *
 * Everything Jarvis watched until now answers "is it SERVING?": fleet-check
 * pings a URL, audit-runner builds and tests, deploy-gate scans a deploy. All of
 * that passes cleanly on a codebase full of race conditions, swallowed errors,
 * unvalidated input and money-path bugs. This module is the vocabulary for the
 * other question — "is it CORRECT?" — and it is deliberately separate from the
 * process that spawns review agents, because the parts that decide what counts
 * as a real finding, what is a duplicate, and what gets looked at next are the
 * parts that must be tested without spending a subscription turn.
 *
 * Two failure modes shape every choice here:
 *   1. A deep-review loop that reports the same twelve things every night. That
 *      is a firehose, and a firehose gets muted. Hence fingerprints.
 *   2. A model that invents plausible bugs. An unverified finding is a rumour;
 *      acting on rumours costs Craig trust and agent time. Hence the verifier
 *      stage, and hence `dismissed` being sticky in memory-server.
 */

import { createHash } from 'crypto';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const KINDS = [
  'correctness', 'security', 'data-loss', 'reliability',
  'performance', 'maintainability', 'dependency',
];

/**
 * The rotating review lens.
 *
 * A single "find bugs in this repo" prompt gets the same shallow answers every
 * time — the model re-reads the entry points and stops. Giving each sweep ONE
 * angle is what produces depth over days instead of breadth every night, and it
 * is the same reason a multi-modal sweep beats one big search: each lens is
 * blind to what the others see.
 */
export const LENSES = [
  { key: 'failure-paths', brief: 'error handling and failure paths: swallowed exceptions, empty catch blocks, unchecked awaits, missing timeouts, retries without bounds, and anything that reports success on a failed operation' },
  { key: 'data-integrity', brief: 'data mutations, migrations and persistence: writes that can partially apply, missing transactions, destructive operations without a guard, and any path that can lose or corrupt a record' },
  { key: 'input-trust', brief: 'input validation and injection surfaces: unvalidated request bodies and query params, SQL/command/template injection, path traversal, and untrusted data reaching a privileged operation' },
  { key: 'auth-session', brief: 'authentication, authorisation and session handling: missing or bypassable access checks, tokens in logs or URLs, insecure cookies, and privilege escalation between users or tenants' },
  { key: 'concurrency', brief: 'concurrency and races: shared mutable state, read-modify-write without locking, unbounded parallelism, and assumptions that two requests cannot interleave' },
  { key: 'money-paths', brief: 'money, quotas and billing: rounding and currency handling, double-charging or double-crediting, retries that duplicate a charge, and limits that can be exceeded' },
  { key: 'integrations', brief: 'external API and service integration: missing timeouts, no backoff, unhandled non-2xx responses, secrets handling, and behaviour when a dependency is slow rather than dead' },
  { key: 'config-deploy', brief: 'configuration, build and deploy: numeric limits that parse to NaN, environment values assumed present, secrets committed or logged, and differences between the built artifact and the source' },
  { key: 'recent-changes', brief: 'the most recent work: review the last 20 commits (git log -20 --stat) for defects introduced or exposed by them, half-finished refactors, and code that no longer matches its comments' },
];

/** Next lens for a platform, by rotation index. Never throws on a bad index. */
export function lensFor(index = 0) {
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) : 0;
  return LENSES[i % LENSES.length];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'in', 'on', 'of', 'to', 'and', 'or', 'for',
  'with', 'without', 'that', 'this', 'it', 'its', 'be', 'can', 'may', 'not', 'no',
  'when', 'if', 'but', 'from', 'into', 'at', 'by', 'as', 'has', 'have', 'does',
]);

/**
 * A stable identity for "the same defect", so the tenth sweep that finds it
 * bumps a counter instead of filing a tenth report.
 *
 * Built from platform + file + the significant words of the title, SORTED.
 * Sorting is the deliberate trade: it makes the key word-order-independent, so
 * "unbounded retry loop in worker" and "worker retry loop is unbounded" collapse
 * to one finding — which is what we want, since two agents almost never phrase a
 * defect identically. The cost is that two genuinely different defects in the
 * same file that share their significant words will merge. Scoped to one file,
 * that is a rare and cheap mistake; the opposite mistake (a report per phrasing)
 * is a nightly firehose.
 */
export function fingerprint(platform, filePath, title) {
  const file = String(filePath || '(unknown)').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !STOPWORDS.has(w))
    .sort()
    .slice(0, 6)
    .join('-');
  const key = `${String(platform || '').toLowerCase()}:${file}:${words}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

const clamp = (v, n) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, n));

/**
 * Validate and clamp ONE finding out of an agent's JSON.
 *
 * Model output is untrusted input like any other. Unbounded strings from a
 * review agent land in SQLite, then in a spoken briefing, then in a dispatch
 * prompt — so every field is size-capped here, at the boundary, rather than
 * hoped about downstream. Returns null for anything unusable.
 */
export function normalizeFinding(raw, { platform, lens, jobId } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clamp(raw.title, 160);
  // A finding's title is a sentence naming a specific defect. Anything under ~20
  // characters ("too short", "bug in api", "TODO") is a label, not a finding, and
  // filing it wastes a fingerprint slot and Craig's attention.
  if (!title || title.length < 20) return null;
  const p = String(platform || raw.platform || '').toLowerCase();
  if (!p) return null;

  const severity = SEVERITIES.includes(raw.severity) ? raw.severity : 'medium';
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'correctness';
  const filePath = clamp(raw.file || raw.file_path, 300);
  const lineNum = Number(raw.line);

  return {
    fingerprint: fingerprint(p, filePath, title),
    platform: p,
    severity,
    kind,
    title,
    file_path: filePath,
    line: Number.isFinite(lineNum) && lineNum > 0 ? Math.trunc(lineNum) : null,
    evidence: clamp(raw.evidence || raw.why, 1200),
    suggested_fix: clamp(raw.suggested_fix || raw.fix, 800),
    lens: lens || null,
    job_id: jobId || null,
  };
}

/**
 * Pull findings out of whatever an agent actually printed.
 *
 * The prompt asks for a bare JSON array, and models mostly comply — but "mostly"
 * is not a contract, so this also copes with a fenced block or prose either side.
 * A parse failure returns [] with a reason rather than throwing: one malformed
 * sweep must never take the timer down.
 */
export function parseFindings(text) {
  const s = String(text || '');
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first !== -1 && last > first) candidates.push(s.slice(first, last + 1));
  candidates.push(s);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (Array.isArray(parsed)) return { findings: parsed };
      if (parsed && Array.isArray(parsed.findings)) return { findings: parsed.findings };
    } catch { /* try the next shape */ }
  }
  return { findings: [], error: 'no JSON array found in agent output' };
}

/** Worst-first, so a briefing leads with what matters. */
export const severityRank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i === -1 ? SEVERITIES.length : i;
};

/**
 * Which findings are worth spending an adversarial verifier on?
 *
 * Verification costs a subscription turn per finding, so it is spent where a
 * false positive would actually cost something: anything critical or high, and
 * anything security- or data-loss-shaped whatever its claimed severity (a model
 * under-rating a data-loss bug is exactly the case we cannot afford to skip).
 */
export function needsVerification(f) {
  if (!f) return false;
  if (f.severity === 'critical' || f.severity === 'high') return true;
  return f.kind === 'security' || f.kind === 'data-loss';
}

/**
 * Choose the next platform to sweep.
 *
 * Round-robin by LEAST-RECENTLY-SWEPT, because the alternative — always taking
 * the platform that looks worst — starves the quiet ones, and a quiet platform
 * with no findings is indistinguishable from one nobody has ever looked at.
 * A platform in cooldown is skipped entirely; a platform that has never been
 * swept sorts first.
 *
 * @param {string[]} candidates   platform names eligible to review
 * @param {object} state          { [platform]: { lastSweep: ms, lensIndex: n } }
 * @param {object} opts           { now, cooldownMs }
 */
export function pickTarget(candidates, state = {}, { now = Date.now(), cooldownMs = 0 } = {}) {
  const ready = candidates
    .map(name => ({ name, last: state[name]?.lastSweep || 0, lensIndex: state[name]?.lensIndex || 0 }))
    .filter(c => now - c.last >= cooldownMs)
    .sort((a, b) => a.last - b.last || a.name.localeCompare(b.name));
  if (!ready.length) return null;
  const t = ready[0];
  return { platform: t.name, lens: lensFor(t.lensIndex), lensIndex: t.lensIndex };
}

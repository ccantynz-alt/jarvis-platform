/**
 * harvest.js — pure logic for the intelligent flywheel (2026-08-07).
 *
 * Craig: "we should be seeing every coding session that's happening on every
 * single platform ... and improve everything that we're doing."
 *
 * Every Claude CLI session — the brain, every dispatched repair agent, every
 * code-health reviewer — already writes a full transcript to
 * ~/.claude/projects/<cwd-slug>/<uuid>.jsonl: prompt, tool calls, edits,
 * errors, corrections, outcome. Written once, never read again. The flywheel
 * is harvest → distill → inject; this file is everything about that which can
 * be tested without a filesystem or an agent.
 *
 * Hard rules:
 *   - REDACT before anything is stored. Transcripts echo env vars and tool
 *     output; the memory DB is read by every service and quoted into prompts.
 *   - The brain's CONVERSATION sessions are excluded. That channel carries
 *     Craig's voice — on 2026-08-06 it carried 23 minutes of private household
 *     talk (docs/LESSONS.md). Coding sessions only, by construction.
 *   - A lesson has a fingerprint so the same lesson learned ten times is one
 *     row seen 10×, not ten rows (the code_findings dedupe argument).
 */

import { createHash } from 'crypto';

// ── redaction ───────────────────────────────────────────────────────────────
// Conservative on purpose: a missed secret is a real leak, a false positive
// costs one unreadable token in a summary. Git SHAs are deliberately NOT
// matched (40-hex is a commit, not a credential).
const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,             // Anthropic keys
  /sk-[A-Za-z0-9_-]{20,}/g,                 // OpenAI-style keys
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,                      // AWS access key ids
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,          // Slack tokens
  /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /tskey-[A-Za-z0-9-]{10,}/g,               // Tailscale auth keys
  /-----BEGIN[A-Z ]+PRIVATE KEY-----[\s\S]*?-----END[A-Z ]+PRIVATE KEY-----/g,
  // NAME=value / NAME: value where the name says it's sensitive. Value must be
  // non-trivial (8+ chars, no spaces) so `PASSWORD=***` or prose doesn't match.
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/g,
  // token_<hex> / token=<hex> in URLs and FILENAMES. Found live on the very
  // first harvest run (2026-08-07): the screenshot service names files after
  // the URL it captured, and a `?token=` login URL bakes the gateway token
  // into the png's filename — which then arrived here via files_touched.
  // Contextual (needs the word "token") so bare git SHAs stay untouched.
  // No \b before "token": the screenshot filename that motivated this is
  // `9208__token_<hex>` and an underscore IS a word character, so a word
  // boundary never fires there — the first version of this pattern shipped
  // failing its own regression test because of exactly that.
  /token[_=][A-Fa-f0-9]{20,}/gi,
];

export function redactSecrets(text) {
  if (!text) return text;
  let out = String(text);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, name) => name ? `${name}=[REDACTED]` : '[REDACTED]');
  }
  return out;
}

// ── transcript parsing ──────────────────────────────────────────────────────
// A .claude/projects JSONL line is {timestamp, cwd?, message:{role, content}}
// with content either a string or an array of {type:'text'|'tool_use'|...}
// blocks. Parse defensively — this format is owned by the CLI, not by us.
export function parseSessionJsonl(text) {
  const s = {
    firstTs: null, lastTs: null, cwd: null,
    userTurns: 0, assistantTurns: 0, toolCalls: 0,
    toolCounts: {}, filesTouched: new Set(),
    userTexts: [], assistantTexts: [], lastAssistantText: '',
  };
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { s.firstTs = s.firstTs || o.timestamp; s.lastTs = o.timestamp; }
    if (o.cwd && !s.cwd) s.cwd = o.cwd;
    const m = o.message;
    if (!m || typeof m !== 'object') continue;
    const blocks = Array.isArray(m.content) ? m.content
      : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
    if (m.role === 'user') {
      const txt = blocks.filter(b => b?.type === 'text').map(b => b.text || '').join(' ').trim();
      // tool_result-only entries are plumbing, not a human turn
      if (txt) { s.userTurns++; s.userTexts.push(txt); }
    } else if (m.role === 'assistant') {
      let spoke = false;
      for (const b of blocks) {
        if (b?.type === 'text' && b.text?.trim()) {
          spoke = true;
          s.assistantTexts.push(b.text.trim());
          s.lastAssistantText = b.text.trim();
        } else if (b?.type === 'tool_use') {
          s.toolCalls++;
          const name = String(b.name || 'unknown');
          s.toolCounts[name] = (s.toolCounts[name] || 0) + 1;
          const fp = b.input?.file_path || b.input?.path || b.input?.notebook_path;
          if (fp && typeof fp === 'string') s.filesTouched.add(fp);
        }
      }
      if (spoke) s.assistantTurns++;
    }
  }
  s.filesTouched = [...s.filesTouched];
  return s;
}

// ── classification ──────────────────────────────────────────────────────────
// The brain's conversational sessions carry Craig's voice channel — every turn
// arrives prefixed with the statusDigest marker. One marker anywhere is enough:
// this errs toward exclusion, because the cost of wrongly excluding a coding
// session is one unharvested session, and the cost of wrongly INCLUDING a
// conversation is private speech in the flywheel.
const CONVERSATION_MARKER = '[Live status, background only';

export function isConversationSession(parsed) {
  return parsed.userTexts.some(t => t.startsWith(CONVERSATION_MARKER));
}

// Canary probes, empty shells, one-liner checks: nothing to learn, don't spend
// a distillation turn. Indexed (so the row exists) but distill_status=skipped.
export function isTrivialSession(parsed) {
  if (parsed.userTexts.some(t => t.includes('CANARY-OK'))) return true;
  return parsed.userTurns < 1 || (parsed.assistantTurns < 2 && parsed.toolCalls < 3);
}

// Map a session's cwd to a registry platform. Longest matching path wins
// (nested checkouts exist — LESSONS.md, the zoobicon-inside-operator mess).
export function platformFromCwd(cwd, registry) {
  if (!cwd) return null;
  const norm = String(cwd).replace(/\/+$/, '');
  if (norm === '/opt/jarvis' || norm.startsWith('/opt/jarvis/')) return 'jarvis';
  let best = null, bestLen = 0;
  for (const [name, e] of Object.entries(registry || {})) {
    const p = e?.path && String(e.path).replace(/\/+$/, '');
    if (!p) continue;
    if ((norm === p || norm.startsWith(p + '/')) && p.length > bestLen) {
      best = name; bestLen = p.length;
    }
  }
  return best;
}

// ── distillation ────────────────────────────────────────────────────────────
// The excerpt an agent distills from: every user turn (that's where intent and
// corrections live), the final assistant text (that's where the outcome lives),
// and the tool/file shape. Redacted BEFORE it leaves this function — the
// excerpt goes into a prompt and the prompt goes into another transcript.
export function buildExcerpt(parsed, { maxChars = 8000 } = {}) {
  const parts = [
    `cwd: ${parsed.cwd || 'unknown'}`,
    `turns: ${parsed.userTurns} user / ${parsed.assistantTurns} assistant, ${parsed.toolCalls} tool calls`,
    `tools: ${Object.entries(parsed.toolCounts).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}`,
    `files touched: ${parsed.filesTouched.slice(0, 30).join(', ') || 'none'}`,
    '--- user turns ---',
    ...parsed.userTexts.map(t => `> ${t.slice(0, 600)}`),
    '--- final assistant message ---',
    parsed.lastAssistantText.slice(0, 1500),
  ];
  return redactSecrets(parts.join('\n').slice(0, maxChars));
}

export function distillPrompt(meta, excerpt) {
  return [
    `You are distilling a completed coding session into durable lessons for future agents working on the "${meta.platform || 'unknown'}" platform.`,
    `A lesson is something the NEXT session would otherwise rediscover the hard way: a gotcha in this codebase, a command/path/config fact, a constraint the user stated, an approach that failed and why, a correction the user made.`,
    `NOT lessons: what this session happened to do (that's history, not knowledge), generic programming advice, anything already obvious from reading the code.`,
    `Reply with ONLY a JSON object: {"lessons":[{"kind":"gotcha|environment|workflow|preference|failure","lesson":"<one or two sentences, imperative, self-contained>","evidence":"<one line: what in the session showed this>","confidence":"high|medium|low"}]}`,
    `0-3 lessons. An empty array is a GOOD answer for a routine session — do not invent lessons to fill space.`,
    ``,
    `SESSION (excerpt, secrets redacted):`,
    excerpt,
  ].join('\n');
}

const LESSON_KINDS = new Set(['gotcha', 'environment', 'workflow', 'preference', 'failure']);
const CONFIDENCES = new Set(['high', 'medium', 'low']);

// Model output is untrusted input (the code-health rule): clamp every field.
export function normalizeLesson(raw, platform) {
  if (!raw || typeof raw !== 'object') return null;
  const lesson = String(raw.lesson || '').trim().slice(0, 500);
  if (lesson.length < 15) return null; // too short to carry knowledge
  return {
    platform: String(platform || 'unknown').toLowerCase().slice(0, 40),
    kind: LESSON_KINDS.has(raw.kind) ? raw.kind : 'gotcha',
    lesson: redactSecrets(lesson),
    evidence: redactSecrets(String(raw.evidence || '').trim().slice(0, 300)),
    confidence: CONFIDENCES.has(raw.confidence) ? raw.confidence : 'medium',
  };
}

// Same lesson, many sessions → one row, seen_count++. Normalized so trivial
// rephrasings of whitespace/case don't defeat the dedupe (word-identical text
// is the bar; semantic dedupe would need a model and can come later).
export function lessonFingerprint(l) {
  // Normalize each part separately — trimming the JOINED string leaves the
  // lesson's own leading whitespace alive as an internal space (caught by the
  // test on first run, not in production; that's the order these should land).
  const part = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const norm = [part(l.platform), part(l.kind), part(l.lesson)].join('|');
  return createHash('sha256').update(norm).digest('hex').slice(0, 24);
}

// ── the PC leg's dispatch discipline (2026-08-10) ───────────────────────────
// The verbs the harvester dispatches to Craig's PC, declared ONCE so the
// regression test can hold them against the verb table in pc-actions.js. The
// incident: harvest.list shipped here on 2026-08-08 but the PC worker
// re-validates against ITS OWN copy of the table (correct — the job row is not
// a trust boundary), so a worker running older code refused it, and the hourly
// timer manufactured 41 failed jobs over two days before anyone looked.
export const PC_VERBS = { list: 'harvest.list', get: 'harvest.get' };

// The worker's "I don't have that verb" sentence — pc-actions.js planAction().
// Matching the PHRASE, not an exact string: the message carries the worker's
// own verb list, which differs by exactly the verbs it is missing.
export function isStaleWorkerRefusal(error) {
  return /unknown PC action/i.test(String(error || ''));
}

// A refusal the worker will repeat on every future attempt with the same
// inputs: unknown verb, bad arguments, missing elevation, path outside the
// workspace. The worker prefixes ALL of these with "refused:" (pc-worker.js
// runAction/runJob) precisely so callers can tell "retry won't help" from a
// transient failure (timeout, lost lease, network).
export function isPermanentRefusal(error) {
  const e = String(error || '');
  return /^\s*refused:/i.test(e) || isStaleWorkerRefusal(e);
}

/**
 * Should this run dispatch a new harvest.list job? Pure, so the whole decision
 * is testable. Two holes this closes (2026-08-10, the 41-failed-jobs loop):
 *
 *   1. The in-window back-off (f671ff9) only saw a refusal that landed inside
 *      pcAction's wait window. A worker that claims the job AFTER the window
 *      (slow poll, waking PC) fails it where nobody is looking — so the next
 *      run must read the FATE of the last dispatched job before making another.
 *   2. While the PC sleeps, every hourly run left another queued job behind.
 *      A queued or running harvester PC job means this run dispatches nothing.
 *
 * Returns { action: 'skip' | 'mark-stale' | 'dispatch', reason }.
 * 'mark-stale' = the caller should set the daily stale-worker marker AND skip;
 * only a human restarting the worker clears the condition, so retrying more
 * than daily just manufactures failed jobs (docs/LESSONS.md, the alert flood).
 */
export function pcListPlan({ staleDay, today, openJobs = [], lastJob = null }) {
  if (staleDay === today) {
    return { action: 'skip', reason: 'worker known stale today (restart JarvisPcWorker on the PC to re-enable)' };
  }
  if (openJobs.length) {
    return { action: 'skip', reason: `${openJobs.length} harvester PC job(s) still queued or running — not stacking another` };
  }
  if (lastJob && lastJob.status === 'failed' && isPermanentRefusal(lastJob.error)) {
    return {
      action: 'mark-stale',
      reason: `the last dispatch was permanently refused after the wait window: ${String(lastJob.error || '').slice(0, 140)}`,
    };
  }
  return { action: 'dispatch', reason: 'no open job, no unhandled refusal' };
}

// ── file eligibility ────────────────────────────────────────────────────────
// A session file is harvestable when it has gone QUIET (no writes for quietMs —
// reading a live session would index half a conversation) and is NEW or has
// GROWN since the last harvest (a resumed session gets re-harvested and the
// upsert refreshes its row).
export function eligibleFiles(entries, state, now, { quietMs = 10 * 60 * 1000 } = {}) {
  return entries.filter(e => {
    if (now - e.mtimeMs < quietMs) return false;
    const prev = state[e.path];
    return !prev || prev.size !== e.size;
  });
}

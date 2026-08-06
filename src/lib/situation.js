/**
 * Situation synthesis — src/lib/situation.js
 *
 * 2026-08-05, Craig: "how can we make jarvis command deck seriously more
 * intelligent".
 *
 * The deck showed Jarvis's TABLES: 754 inbox rows, 200 findings, 30 jobs, all
 * rendered at equal weight. That is telemetry, not intelligence — a critical
 * unauthenticated payment endpoint looked exactly like a drafted LinkedIn post.
 * The brain behind the deck has twenty tools and can reason across all of it;
 * the OPS tab was the one surface that never asked it anything.
 *
 * This module builds the prompt for, and parses, a short ranked synthesis:
 *   - what needs Craig NOW, worst first, with the reason it matters
 *   - what changed since the last synthesis
 *   - what Jarvis handled without him
 *
 * The expensive part is a subscription turn, so the KEY design decision is
 * `situationFingerprint()`: regenerate only when the underlying facts have
 * MATERIALLY changed. A quiet fleet costs nothing at all, and a busy one pays
 * once per change rather than once per timer tick. Without this, a 30-minute
 * timer would burn ~48 turns a day restating an unchanged picture — and the
 * subscription is the same window the voice brain and every repair agent draw
 * from (CLAUDE.md: there is no metered fallback).
 *
 * Pure functions only. Tests: test/situation.test.js.
 */

/**
 * What the synthesis actually depends on. Deliberately NOT the whole payload:
 * `last_seen` timestamps, job progress and inbox ordering churn constantly
 * without changing what Craig should do about anything. Including them would
 * defeat the cache and make this a per-tick expense.
 *
 * Included, because each genuinely changes the advice:
 *   - which findings are open, and at what severity
 *   - which proposals await a decision, and which are escalated to him
 *   - which platforms are not healthy
 *   - whether any job FAILED (a completed job changes nothing he must act on)
 */
export function situationFingerprint(data = {}) {
  const findings = (data.findings || [])
    .map(f => `${f.id}:${f.severity}`)
    .sort();
  const proposals = (data.proposals || [])
    .filter(p => ['proposed', 'under_review', 'escalated'].includes(p.status))
    .map(p => `${p.id}:${p.status}`)
    .sort();
  const platforms = (data.platforms || [])
    .filter(p => p.status && p.status !== 'OPERATIONAL')
    .map(p => `${p.name}:${p.status}`)
    .sort();
  const failedJobs = (data.jobs || [])
    .filter(j => j.status === 'failed' || j.exit_code > 0)
    .map(j => j.id)
    .sort();
  return JSON.stringify({ findings, proposals, platforms, failedJobs });
}

const cap = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/**
 * The prompt. Written to force RANKING and CONSEQUENCE, because an unranked
 * list is the problem this exists to solve — the deck could already show
 * everything.
 */
export function situationPrompt(data = {}) {
  const f = data.findings || [];
  const bySeverity = {};
  for (const x of f) bySeverity[x.severity] = (bySeverity[x.severity] || 0) + 1;

  const lines = [];
  lines.push('You are Jarvis, briefing Craig on his own command deck. He is looking at a');
  lines.push('screen that already lists everything below. Do NOT list it back to him.');
  lines.push('Tell him what it MEANS and what to do about it.');
  lines.push('');
  lines.push('=== OPEN CODE FINDINGS ===');
  lines.push(Object.entries(bySeverity).map(([s, n]) => `${n} ${s}`).join(', ') || 'none');
  for (const x of f.slice(0, 40)) {
    lines.push(`- [${x.severity}] ${x.platform}: ${cap(x.title, 150)}${x.file ? ` (${x.file})` : ''}`);
  }
  lines.push('');
  lines.push('=== CHANGE PROPOSALS AWAITING A DECISION ===');
  const props = (data.proposals || []).filter(p => ['proposed', 'under_review', 'escalated'].includes(p.status));
  lines.push(props.length ? '' : 'none');
  for (const p of props.slice(0, 20)) {
    lines.push(`- #${p.id} [${p.status}] ${p.platform || 'fleet'}: ${cap(p.title, 130)}`
      + (p.status === 'escalated' ? '  ← ESCALATED TO CRAIG, an officer would not decide it' : ''));
  }
  lines.push('');
  lines.push('=== PLATFORMS NOT FULLY HEALTHY ===');
  const bad = (data.platforms || []).filter(p => p.status && p.status !== 'OPERATIONAL');
  lines.push(bad.length ? bad.map(p => `- ${p.name}: ${p.status}`).join('\n') : 'all operational');
  lines.push('');
  lines.push('=== RECENT WORK ===');
  const jobs = (data.jobs || []).slice(0, 15);
  lines.push(jobs.length ? jobs.map(j => `- ${j.platform}: ${cap(j.task, 90)} [${j.status}]`).join('\n') : 'nothing recent');
  lines.push('');
  lines.push('Write EXACTLY three sections, in this order, using these headings verbatim:');
  lines.push('');
  lines.push('NEEDS YOU');
  lines.push('  Up to 4 bullets, worst FIRST. Each: what it is, and the concrete');
  lines.push('  consequence if ignored. Rank by real-world exposure, not by severity');
  lines.push('  label — an unauthenticated endpoint on a live site taking payments');
  lines.push('  outranks a data-integrity bug in an unreleased tool. If genuinely');
  lines.push('  nothing needs him, write one bullet saying so plainly.');
  lines.push('');
  lines.push('CHANGED');
  lines.push('  Up to 3 bullets on what is different from a normal quiet state.');
  lines.push('  Omit the section body and write "nothing material" if it is routine.');
  lines.push('');
  lines.push('HANDLED');
  lines.push('  Up to 3 bullets on what was dealt with WITHOUT him. Say plainly if nothing.');
  lines.push('');
  lines.push('Rules: one sentence per bullet, no preamble, no sign-off, no markdown');
  lines.push('bold or headers beyond the three words above. Start each bullet with');
  lines.push('"- ". Address him as "you". Be specific — name platforms and numbers.');
  lines.push('Never invent anything not present in the data above.');
  lines.push('');
  lines.push('In particular, do NOT state HOW a change landed — whether it was merged,');
  lines.push('pushed to a branch, deployed, or released. None of that is in the data');
  lines.push('above and you cannot see it. Say a job completed, or that a proposal is');
  lines.push('awaiting a decision, and stop there. (Added after a synthesis asserted');
  lines.push('"all completed on branches, none merged to main" — half of those had in');
  lines.push('fact been pushed straight to main the day before.)');
  return lines.join('\n');
}

const HEADINGS = ['NEEDS YOU', 'CHANGED', 'HANDLED'];

/**
 * Parse the three sections into bullets.
 *
 * A synthesis we cannot parse is shown as raw text rather than dropped: the
 * failure mode to avoid is a blank panel that looks like "all clear" when it
 * actually means "the brain answered in an unexpected shape". Silence must
 * never read as good news — the same rule as the review gate's escalate
 * default.
 */
export function parseSituation(text) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, raw: '', sections: {}, error: 'empty synthesis' };

  const sections = {};
  let current = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    const heading = HEADINGS.find(h => t.toUpperCase() === h || t.toUpperCase() === h + ':');
    if (heading) { current = heading; sections[current] = []; continue; }
    if (!current) continue;
    const m = /^[-*•]\s+(.*)$/.exec(t);
    if (m && m[1]) sections[current].push(m[1].trim());
  }
  const found = HEADINGS.filter(h => sections[h]?.length);
  if (!found.length) return { ok: false, raw, sections: {}, error: 'no recognisable sections' };
  return { ok: true, raw, sections };
}

/** Does anything in this synthesis actually demand Craig? Drives the deck badge. */
export function needsAttention(parsed) {
  const bullets = parsed?.sections?.['NEEDS YOU'] || [];
  if (!bullets.length) return 0;
  // A single bullet that says nothing needs him is not an attention item.
  if (bullets.length === 1 && /\bnothing\b/i.test(bullets[0])) return 0;
  return bullets.length;
}

/**
 * Build-pipeline pure logic — src/lib/build-pipeline.js  (roadmap move 30)
 *
 * "Marco, build me a platform" (Craig, 2026-08-25): a brief becomes a live
 * platform via Gluecron (repo born; AI review on every PR) → Zoobicon (the
 * builder writes the app) → Vapron (deploy at <slug>.vapron.app) → Jarvis
 * (registered in platforms.json at birth so the fleet watches it).
 *
 * This module is the state machine only — no network, no fs. The runner
 * (src/platform-builder.js) injects stage executors and persists state to
 * KV so a killed run RESUMES instead of restarting (each stage records its
 * result; done stages are never re-run).
 *
 * Grounded in the 2026-08-25 recon of all three products; the guards below
 * each carry the real trap they exist for.
 */

// build precedes repo deliberately: the build needs no repo (only the push
// does), so a missing GLUECRON_PAT pauses the pipeline as LATE as possible —
// with the site already built and waiting.
export const STAGES = ['plan', 'build', 'repo', 'push', 'deploy', 'register', 'verify'];

/** Slug rules: DNS label + Vapron slug + platforms.json key, lowercase. */
export function validateSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z][a-z0-9-]{2,29}$/.test(slug)) {
    return 'slug must be 3-30 chars: lowercase letters, digits, hyphens, starting with a letter';
  }
  if (slug.includes('--') || slug.endsWith('-')) return 'slug must not contain "--" or end with "-"';
  return null;
}

export function newBuildState({ slug, brief, owner }) {
  const slugError = validateSlug(slug);
  if (slugError) throw new Error(slugError);
  if (!brief || typeof brief !== 'string' || brief.trim().length < 10) {
    throw new Error('brief must be a real description (10+ chars)');
  }
  return {
    v: 1,
    slug,
    brief: brief.trim(),
    owner: owner || 'ccantynz',
    status: 'running',            // running | paused | failed | done
    pausedReason: null,
    startedAt: null,              // runner stamps times; pure logic never reads clocks
    stages: Object.fromEntries(STAGES.map(s => [s, { status: 'pending', result: null, error: null }])),
  };
}

/** The next stage to execute, or null when nothing is runnable. */
export function nextStage(state) {
  if (state.status !== 'running') return null;
  for (const s of STAGES) {
    const st = state.stages[s];
    if (st.status === 'done') continue;
    if (st.status === 'pending' || st.status === 'retry') return s;
    return null;                  // a stage in any other status blocks the line
  }
  return null;
}

/**
 * Fold a stage executor's outcome into the state. Executors return
 *   { ok: true, result }                  — stage done
 *   { ok: false, pause: '<why>' }         — pipeline pauses, resumable
 *   { ok: false, error: '<why>' }         — stage failed, pipeline failed
 * Anything else is treated as a failure — a stage that can't say what
 * happened must not be treated as having succeeded.
 */
export function applyStageResult(state, stage, outcome) {
  if (!STAGES.includes(stage)) throw new Error(`unknown stage ${stage}`);
  const next = structuredClone(state);
  const st = next.stages[stage];

  if (outcome && outcome.ok === true) {
    const guardError = stageGuard(stage, outcome.result, next);
    if (guardError) {
      st.status = 'failed';
      st.error = guardError;
      next.status = 'failed';
      return next;
    }
    st.status = 'done';
    st.result = outcome.result ?? true;
    st.error = null;
    if (STAGES.every(s => next.stages[s].status === 'done')) next.status = 'done';
    return next;
  }

  if (outcome && outcome.pause) {
    st.status = 'retry';          // re-runnable once the blocker clears
    st.error = outcome.pause;
    next.status = 'paused';
    next.pausedReason = `${stage}: ${outcome.pause}`;
    return next;
  }

  st.status = 'failed';
  st.error = (outcome && outcome.error) || 'stage returned no outcome';
  next.status = 'failed';
  return next;
}

/** Resume a paused pipeline (the blocker was cleared — e.g. a PAT arrived). */
export function resume(state) {
  if (state.status !== 'paused') return state;
  const next = structuredClone(state);
  next.status = 'running';
  next.pausedReason = null;
  return next;
}

/**
 * Per-stage success guards — the recon traps. A stage may claim success and
 * still be lying; these turn known lies into hard failures.
 */
function stageGuard(stage, result, state) {
  if (stage === 'build') {
    // Zoobicon's deploy client returns { mocked: true } with a PLAUSIBLE but
    // nonexistent URL when its key is unset; and an "html" build with no
    // files is not deployable. Both must never advance the pipeline.
    if (result?.mocked === true) return 'build result is MOCKED — a fake success, not a site';
    if (!result?.files || Object.keys(result.files).length === 0) {
      return 'build produced no files — nothing to push or deploy';
    }
  }
  if (stage === 'deploy') {
    // Vapron derives the slug from the project name and appends a random
    // suffix on collision — the deploy can succeed AT THE WRONG URL. The
    // recon calls this out explicitly: verify the slug round-tripped.
    if (result?.slug !== state.slug) {
      return `Vapron returned slug "${result?.slug}" — the URL would not be ${state.slug}.vapron.app`;
    }
    if (result?.status !== 'live') return `deployment ended "${result?.status}", not live`;
  }
  if (stage === 'verify') {
    // Rule 2: nothing is done without proof a human could check.
    if (!result?.httpStatus || result.httpStatus >= 400) {
      return `verify probe got HTTP ${result?.httpStatus ?? 'nothing'} — not serving`;
    }
  }
  return null;
}

/** One-line human status for notify()/logs. */
export function describe(state) {
  const done = STAGES.filter(s => state.stages[s].status === 'done').length;
  const head = `build ${state.slug}: ${state.status} (${done}/${STAGES.length} stages)`;
  if (state.status === 'paused') return `${head} — ${state.pausedReason}`;
  if (state.status === 'failed') {
    const bad = STAGES.find(s => state.stages[s].status === 'failed');
    return `${head} — ${bad}: ${state.stages[bad]?.error}`;
  }
  if (state.status === 'done') return `${head} — https://${state.slug}.vapron.app`;
  return head;
}

/**
 * Platform builder — src/platform-builder.js  (roadmap move 30, phase 1)
 *
 * Runs ONE build pipeline on the box:
 *   node src/platform-builder.js --slug <slug> --brief "<what to build>" [--mock] [--resume]
 *
 * Stages (src/lib/build-pipeline.js): plan → build → repo → push → deploy →
 * register → verify. State is durable in KV `build-pipeline:<slug>` — a
 * killed or paused run RESUMES with --resume; done stages never re-run.
 *
 * Invocation path: Craig asks Marco → dispatch_job stages it behind the
 * confirmation gate (the ONE gate) → the dispatched agent runs this script
 * and reports. The script itself is deterministic — the agent babysits, it
 * does not improvise.
 *
 * Costs: the build stage calls Zoobicon's public v2 builder, which burns
 * Zoobicon's OWN metered Anthropic key (its product economics, not the
 * brain's subscription). --mock replays Zoobicon's fixture: $0, ~4s —
 * use it for pipeline shakedowns.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { notify } from './lib/notify.js';
import {
  STAGES, newBuildState, nextStage, applyStageResult, resume, describe as describeState,
} from './lib/build-pipeline.js';
import { installInternalAuth } from './lib/internal-http.js';
installInternalAuth();

const MEMORY = 'http://127.0.0.1:9200';
const SCREENSHOT = 'http://127.0.0.1:9201';
const GLUECRON = process.env.GLUECRON_URL || 'https://gluecron.com';
// www, not apex: the apex 307s to www and a redirected POST is one more
// thing to go wrong (found on the first real run, 2026-08-25).
const ZOOBICON = process.env.ZOOBICON_URL || 'https://www.zoobicon.com';
const VAPRON_API = process.env.VAPRON_API_URL || 'https://api.vapron.ai';
const REGISTRY = process.env.JARVIS_REGISTRY || '/opt/jarvis/config/platforms.json';

const args = parseArgs(process.argv.slice(2));
const log = (m) => process.stdout.write(`[${new Date().toISOString()}] ${m}\n`);

function parseArgs(argv) {
  const out = { mock: false, resume: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--slug') out.slug = argv[++i];
    else if (argv[i] === '--brief') out.brief = argv[++i];
    else if (argv[i] === '--mock') out.mock = true;
    else if (argv[i] === '--resume') out.resume = true;
  }
  return out;
}

const kvKey = (slug) => `build-pipeline:${slug}`;
const kvGet = (key) => fetch(`${MEMORY}/memory/kv/${key}`).then(r => r.ok ? r.json() : null)
  .then(r => { try { return JSON.parse(r?.value ?? 'null'); } catch { return null; } }).catch(() => null);
// LOUD on failure. The first shakedown stored a state carrying the whole
// built HTML; the memory server's JSON body cap rejected it and a silent
// .catch ate the 413 — so resume restarted from scratch and re-ran a paid
// stage. Persistence failure aborts the run; build artifacts live on DISK
// (buildDir) and the KV state stays small by construction.
async function kvSet(key, value) {
  const r = await fetch(`${MEMORY}/memory/kv`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value: JSON.stringify(value) }),
  });
  if (!r.ok) throw new Error(`state save failed: KV POST ${key} → HTTP ${r.status}`);
}
const buildDir = (slug) => `/opt/jarvis/memory/builds/${slug}`;

const jfetch = async (url, opts = {}, ms = 30_000) => {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
};

// tRPC over HTTP: queries are GET with ?input=<json>, mutations are POST
// with the input as the RAW body — Vapron's server has no transformer, so
// the {"json": input} wrapper (which its own unbuilt CLI uses) is rejected
// with "expected string, received undefined" (2026-08-25 shakedown).
// No Origin header on purpose — Vapron's CSRF middleware passes server-to-server calls.
const vapron = {
  key: process.env.VAPRON_API_KEY || '',
  query: (proc, input) => jfetch(
    `${VAPRON_API}/trpc/${proc}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ''}`,
    { headers: { Authorization: `Bearer ${vapron.key}` } }),
  mutate: (proc, input) => jfetch(`${VAPRON_API}/trpc/${proc}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${vapron.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }, 60_000),
};

// ── stage executors ─────────────────────────────────────────────────────────

const executors = {
  async plan(state) {
    const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    if (registry.platforms?.[state.slug]) return { ok: false, error: `"${state.slug}" already exists in platforms.json` };
    if (!vapron.key) return { ok: false, pause: 'VAPRON_API_KEY not set in secrets.env' };
    const list = await vapron.query('projects.list');
    if (list.status !== 200) return { ok: false, error: `Vapron projects.list HTTP ${list.status}` };
    const taken = (list.body?.result?.data || []).some(p => p.slug === state.slug);
    if (taken) return { ok: false, error: `Vapron already has a project with slug "${state.slug}"` };
    return { ok: true, result: { checkedAt: new Date().toISOString() } };
  },

  async build(state) {
    // Zoobicon v2 spawn (SSE) → one self-contained HTML document. Wrapped
    // with a tiny Bun server so Vapron's deploy path has a start command.
    const payload = { prompt: state.brief, ...(args.mock ? { mock: true } : {}) };
    log(`build: asking Zoobicon (${args.mock ? 'MOCK fixture' : 'real build'})…`);
    const r = await fetch(`${ZOOBICON}/api/v2/build/spawn/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(300_000),
    });
    if (!r.ok) return { ok: false, error: `Zoobicon builder HTTP ${r.status}` };
    let html = null, sectionCount = 0, streamedError = null;
    // SSE frames: lines of "data: {json}"; {"type":"done"} carries html,
    // {"type":"error"} carries the reason. Ignoring the error event cost a
    // diagnosis on 2026-08-25 (Zoobicon's Anthropic credits ran out and this
    // parser reported only "0 bytes") — terminal events are never dropped.
    const text = await r.text();
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim());
        if (ev.type === 'done') { html = ev.html; sectionCount = ev.sectionCount ?? 0; }
        if (ev.type === 'error') streamedError = ev.reason || ev.message || JSON.stringify(ev).slice(0, 300);
      } catch { /* keep-alives and partial frames are fine */ }
    }
    if (streamedError && !html) return { ok: false, error: `Zoobicon builder: ${String(streamedError).slice(0, 300)}` };
    if (!html || html.length < 500) {
      return { ok: false, error: `builder stream ended with no usable html (${html ? html.length : 0} bytes; stream head: ${text.slice(0, 160).replace(/\s+/g, ' ')})` };
    }
    const contents = {
      'index.html': html,
      'serve.ts': [
        '// Minimal static server — Vapron runs this via `bun run start` on the port it allocates.',
        'const html = await Bun.file(new URL("./index.html", import.meta.url)).text();',
        'const port = Number(process.env.PORT ?? 3000);',
        'Bun.serve({ port, fetch(req) {',
        '  const p = new URL(req.url).pathname;',
        '  if (p === "/health") return new Response("ok");',
        '  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });',
        '} });',
        'console.log(`serving on :${port}`);',
      ].join('\n'),
      'package.json': JSON.stringify({
        name: state.slug, private: true,
        scripts: { start: 'bun serve.ts' },
      }, null, 2),
      'README.md': `# ${state.slug}\n\nBuilt by the estate pipeline (Jarvis move 30) on ${new Date().toISOString().slice(0, 10)}.\n\nBrief: ${state.brief}\n\nGenerated by Zoobicon, hosted by Vapron at https://${state.slug}.vapron.app, repo on Gluecron.\n`,
    };
    // Artifacts to disk; the KV state carries only the manifest.
    const dir = buildDir(state.slug);
    mkdirSync(dir, { recursive: true });
    const files = {};
    for (const [name, content] of Object.entries(contents)) {
      writeFileSync(join(dir, name), content);
      files[name] = content.length;
    }
    return { ok: true, result: { files, filesDir: dir, sectionCount, mock: args.mock, bytes: html.length, mocked: false } };
  },

  async repo(state) {
    const pat = process.env.GLUECRON_PAT || '';
    if (!pat) return { ok: false, pause: 'GLUECRON_PAT not set — mint at gluecron.com → Settings → Tokens (repo scope), add to secrets.env' };
    const auth = { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' };
    const existing = await jfetch(`${GLUECRON}/api/v2/repos/${state.owner}/${state.slug}`, { headers: auth });
    if (existing.status === 200) return { ok: true, result: { url: `${GLUECRON}/${state.owner}/${state.slug}.git`, reused: true } };
    const r = await jfetch(`${GLUECRON}/api/v2/repos`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ name: state.slug, description: `Estate-built platform: ${state.brief.slice(0, 140)}`, isPrivate: false }),
    });
    if (r.status === 402) return { ok: false, pause: `Gluecron plan quota: ${JSON.stringify(r.body).slice(0, 150)}` };
    if (r.status !== 201) return { ok: false, error: `Gluecron repo create HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}` };
    return { ok: true, result: { url: `${GLUECRON}/${state.owner}/${state.slug}.git` } };
  },

  async push(state) {
    const pat = process.env.GLUECRON_PAT || '';
    if (!pat) return { ok: false, pause: 'GLUECRON_PAT not set' };
    const { files, filesDir } = state.stages.build.result;
    const dir = mkdtempSync(join(tmpdir(), `build-${state.slug}-`));
    const git = (...a) => execFileSync('git', a, {
      cwd: dir, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, HOME: process.env.HOME || '/root', GIT_TERMINAL_PROMPT: '0' },
    });
    try {
      // Token stays out of argv-persisted config and remotes: smart-HTTP
      // accepts a Bearer header. `-c` must come BEFORE the subcommand —
      // `git clone -c k=v` PERSISTS the config into the new repo, and the
      // later `git -c` push then sends the Authorization header twice; the
      // server reads the doubled header as garbage, treats the push as
      // anonymous, and answers "Repository not found" (2026-08-25, cost
      // three shakedown runs to isolate).
      const authed = ['-c', `http.extraHeader=Authorization: Bearer ${pat}`];
      execFileSync('git', [...authed, 'clone', '--quiet', `${GLUECRON}/${state.owner}/${state.slug}.git`, dir], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      for (const name of Object.keys(files)) writeFileSync(join(dir, name), readFileSync(join(filesDir, name)));
      git('add', '-A');
      git('-c', 'user.name=Marco (Jarvis build pipeline)', '-c', 'user.email=marco@alecrae.com',
        'commit', '-m', `Initial build: ${state.brief.slice(0, 120)}\n\nGenerated by the estate build pipeline (move 30).`);
      // A push 500ms after repo creation got "Repository not found" from the
      // receive-pack path while info/refs and the API both saw the repo —
      // the freshly-created row isn't visible to push auth immediately
      // (2026-08-25 shakedown). The same push succeeds seconds later, so:
      // bounded retries, not a bigger hammer.
      let pushErr;
      for (const delay of [0, 5_000, 15_000]) {
        if (delay) await new Promise(r => setTimeout(r, delay));
        try { git(...authed, 'push', '--quiet', 'origin', 'HEAD:main'); pushErr = null; break; }
        catch (e) { pushErr = e; if (!String(e.message).includes('not found')) break; }
      }
      if (pushErr) throw pushErr;
      const sha = git('rev-parse', '--short', 'HEAD').trim();
      return { ok: true, result: { sha } };
    } catch (e) {
      return { ok: false, error: `git: ${String(e.message).replace(pat, '<PAT>').slice(0, 300)}` };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },

  async deploy(state) {
    const repoUrl = `${GLUECRON}/${state.owner}/${state.slug}.git`;
    // Find-or-create keeps re-runs idempotent.
    const list = await vapron.query('projects.list');
    let project = (list.body?.result?.data || []).find(p => p.slug === state.slug);
    if (!project) {
      const created = await vapron.mutate('projects.create', { name: state.slug, repoUrl, framework: 'other' });
      if (created.status !== 200) return { ok: false, error: `projects.create HTTP ${created.status}: ${JSON.stringify(created.body).slice(0, 250)}` };
      project = created.body?.result?.data;
    }
    if (!project?.id) return { ok: false, error: 'projects.create returned no project' };
    if (project.slug !== state.slug) {
      // Surface the -suffix trap immediately; the lib guard would also catch it.
      return { ok: true, result: { slug: project.slug, status: 'wrong-slug' } };
    }
    const dep = await vapron.mutate('deployments.create', { projectId: project.id, branch: 'main', triggeredBy: 'api' });
    if (dep.status !== 200) return { ok: false, error: `deployments.create HTTP ${dep.status}: ${JSON.stringify(dep.body).slice(0, 250)}` };
    const depId = dep.body?.result?.data?.id || dep.body?.result?.data?.deploymentId;
    if (!depId) return { ok: false, error: `no deployment id in ${JSON.stringify(dep.body).slice(0, 200)}` };
    log(`deploy: deployment ${depId} queued — polling…`);
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 15_000));
      const st = await vapron.query('deployments.getById', { deploymentId: depId });
      const status = st.body?.result?.data?.status;
      log(`deploy: ${status ?? `HTTP ${st.status}`}`);
      if (status === 'live') return { ok: true, result: { slug: state.slug, status: 'live', deploymentId: depId } };
      if (['failed', 'error', 'cancelled'].includes(status)) {
        return { ok: false, error: `deployment ${depId} ended ${status}: ${JSON.stringify(st.body?.result?.data?.error || '').slice(0, 250)}` };
      }
    }
    return { ok: false, error: `deployment ${depId} still not live after 10 min` };
  },

  async register(state) {
    const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    if (!registry.platforms[state.slug]) {
      registry.platforms[state.slug] = {
        name: state.slug,
        display_name: state.slug,
        server: '149.28.119.158',
        path: `/opt/vapron-apps/${state.slug}`,
        repo: `${GLUECRON}/${state.owner}/${state.slug}.git`,
        branch_strategy: 'direct-to-main',
        default_branch: 'main',
        tech_stack: ['Bun'],
        status: 'active',
        site_url: `https://${state.slug}.vapron.app`,
        notes: `Born from the build pipeline (move 30) ${new Date().toISOString().slice(0, 10)}. Brief: ${state.brief.slice(0, 160)}`,
      };
      writeFileSync(REGISTRY, JSON.stringify(registry, null, 2) + '\n');
    }
    return { ok: true, result: { registered: true } };
  },

  async verify(state) {
    const url = `https://${state.slug}.vapron.app`;
    const probe = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    const httpStatus = probe?.status ?? 0;
    let screenshot = null;
    try {
      const shot = await jfetch(`${SCREENSHOT}/screenshot/capture`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      }, 60_000);
      screenshot = shot.body?.path || shot.body?.filename || null;
    } catch { /* screenshot is proof-of-work sugar; the probe is the gate */ }
    return { ok: true, result: { httpStatus, url, screenshot } };
  },
};

// ── main loop ───────────────────────────────────────────────────────────────

async function main() {
  if (!args.slug || (!args.brief && !args.resume)) {
    console.error('usage: node src/platform-builder.js --slug <slug> --brief "<description>" [--mock] [--resume]');
    process.exit(2);
  }

  let state = await kvGet(kvKey(args.slug));
  if (state && !args.resume) {
    console.error(`a pipeline for "${args.slug}" already exists (${state.status}) — pass --resume to continue it`);
    process.exit(2);
  }
  if (!state) {
    state = newBuildState({ slug: args.slug, brief: args.brief, owner: process.env.GLUECRON_OWNER || 'ccantynz' });
    state.startedAt = new Date().toISOString();
  } else if (args.resume) {
    state = resume(state);
  }
  await kvSet(kvKey(args.slug), state);

  let stage;
  while ((stage = nextStage(state))) {
    log(`── stage: ${stage}`);
    let outcome;
    try { outcome = await executors[stage](state); }
    catch (e) { outcome = { ok: false, error: `${stage} threw: ${e.message}` }; }
    state = applyStageResult(state, stage, outcome);
    await kvSet(kvKey(args.slug), state);
    log(describeState(state));
  }

  const line = describeState(state);
  await notify({
    source: 'build-pipeline',
    level: state.status === 'failed' ? 'warn' : 'info',
    title: state.status === 'done'
      ? `🏗️ ${args.slug} is LIVE — https://${args.slug}.vapron.app`
      : `🏗️ ${line}`,
    body: line + (state.stages.verify?.result?.screenshot ? `\nscreenshot: ${state.stages.verify.result.screenshot}` : ''),
  });
  process.exit(state.status === 'failed' ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

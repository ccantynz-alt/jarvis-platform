/**
 * Jarvis session harvester — src/session-harvester.js
 *
 * The intelligent flywheel, phase 1 (Craig, 2026-08-07: "we should be seeing
 * every coding session that's happening on every single platform ... and
 * improve everything that we're doing").
 *
 * Every claude CLI run on this box — the brain's turns, every dispatched
 * repair agent, every code-health reviewer — writes a full transcript under
 * ~/.claude/projects/ (and ~/.claude-profiles/<name>/projects/ when the
 * two-account failover was on the other login). Written once, read never.
 * This timer closes that loop:
 *
 *   harvest  — index every quiet transcript into memory (metadata + redacted
 *              outcome; the raw file stays where it is)
 *   distill  — one budget-capped agent turn per session extracts 0-3 durable
 *              lessons (gotchas, corrections, failed approaches) → lessons
 *              table, deduped by fingerprint
 *   inject   — session-start.sh and the brain's get_lessons read them back,
 *              so every agent starts where the last one left off
 *
 * Hard rules:
 *   - The brain's CONVERSATION sessions never enter the flywheel
 *     (isConversationSession — the 2026-08-06 privacy lesson, docs/LESSONS.md).
 *   - Everything stored passes redactSecrets() first.
 *   - Read-only over the transcript dirs; writes go only to memory (:9200).
 *   - Every numeric limit via guardrail(); MODE=off is checked first.
 *   - Distillation spawns run in their own cwd (WORK_DIR) and that slug is
 *     excluded from the scan — the flywheel must not eat its own exhaust.
 */

import { readdirSync, readFileSync, statSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { gunzipSync } from 'zlib';
import { join, basename } from 'path';
import { loadPlatforms } from './lib/conversation.js';
import { notify } from './lib/notify.js';
import { guardrail } from './lib/guardrail.js';
import { spawnClaude } from './lib/spawn-agent.js';
import { extractJsonObject } from './lib/findings.js';
import {
  redactSecrets, parseSessionJsonl, isConversationSession, isTrivialSession,
  platformFromCwd, buildExcerpt, distillPrompt, eligibleFiles,
} from './lib/harvest.js';

const MEMORY = 'http://127.0.0.1:9200';
const MACHINE = process.env.HARVEST_MACHINE || 'vultr';

const MODE = process.env.HARVEST_MODE || 'index';   // off | index | live
const g = (name, fallback, allowZero = false) => guardrail(name, fallback, { source: 'harvester', allowZero });
const QUIET_MIN        = g('HARVEST_QUIET_MIN', 10);       // no writes for this long = session over
const MAX_FILES        = g('HARVEST_MAX_FILES', 40);       // indexed per run
const DISTILL_MAX      = g('HARVEST_DISTILL_MAX', 3);      // agent turns per run
const DISTILL_TIMEOUT  = g('HARVEST_DISTILL_MIN', 6);      // minutes per distillation

const ORCH = 'http://127.0.0.1:9205';
const PC_ENABLED = (process.env.HARVEST_PC || '1') !== '0';   // pull Craig's PC transcripts
const STATE_DIR = '/var/lib/jarvis/harvester';
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOG = '/var/log/jarvis-harvester.log';
const WORK_DIR = '/tmp/jarvis-harvester';

// Transcript roots: the default login plus every failover profile.
function transcriptRoots() {
  const roots = ['/root/.claude/projects'];
  const profiles = '/root/.claude-profiles';
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      const p = join(profiles, name, 'projects');
      if (existsSync(p)) roots.push(p);
    }
  }
  return roots.filter(existsSync);
}

// Other fleet boxes whose transcripts join the flywheel (phase 2, 2026-08-08 —
// Craig's amended ruling allows tailnet SSH between boxes). Pull, don't push:
// redaction and classification stay in the ONE tested path on this box, and
// nothing new runs on the remote (estate doctrine). Transcripts are Jarvis
// exhaust, not product source — mirroring them here is not the checkout
// anti-pattern. Format: machine:tailnetIp, comma-separated.
const REMOTE_SOURCES = (process.env.HARVEST_REMOTE || 'vapron-158:100.89.227.39')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { const [machine, server] = s.split(':'); return { machine, server }; })
  .filter(r => r.machine && r.server);
const REMOTE_DIR = '/var/lib/jarvis/harvester/remote';

function pullRemote({ machine, server }) {
  const dest = join(REMOTE_DIR, machine);
  mkdirSync(dest, { recursive: true });
  const r = spawnSync('rsync', [
    '-az', '--timeout=60',
    '-e', 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -i /opt/jarvis/.ssh/orchestrator',
    "--include=*/", '--include=*.jsonl', '--exclude=*',
    `root@${server}:/root/.claude/projects/`, dest + '/',
  ], { encoding: 'utf8', timeout: 120_000 });
  if (r.status !== 0) {
    log(`remote pull ${machine} FAILED (rsync ${r.status}): ${String(r.stderr || r.error || '').slice(0, 200)}`);
    return false;
  }
  return true;
}

// The harvester's own distillation spawns live under this slug — never scan it.
const SELF_SLUG = WORK_DIR.replace(/\//g, '-');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(LOG, line); } catch { /* log target missing — stdout below still lands in journald */ }
  process.stdout.write(line);
}

function loadState() {
  if (existsSync(STATE_FILE)) { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { /* corrupt state → full rescan, which is safe */ } }
  return {};
}
function saveState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
}

function scanRoot(root, machine, out) {
  for (const slug of readdirSync(root)) {
    if (slug === SELF_SLUG) continue;
    const dir = join(root, slug);
    let files;
    try { files = readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const path = join(dir, f);
      try {
        const st = statSync(path);
        out.push({ path, size: st.size, mtimeMs: st.mtimeMs, machine });
      } catch { /* file vanished mid-scan */ }
    }
  }
}

function listTranscripts() {
  const out = [];
  for (const root of transcriptRoots()) scanRoot(root, MACHINE, out);
  // Remote mirrors: same scan, their own machine label. rsync preserves mtimes
  // (-a), so the quiet-file rule judges the ORIGINAL session's stillness, not
  // the pull's timestamp.
  for (const { machine } of REMOTE_SOURCES) {
    const dir = join(REMOTE_DIR, machine);
    if (existsSync(dir)) scanRoot(dir, machine, out);
  }
  if (PC_ENABLED) {
    const dir = join(REMOTE_DIR, 'craig-pc');
    if (existsSync(dir)) scanRoot(dir, 'craig-pc', out);
  }
  return out;
}

// Pull Craig's PC transcripts through the existing PC-worker action path
// (2026-08-08). No inbound path to the PC exists, so the harvester DISPATCHES
// two read-only verbs (harvest.list, harvest.get) via the orchestrator and
// reads their results — same jobs/runtime:'action' channel used for service
// control. If the PC is asleep the list call returns pending and we skip; the
// cursor only advances on files actually pulled.
async function pcAction(verb, args, waitSeconds) {
  const r = await fetch(`${ORCH}/pc/action`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb, args, wait_seconds: waitSeconds, enqueued_by: 'harvester' }),
  });
  if (!r.ok) throw new Error(`/pc/action ${verb} → ${r.status}`);
  return r.json();
}

async function pullPC() {
  const dest = join(REMOTE_DIR, 'craig-pc');
  mkdirSync(dest, { recursive: true });
  const cursorKey = 'harvest-pc-cursor';
  let since = '1970-01-01T00:00:00Z';
  try {
    const kv = await fetch(`${MEMORY}/memory/kv/${cursorKey}`).then(r => r.ok ? r.json() : null);
    if (kv?.value) since = kv.value;
  } catch { /* first run — full history */ }

  const listed = await pcAction('harvest.list', { since }, 60).catch(e => ({ error: e.message }));
  if (listed.status !== 'completed') {
    log(`PC harvest: worker ${listed.status || 'unreachable'} — skipping this run`);
    return 0;
  }
  const lines = String(listed.output || '').trim().split('\n').filter(l => l.includes('|'));
  if (!lines.length || listed.output?.includes('NO-ROOT')) { log('PC harvest: nothing new'); return 0; }

  let pulled = 0, newest = since;
  for (const line of lines.slice(0, 40)) {
    const [path, , mtime] = line.split('|');
    const got = await pcAction('harvest.get', { path }, 60).catch(e => ({ error: e.message }));
    if (got.status !== 'completed' || !got.output) { log(`PC harvest: fetch failed for ${path}`); continue; }
    try {
      const jsonl = gunzipSync(Buffer.from(got.output.trim(), 'base64')).toString('utf8');
      // Flatten the Windows path to a single safe filename under craig-pc/.
      const safe = path.replace(/[\\/:]/g, '_').replace(/^_+/, '');
      writeFileSync(join(dest, safe), jsonl);
      pulled++;
      if (mtime > newest) newest = mtime;
    } catch (e) { log(`PC harvest: could not decode ${path}: ${e.message}`); }
  }
  if (pulled) {
    await fetch(`${MEMORY}/memory/kv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: cursorKey, value: newest }),
    }).catch(() => {});
  }
  log(`PC harvest: pulled ${pulled} transcript(s), cursor → ${newest}`);
  return pulled;
}

async function post(url, body) {
  const r = await fetch(`${MEMORY}${url}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function harvestOne(entry, registry, state) {
  const text = readFileSync(entry.path, 'utf8');
  const parsed = parseSessionJsonl(text);

  if (isConversationSession(parsed)) {
    // Privacy by construction: not indexed, not stored, only remembered as
    // seen so the file isn't re-read every run.
    state[entry.path] = { size: entry.size, excluded: true };
    return 'excluded';
  }

  const trivial = isTrivialSession(parsed);
  await post('/memory/harvest/session', {
    source_id: `${entry.machine || MACHINE}:${basename(entry.path, '.jsonl')}`,
    machine: entry.machine || MACHINE,
    platform: platformFromCwd(parsed.cwd, registry),
    cwd: parsed.cwd,
    started_at: parsed.firstTs,
    ended_at: parsed.lastTs,
    user_turns: parsed.userTurns,
    assistant_turns: parsed.assistantTurns,
    tool_calls: parsed.toolCalls,
    // Paths get redacted too: the first live run proved a file NAME can carry
    // a credential (a screenshot named after its ?token= login URL).
    files_touched: parsed.filesTouched.slice(0, 50).map(p => redactSecrets(p)),
    outcome: redactSecrets(parsed.lastAssistantText.slice(0, 500)),
    raw_path: entry.path,
    distill_status: trivial ? 'skipped' : 'pending',
  });
  state[entry.path] = { size: entry.size };
  return trivial ? 'skipped' : 'indexed';
}

async function distillOne(sess, registry) {
  if (!existsSync(sess.raw_path)) {
    await post('/memory/harvest/distilled', { session_id: sess.id, status: 'failed', lessons: [] });
    return { status: 'failed', lessons: 0, note: 'raw transcript gone' };
  }
  const parsed = parseSessionJsonl(readFileSync(sess.raw_path, 'utf8'));
  // Re-check at distill time: the classification rules may have tightened
  // since this row was indexed, and this is the last gate before an excerpt
  // reaches a prompt.
  if (isConversationSession(parsed)) {
    await post('/memory/harvest/distilled', { session_id: sess.id, status: 'skipped', lessons: [] });
    return { status: 'skipped', lessons: 0, note: 'conversation session' };
  }
  const prompt = distillPrompt({ platform: sess.platform }, buildExcerpt(parsed));
  const r = await spawnClaude({ prompt, cwd: WORK_DIR, timeoutMin: DISTILL_TIMEOUT });
  if (r.code !== 0 || r.timedOut) {
    await post('/memory/harvest/distilled', { session_id: sess.id, status: 'failed', lessons: [] });
    return { status: 'failed', lessons: 0, note: `exit ${r.code} timedOut=${r.timedOut}` };
  }
  const obj = extractJsonObject(r.stdout);
  const lessons = Array.isArray(obj?.lessons) ? obj.lessons : [];
  const filed = await post('/memory/harvest/distilled', { session_id: sess.id, status: 'done', lessons });
  return { status: 'done', lessons: filed.lessons.filter(l => l.created).length };
}

async function main() {
  if (MODE === 'off') { log('HARVEST_MODE=off — exiting'); return; }
  if (!existsSync(WORK_DIR)) mkdirSync(WORK_DIR, { recursive: true });

  const registry = loadPlatforms();
  const state = loadState();
  for (const src of REMOTE_SOURCES) {
    if (pullRemote(src)) log(`pulled ${src.machine} transcripts over tailnet`);
  }
  if (PC_ENABLED) await pullPC().catch(e => log(`PC harvest failed: ${e.message}`));
  const all = listTranscripts();
  const eligible = eligibleFiles(all, state, Date.now(), { quietMs: QUIET_MIN * 60_000 })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, MAX_FILES);

  const counts = { indexed: 0, skipped: 0, excluded: 0, failed: 0 };
  for (const entry of eligible) {
    try { counts[await harvestOne(entry, registry, state)]++; }
    catch (e) { counts.failed++; log(`harvest failed for ${entry.path}: ${e.message}`); }
  }
  saveState(state);
  log(`scan: ${all.length} transcripts, ${eligible.length} eligible → ` +
    `${counts.indexed} indexed, ${counts.skipped} trivial, ${counts.excluded} conversation-excluded, ${counts.failed} failed`);

  let distilled = 0, newLessons = 0;
  if (MODE === 'live') {
    const pending = await fetch(`${MEMORY}/memory/harvest/pending?limit=${DISTILL_MAX}`)
      .then(r => r.json()).catch(() => []);
    for (const sess of pending) {
      const r = await distillOne(sess, registry).catch(e => ({ status: 'failed', lessons: 0, note: e.message }));
      distilled++;
      newLessons += r.lessons;
      log(`distill #${sess.id} (${sess.platform || '?'}) → ${r.status}, ${r.lessons} new lesson(s)${r.note ? ` — ${r.note}` : ''}`);
    }
  }

  if (newLessons > 0) {
    await notify({
      level: 'info', source: 'harvester',
      title: `Flywheel: ${newLessons} new lesson(s) from ${distilled} session(s)`,
      body: 'Read them: curl -s "http://127.0.0.1:9200/memory/lessons?limit=20"',
    }).catch(() => {});
  }
  log(`done: mode=${MODE}, distilled=${distilled}, new lessons=${newLessons}`);
}

main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exit(1); });

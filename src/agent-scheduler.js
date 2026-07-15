// agent-scheduler.js — :9209 — the agent org's heartbeat.
//
// Every 60s: hot-load config/agents.json, dispatch any active role whose cron
// schedule matches the current UTC minute (budget-capped), and route filed
// agent reports up the escalation ladder:
//   escalate      → immediate alert notification (reaches Craig's phone)
//   action_needed → warn notification (picked up by the CEO daily digest)
//   ok            → silent durable row (brain screen material)
// A role job that finishes without filing a report gets a synthesized
// action_needed — silence is never success.
//
// AGENTS_MODE=off|dry-run|live (default dry-run) — same kill-switch semantics
// as SELF_HEAL_MODE. dry-run notifies what it WOULD dispatch, live dispatches.

import express from 'express';
import { loadAgents } from './lib/agents.js';
import { notify } from './lib/notify.js';

const PORT = parseInt(process.env.PORT, 10) || 9209;
const MEMORY = 'http://127.0.0.1:9200';
const ORCHESTRATOR = 'http://127.0.0.1:9205';
const MODE = (process.env.AGENTS_MODE || 'dry-run').toLowerCase();
const TICK_MS = 60_000;

const app = express();
app.use(express.json());

async function dbGet(path) {
  const r = await fetch(`${MEMORY}${path}`);
  if (!r.ok) throw new Error(`GET ${path} → ${r.status}`);
  return r.json();
}

// ── Minimal cron matcher: "m h dom mon dow", supports *, numbers, commas ────
function fieldMatches(field, value) {
  if (field === '*') return true;
  return field.split(',').some((part) => parseInt(part, 10) === value);
}

export function cronMatches(expr, date) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [m, h, dom, mon, dow] = parts;
  return fieldMatches(m, date.getUTCMinutes())
    && fieldMatches(h, date.getUTCHours())
    && fieldMatches(dom, date.getUTCDate())
    && fieldMatches(mon, date.getUTCMonth() + 1)
    && fieldMatches(dow, date.getUTCDay());
}

// ── Scheduling ───────────────────────────────────────────────────────────────

const firedThisMinute = new Map(); // agent → 'YYYY-MM-DDTHH:MM' last fired

async function jobsTodayByAgent() {
  const counts = await dbGet('/memory/jobs/counts?window=today');
  return Object.fromEntries(counts.by_agent.map((r) => [r.agent, r.count]));
}

async function dispatchAgent(role, reason) {
  if (MODE === 'dry-run') {
    console.log(`[agents] DRY-RUN: would dispatch ${role.name} (${reason})`);
    notify({
      source: 'agent-scheduler',
      title: `🧪 dry-run: would dispatch ${role.display_name}`,
      body: reason,
    }).catch(() => {});
    return { dryRun: true };
  }
  const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: role.name, enqueued_by: 'scheduler' }),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error || `dispatch → ${r.status}`);
  console.log(`[agents] dispatched ${role.name} → job ${data.jobId}`);
  return data;
}

async function scheduleTick(now) {
  if (MODE === 'off') return;
  const agents = loadAgents();
  const minuteKey = now.toISOString().slice(0, 16);
  let budgets = null;

  for (const role of Object.values(agents)) {
    if (role.kind !== 'role' || role.status !== 'active' || !role.schedule) continue;
    if (!cronMatches(role.schedule, now)) continue;
    if (firedThisMinute.get(role.name) === minuteKey) continue;
    firedThisMinute.set(role.name, minuteKey);

    try {
      budgets = budgets || await jobsTodayByAgent();
      const used = budgets[role.name] || 0;
      const cap = role.budget?.max_jobs_per_day ?? 2;
      if (used >= cap) {
        console.log(`[agents] ${role.name} over budget (${used}/${cap}) — skipped`);
        notify({
          source: 'agent-scheduler',
          level: 'warn',
          title: `⏸ ${role.display_name} skipped — daily budget reached (${used}/${cap})`,
        }).catch(() => {});
        continue;
      }
      await dispatchAgent(role, `cron ${role.schedule}`);
    } catch (e) {
      console.error(`[agents] dispatch ${role.name} failed:`, e.message);
      notify({
        source: 'agent-scheduler',
        level: 'error',
        title: `❌ Failed to dispatch ${role.display_name}`,
        body: e.message,
      }).catch(() => {});
    }
  }
}

// ── Report routing (escalation ladder) ──────────────────────────────────────

async function routeReports() {
  let reports;
  try {
    reports = await dbGet('/memory/agent-reports?unrouted=1&limit=50');
  } catch (e) {
    console.error('[agents] report fetch failed:', e.message);
    return;
  }

  for (const rep of reports.reverse()) {  // oldest first
    try {
      const agents = loadAgents();
      const role = agents[rep.agent];
      const display = role?.display_name || rep.agent;

      if (rep.status === 'escalate') {
        await notify({
          source: 'agent-org',
          level: 'alert',
          title: `🚨 ${display}: ${rep.summary.slice(0, 120)}`,
          body: (rep.details || rep.summary).slice(0, 1500),
          speech: `Escalation from ${display}. ${rep.summary.slice(0, 200)}`,
        });
      } else if (rep.status === 'action_needed') {
        await notify({
          source: 'agent-org',
          level: 'warn',
          title: `📋 ${display} needs review: ${rep.summary.slice(0, 120)}`,
          body: (rep.details || rep.summary).slice(0, 1500),
        });
      } else {
        // ok → durable inbox entry, info level, no speech: visible, not noisy.
        await notify({
          source: 'agent-org',
          title: `✅ ${display}: ${rep.summary.slice(0, 120)}`,
          body: (rep.details || '').slice(0, 1500),
        });
      }
      await fetch(`${MEMORY}/memory/agent-reports/${rep.id}/routed`, { method: 'POST' });
    } catch (e) {
      console.error(`[agents] routing report ${rep.id} failed:`, e.message);
    }
  }
}

// Synthesize action_needed for role jobs that finished without a report —
// a silent agent is a broken agent, not a successful one.
async function synthMissingReports() {
  try {
    const since = new Date(Date.now() - 15 * 60_000).toISOString();
    const recent = await dbGet(`/memory/jobs?limit=100`);
    const finished = recent.filter((j) =>
      j.agent
      && ['completed', 'failed'].includes(j.status)
      && j.finished_at && j.finished_at >= since);

    for (const job of finished) {
      const reports = await dbGet(`/memory/agent-reports?agent=${encodeURIComponent(job.agent)}&limit=20`);
      if (reports.some((r) => r.job_id === job.id)) continue;
      // Give a just-finished job 2 minutes of grace for the report insert.
      if (Date.now() - new Date(job.finished_at).getTime() < 2 * 60_000) continue;

      await fetch(`${MEMORY}/memory/agent-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: job.agent,
          job_id: job.id,
          status: 'action_needed',
          summary: `job ${job.status} WITHOUT filing a report (exit ${job.exit_code})`,
          details: (job.error || job.output || 'no output').slice(0, 1500),
        }),
      });
      console.log(`[agents] synthesized missing report for ${job.agent} job ${job.id}`);
    }
  } catch (e) {
    console.error('[agents] synth check failed:', e.message);
  }
}

// ── HTTP surface ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', port: PORT, mode: MODE });
});

app.get('/agents', (_req, res) => {
  try {
    res.json(loadAgents());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// /org — resolved tree with live per-agent state; powers the brain screen.
app.get('/org', async (_req, res) => {
  try {
    const agents = loadAgents();
    const [recentJobs, recentReports, budgets] = await Promise.all([
      dbGet('/memory/jobs?limit=200'),
      dbGet('/memory/agent-reports?limit=200'),
      jobsTodayByAgent(),
    ]);

    const nodes = {};
    for (const role of Object.values(agents)) {
      const lastJob = recentJobs.find((j) => j.agent === role.name) || null;
      const lastReport = recentReports.find((r) => r.agent === role.name) || null;
      nodes[role.name] = {
        name: role.name,
        display_name: role.display_name,
        kind: role.kind,
        reports_to: role.reports_to,
        status: role.status,
        platform: role.platform || null,
        jurisdiction: role.jurisdiction || null,
        schedule: role.schedule || null,
        jobs_today: budgets[role.name] || 0,
        budget_cap: role.budget?.max_jobs_per_day ?? null,
        last_job: lastJob && { id: lastJob.id, status: lastJob.status, finished_at: lastJob.finished_at },
        last_report: lastReport && { status: lastReport.status, summary: lastReport.summary, ts: lastReport.ts },
      };
    }
    res.json({ mode: MODE, generated_at: new Date().toISOString(), agents: nodes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-agents] listening on http://127.0.0.1:${PORT} (mode=${MODE})`);
  setInterval(() => {
    const now = new Date();
    scheduleTick(now).catch((e) => console.error('[agents] tick error:', e.message));
    routeReports().catch(() => {});
    synthMissingReports().catch(() => {});
  }, TICK_MS);
});

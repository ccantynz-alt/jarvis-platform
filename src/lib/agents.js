// agents.js — agent-role registry loader + prompt builder.
//
// Roles are rows, not processes: config/agents.json is hot-read on every call
// (the platforms.json pattern), so registry edits take effect immediately —
// no restart, and status:'inactive'/'held' is an instant per-agent kill switch.

import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = '/opt/jarvis';
const REGISTRY_PATH = join(ROOT, 'config/agents.json');
const PLATFORMS_PATH = join(ROOT, 'config/platforms.json');
const REPORT_PROTOCOL = join(ROOT, 'config/personas/_reporting-protocol.md');

export function loadAgents() {
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const defaults = raw.defaults || {};
  const out = {};
  for (const [name, entry] of Object.entries(raw.agents || {})) {
    out[name] = {
      ...defaults,
      ...entry,
      budget: { ...(defaults.budget || {}), ...(entry.budget || {}) },
      permissions: { ...(defaults.permissions || {}), ...(entry.permissions || {}) },
      name,
    };
  }
  return out;
}

export function getAgent(name) {
  return loadAgents()[name] || null;
}

function platformInfo(platform) {
  try {
    const p = JSON.parse(readFileSync(PLATFORMS_PATH, 'utf8')).platforms[platform];
    if (!p) return null;
    const url = p.site_url || (p.public_host ? `https://${p.public_host}` : null);
    return { url, display: p.display_name || platform };
  } catch {
    return null;
  }
}

// Build the full worker prompt for a role job: task header (platform /
// jurisdiction / knowledge pack / cwd) + persona + task + mandatory
// reporting footer with the concrete agent name and job id baked in.
export function buildAgentPrompt(role, task, jobId) {
  const parts = [
    `You are the agent "${role.name}" (${role.display_name}) in Craig Canty's Jarvis agent org. You report to "${role.reports_to}".`,
  ];

  if (role.platform) {
    const info = platformInfo(role.platform);
    parts.push(`Your platform: ${role.platform}${info?.url ? ` — live site: ${info.url}` : ''}.`);
  }
  if (role.jurisdiction) parts.push(`Your jurisdiction: ${role.jurisdiction}.`);
  if (role.knowledge_pack) {
    parts.push(`Your knowledge pack directory: ${join(ROOT, role.knowledge_pack)} — read every .md file in it before starting.`);
  }
  parts.push(`Your working directory: ${role.permissions.cwd}. Do not write outside it.`);

  parts.push('--- YOUR PERSONA (follow it exactly) ---');
  parts.push(readFileSync(join(ROOT, role.persona), 'utf8'));

  parts.push('--- TODAY\'S TASK ---');
  parts.push(task || 'Run your scheduled job exactly as described in your persona.');

  parts.push('--- REPORTING (MANDATORY LAST STEP) ---');
  parts.push(readFileSync(REPORT_PROTOCOL, 'utf8'));
  parts.push(`For the report command: your agent name is "${role.name}" and your job_id is "${jobId}".`);

  return parts.join('\n\n');
}

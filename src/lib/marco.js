// marco.js — pure logic for the Marco fleet-knowledge flywheel (2026-08-31).
// Spec: docs/superpowers/specs/2026-08-31-marco-in-the-loop-design.md
// Everything here is testable without a DB or a server, same contract as harvest.js.
import { redactSecrets } from './harvest.js';

export const OUTCOMES = ['ok', 'fixed', 'failed', 'blocked', 'noop'];
const DETAIL_MAX = 2048;

export function normalizeEvent(raw) {
  const r = raw || {};
  for (const f of ['agent', 'platform', 'action']) {
    if (typeof r[f] !== 'string' || !r[f].trim()) return { ok: false, error: `missing ${f}` };
  }
  if (!OUTCOMES.includes(r.outcome)) return { ok: false, error: `outcome must be one of ${OUTCOMES.join('|')}` };
  const tags = Array.isArray(r.tags) ? r.tags
    : typeof r.tags === 'string' ? r.tags.split(',') : [];
  const cleanTags = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].join(',');
  return {
    ok: true,
    event: {
      agent: r.agent.trim().slice(0, 64),
      host: (typeof r.host === 'string' && r.host.trim()) ? r.host.trim().slice(0, 32) : 'vultr',
      platform: r.platform.trim().toLowerCase().slice(0, 64),
      action: redactSecrets(r.action.trim()).slice(0, 200),
      outcome: r.outcome,
      detail: redactSecrets(String(r.detail || '')).slice(0, DETAIL_MAX),
      tags: cleanTags,
      session_id: Number.isInteger(r.session_id) ? r.session_id : null,
    },
  };
}

// Flood control: one loud warning AT the cap, silence past it — a crash-looping
// agent must not turn the warning channel into the flood.
export function capVerdict(countToday, cap) {
  if (countToday < cap) return { allowed: true, warn: false };
  return { allowed: false, warn: countToday === cap };
}

// config/marco.env parser. Malformed values fall back CLOSED (mode off, default
// cap) — the guardrail.js lesson: never let a bad value silently fail open.
export function parseMarcoEnv(text) {
  const kv = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) kv[m[1]] = m[2].trim();
  }
  const mode = ['off', 'observe', 'full'].includes(kv.MARCO_MODE) ? kv.MARCO_MODE : 'off';
  const janitor = ['report', 'clean'].includes(kv.JANITOR_MODE) ? kv.JANITOR_MODE : 'report';
  const capRaw = kv.MARCO_EVENT_CAP;
  const cap = /^[0-9]+$/.test(capRaw || '') && parseInt(capRaw, 10) > 0 ? parseInt(capRaw, 10) : 200;
  return { mode, janitor, eventCap: cap };
}

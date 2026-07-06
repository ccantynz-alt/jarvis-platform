// executors.js — executor selection for the orchestrator dispatch engine.
//
// PURE and side-effect-free: safe to import from a test harness without
// starting any server or spawning anything.
//
// pickExecutor decides WHERE a dispatched job runs:
//   'local'  — spawn `claude --print` on this box (legacy runLocal)
//   'remote' — ssh + `claude --print` on another box (legacy runRemote)
//   'cloud'  — dispatch an Anthropic cloud CCR agent (new runCloud)
//
// HARD RULE: every 'cloud' outcome is gated behind JARVIS_CLOUD_ENABLED === '1'.
// When that flag is anything other than exactly '1', pickExecutor returns
// EXACTLY what the pre-upgrade orchestrator returned:
//   'local'  when the platform lives on this box (entry.server === OWN_IP)
//   'remote' otherwise
// i.e. behaviour is byte-identical to today with the flag off.

const OWN_IP = process.env.OWN_IP || '66.42.121.161';

// Task text that implies heavy / long-running / risky work best run off-box.
const CLOUD_TASK_RE = /\b(migrat|upgrade|deploy|refactor|rebuild|overnight)\b/i;

// A target is "reachable" for SSH dispatch when it is this box, or when its
// server field is a real IPv4 address we could ssh into. Non-IP targets
// (e.g. "vercel"), or a missing server, are treated as unreachable → cloud.
//
// NOTE: this is a deterministic, side-effect-free heuristic — it does NOT do a
// live TCP probe (dispatch must stay synchronous and non-blocking). A human
// turning on cloud mode should confirm this matches the real fleet before
// relying on the unreachable→cloud rule.
function isReachable(entry) {
  if (!entry || !entry.server) return false;
  if (entry.server === OWN_IP) return true;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(entry.server);
}

function legacyChoice(entry) {
  return entry && entry.server === OWN_IP ? 'local' : 'remote';
}

// pickExecutor(platform, entry, task, requested) → 'local' | 'cloud' | 'remote'
export function pickExecutor(platform, entry, task, requested) {
  const cloudEnabled = process.env.JARVIS_CLOUD_ENABLED === '1';

  if (!cloudEnabled) {
    // FLAG OFF → byte-identical to legacy behaviour.
    // Honour only a non-cloud explicit request; NEVER route to cloud.
    if (requested === 'local' || requested === 'remote') return requested;
    return legacyChoice(entry);
  }

  // FLAG ON → full routing.
  if (requested === 'local' || requested === 'cloud' || requested === 'remote') {
    return requested;                                  // explicit request wins
  }
  if (platform === 'jarvis') return 'cloud';           // self-repair must be off-box
  if (!isReachable(entry)) return 'cloud';             // no ssh target → cloud
  if (CLOUD_TASK_RE.test(task || '')) return 'cloud';  // heavy/long task → cloud
  return legacyChoice(entry);
}

export { isReachable };

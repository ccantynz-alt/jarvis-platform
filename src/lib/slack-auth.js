/**
 * slack-auth.js — who may command Jarvis from Slack.
 *
 * Small, pure, and in its own file for one reason: slack-bridge.js starts a Bolt
 * app and an express server at module scope, so nothing in it can be imported by
 * a test without standing up a live Slack listener. This decision is the only
 * thing in front of a code path that spawns a full-permission agent as root, so
 * it gets to be testable.
 *
 * Context (2026-07-30, found by the code-health spine on the auth-session lens):
 * the Slack entry points checked only `bot_id` and `subtype`. Any member of the
 * workspace — including by DM to the bot — could send one message and have it
 * routed. And unlike the deck and the gateway, the Slack dispatch path has NO
 * confirmation gate: handleDispatch POSTs straight to /dispatch. One message from
 * anyone in the workspace was one root agent. `mute all` was equally reachable.
 *
 * It was only unexploitable by accident: every Slack message threw
 * ReferenceError on an undeclared identifier before reaching the intent switch,
 * from 2026-07-08 until that was fixed the same morning. The fix turned a dead
 * path into a live one.
 */

/** Parse SLACK_ALLOWED_USERS. Tolerates spaces, trailing commas, and empties. */
export function parseAllowlist(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * FAILS CLOSED. With no allowlist configured nothing is authorised — Craig has
 * not sent a Slack command in three weeks, so a safe default costs nothing and
 * an unsafe one costs the fleet.
 *
 * @returns {{ok: true} | {ok: false, reason: 'no-allowlist'|'no-user-id'|'not-allowlisted'}}
 */
export function senderAllowed(userId, allowlist) {
  const allowed = Array.isArray(allowlist) ? allowlist : parseAllowlist(allowlist);
  if (!allowed.length) return { ok: false, reason: 'no-allowlist' };
  // A message with no user id is a bot post, a workflow, or an event shape we do
  // not understand. None of those are Craig.
  if (!userId || typeof userId !== 'string') return { ok: false, reason: 'no-user-id' };
  return allowed.includes(userId) ? { ok: true } : { ok: false, reason: 'not-allowlisted' };
}

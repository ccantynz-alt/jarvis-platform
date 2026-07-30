/**
 * Jarvis Notify Center — src/notify-center.js
 *
 * The single gate every UNSOLICITED Slack notification must pass through.
 * Solicited replies (Craig sent a command, Jarvis answers) bypass this and
 * post directly — muting Jarvis must never mute answers to your own questions.
 *
 * Levels:
 *   critical — posted immediately. Bypasses quiet hours and (by default) mute,
 *              but still deduped per-key so a flapping alert can't repeat
 *              within its cooldown.
 *   warning  — posted immediately unless muted / quiet hours / rate-limited,
 *              in which case it folds into the next digest. Per-key cooldown.
 *   info     — never posted immediately. Batched into a periodic digest.
 *
 * Backstop: a sliding-window rate limit on immediate posts. Once tripped,
 * everything short of critical demotes to the digest until the window clears.
 * This is what turns "hundreds of notifications" into a handful.
 *
 * State (mute, digest queue, dedupe timestamps) persists to a JSON file so a
 * service restart doesn't forget that Craig said "mute 2h".
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createHash } from 'crypto';

const LEVELS = ['critical', 'warning', 'info'];

export class NotifyCenter {
  /**
   * @param {object} opts
   * @param {(text: string) => Promise<any>} opts.send   posts one Slack message
   * @param {() => number} [opts.now]                    clock, injectable for tests
   * @param {string|null} [opts.statePath]               JSON file for persisted state
   * @param {number} [opts.digestIntervalMs]             how often the digest flushes
   * @param {number} [opts.dedupeCooldownMs]             per-key repeat suppression window
   * @param {number} [opts.maxImmediatePerHour]          rate-limit backstop
   * @param {{start: number, end: number}|null} [opts.quietHours]  local hours, e.g. {start:22,end:7}
   * @param {string} [opts.timeZone]                     for quiet-hours evaluation
   */
  constructor({
    send,
    now = () => Date.now(),
    statePath = null,
    digestIntervalMs = 30 * 60 * 1000,
    dedupeCooldownMs = 30 * 60 * 1000,
    maxImmediatePerHour = 15,
    quietHours = null,
    timeZone = 'Pacific/Auckland',
  }) {
    this.send = send;
    this.now = now;
    this.statePath = statePath;
    this.digestIntervalMs = digestIntervalMs;
    this.dedupeCooldownMs = dedupeCooldownMs;
    this.maxImmediatePerHour = maxImmediatePerHour;
    this.quietHours = quietHours;
    this.timeZone = timeZone;

    this.muteUntil = 0;        // 0 = not muted; Infinity = muted until unmute
    this.muteAll = false;      // true = even critical is held
    this.lastSentByKey = new Map();   // key -> ts of last immediate post
    this.immediateTimes = [];         // sliding window of immediate post timestamps
    this.rateLimitNoticeSent = false;
    this.digestQueue = [];            // { key, text, level, count, firstTs }
    this.lastDigestFlush = this.now();

    this.loadState();
  }

  // ── Persistence (best-effort — never crash the bridge over state I/O) ──────

  loadState() {
    if (!this.statePath) return;
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8'));
      this.muteUntil = raw.muteUntil === 'inf' ? Infinity : (raw.muteUntil || 0);
      this.muteAll = !!raw.muteAll;
      this.digestQueue = Array.isArray(raw.digestQueue) ? raw.digestQueue.slice(0, 200) : [];
    } catch { /* first run or corrupt file — start clean */ }
  }

  saveState() {
    if (!this.statePath) return;
    try {
      mkdirSync(dirname(this.statePath), { recursive: true });
      writeFileSync(this.statePath, JSON.stringify({
        muteUntil: this.muteUntil === Infinity ? 'inf' : this.muteUntil,
        muteAll: this.muteAll,
        digestQueue: this.digestQueue.slice(0, 200),
      }));
    } catch { /* best-effort */ }
  }

  // ── Mute controls ───────────────────────────────────────────────────────────

  mute(durationMs = null, { all = false } = {}) {
    this.muteUntil = durationMs ? this.now() + durationMs : Infinity;
    this.muteAll = all;
    this.saveState();
  }

  unmute() {
    this.muteUntil = 0;
    this.muteAll = false;
    this.saveState();
  }

  isMuted() {
    if (this.muteUntil === Infinity) return true;
    if (this.muteUntil > this.now()) return true;
    if (this.muteUntil !== 0) { this.muteUntil = 0; this.muteAll = false; this.saveState(); }
    return false;
  }

  // ── Quiet hours ─────────────────────────────────────────────────────────────

  inQuietHours() {
    if (!this.quietHours) return false;
    const { start, end } = this.quietHours;
    let hour;
    try {
      hour = Number(new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', hour12: false, timeZone: this.timeZone,
      }).format(new Date(this.now())));
    } catch {
      hour = new Date(this.now()).getHours();
    }
    if (hour === 24) hour = 0;
    return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
  }

  // ── Rate limit backstop ─────────────────────────────────────────────────────

  underRateLimit() {
    const cutoff = this.now() - 60 * 60 * 1000;
    this.immediateTimes = this.immediateTimes.filter(t => t > cutoff);
    return this.immediateTimes.length < this.maxImmediatePerHour;
  }

  // ── The transport contract ──────────────────────────────────────────────────

  /**
   * Send one message, treating "resolved" as delivered and "threw" as not.
   *
   * Everything in this class that protects a notification from being lost —
   * flushDigest keeping its queue, postNow folding a failure into the digest —
   * is built on that contract, and until 2026-07-30 the ONE transport that
   * matters in production didn't honour it. `sendSlack()` (slack-bridge.js) has
   * no throw path: a network error is caught and returned as
   * `{ok:false, error}`, and a Slack-level failure is worse, because Slack's Web
   * API answers **HTTP 200** with `{"ok":false,"error":"ratelimited"}` — so
   * `fetch` succeeds, `r.json()` succeeds, and a rejected message came back
   * looking exactly like a delivered one. Every guarantee here held only for the
   * throwing test doubles.
   *
   * Rather than make sendSlack throw (it has a dozen solicited-reply callers
   * that read `.ok`), the mismatch is resolved at this boundary: a resolved
   * value that explicitly reports failure is turned into one.
   */
  async deliver(text) {
    const result = await this.send(text);
    if (result && typeof result === 'object' && 'ok' in result && !result.ok) {
      throw new Error(`transport reported failure: ${result.error || 'unknown'}`);
    }
    return result;
  }

  // ── Core entry point ────────────────────────────────────────────────────────

  /**
   * @param {{text: string, level?: string, key?: string|null}} msg
   * @returns {Promise<{action: 'sent'|'queued'|'suppressed', reason?: string}>}
   */
  async notify({ text, level = 'info', key = null }) {
    if (!text) return { action: 'suppressed', reason: 'empty' };
    if (!LEVELS.includes(level)) level = 'info';
    const k = key || 'h:' + createHash('md5').update(String(text)).digest('hex').slice(0, 12);

    // Repeat of something recently posted → count it, fold into digest
    const lastSent = this.lastSentByKey.get(k) || 0;
    if (this.now() - lastSent < this.dedupeCooldownMs) {
      this.enqueue(k, text, level);
      return { action: 'queued', reason: 'dedupe-cooldown' };
    }

    if (level === 'critical') {
      if (this.isMuted() && this.muteAll) {
        this.enqueue(k, text, level);
        return { action: 'queued', reason: 'muted-all' };
      }
      return this.postNow(k, text, 'critical');
    }

    if (level === 'warning') {
      if (this.isMuted()) { this.enqueue(k, text, level); return { action: 'queued', reason: 'muted' }; }
      if (this.inQuietHours()) { this.enqueue(k, text, level); return { action: 'queued', reason: 'quiet-hours' }; }
      if (!this.underRateLimit()) {
        this.enqueue(k, text, level);
        if (!this.rateLimitNoticeSent) {
          // Flag it as sent only once it actually went, or a failed notice would
          // never be retried and Craig would see the digest fill up with no
          // explanation of why things stopped arriving immediately.
          try {
            await this.deliver(
              `🔕 Notification rate limit hit (${this.maxImmediatePerHour}/hr) — ` +
              `further non-critical messages are batching into the digest. Say \`digest\` to see them now.`,
            );
            this.rateLimitNoticeSent = true;
          } catch (e) {
            console.warn(`[notify] rate-limit notice not delivered (${e.message}) — will retry on the next one`);
          }
        }
        return { action: 'queued', reason: 'rate-limit' };
      }
      return this.postNow(k, text, 'warning');
    }

    // info
    this.enqueue(k, text, level);
    return { action: 'queued', reason: 'info-digest' };
  }

  /**
   * Post immediately. Returns {action:'sent'} only if it really went out.
   *
   * The dedupe key and the hourly slot are claimed BEFORE the await on purpose,
   * so two concurrent identical alerts can't both post — and rolled back if the
   * send turns out to have failed, which is the part that was missing
   * (2026-07-30, found by the code-health spine's integrations lens). A critical
   * alert that Slack refused used to be reported to its caller as `sent`, never
   * queued anywhere, AND leave its dedupe key stamped — so for the next 30
   * minutes the same alert folded quietly into a digest instead of being posted.
   * The louder the incident, the more thoroughly it was suppressed.
   *
   * Note the level is needed here (not just for the digest icon): a failure has
   * to be enqueued under its real level so the digest sorts it correctly.
   */
  async postNow(key, text, level = 'critical') {
    const prevSent = this.lastSentByKey.get(key);
    const stamp = this.now();
    this.lastSentByKey.set(key, stamp);
    this.immediateTimes.push(stamp);
    if (this.underRateLimit()) this.rateLimitNoticeSent = false;
    try {
      await this.deliver(text);
    } catch (e) {
      if (prevSent === undefined) this.lastSentByKey.delete(key);
      else this.lastSentByKey.set(key, prevSent);
      const i = this.immediateTimes.lastIndexOf(stamp);
      if (i !== -1) this.immediateTimes.splice(i, 1);
      this.enqueue(key, text, level); // saves state
      console.warn(`[notify] immediate ${level} post failed (${e.message}) — folded into the digest for retry`);
      return { action: 'queued', reason: 'send-failed' };
    }
    return { action: 'sent' };
  }

  enqueue(key, text, level) {
    const existing = this.digestQueue.find(q => q.key === key && q.text === text);
    if (existing) {
      existing.count += 1;
    } else {
      this.digestQueue.push({ key, text, level, count: 1, firstTs: this.now() });
      if (this.digestQueue.length > 200) this.digestQueue.shift();
    }
    this.saveState();
  }

  // ── Digest ──────────────────────────────────────────────────────────────────

  digestDue() {
    return this.digestQueue.length > 0
      && this.now() - this.lastDigestFlush >= this.digestIntervalMs
      && !this.isMuted()
      && !this.inQuietHours();
  }

  /** Flush the digest queue as one Slack message. force=true ignores mute/quiet/interval. */
  async flushDigest({ force = false } = {}) {
    if (!force && !this.digestDue()) return null;
    this.lastDigestFlush = this.now();
    if (this.digestQueue.length === 0) return null;

    // Read, don't remove (2026-07-30, found by the code-health spine). This used
    // to splice the whole queue out and persist the emptied state BEFORE
    // attempting the send — so a Slack outage, a bad token or a network blip
    // discarded up to 200 batched notifications from memory AND from disk, with
    // one console line to show for it. The caller in slack-bridge.js is a 60s
    // timer whose only handler is `.catch(e => console.error(...))`, so nothing
    // downstream noticed either. Items are now removed only after the send
    // resolves, which means a failed digest is retried on the next flush rather
    // than lost.
    const items = this.digestQueue.slice();

    const icon = { critical: '🚨', warning: '⚠️', info: '•' };
    const order = { critical: 0, warning: 1, info: 2 };
    items.sort((a, b) => order[a.level] - order[b.level] || a.firstTs - b.firstTs);

    const MAX_LINES = 25;
    const lines = items.slice(0, MAX_LINES).map(q => {
      const first = String(q.text).split('\n')[0].slice(0, 180);
      return `${icon[q.level] || '•'} ${first}${q.count > 1 ? `  _(×${q.count})_` : ''}`;
    });
    if (items.length > MAX_LINES) lines.push(`_...and ${items.length - MAX_LINES} more_`);

    const msg = `🗞 *Jarvis digest — ${items.length} update(s)*\n${lines.join('\n')}`;
    // deliver(), not send() — a Slack-level rejection arrives as a resolved
    // {ok:false}, which this line used to accept as delivery. Throws → the queue
    // below is never drained, and the retry is on the next flush INTERVAL rather
    // than the next 60s tick (lastDigestFlush was already stamped above): during
    // a Slack outage a retry every minute would be pure log noise, and nothing
    // is at risk in the meantime because the queue is on disk.
    await this.deliver(msg);

    // Delivered. Drop exactly the items that went out, by identity rather than
    // by count: anything queued WHILE the send was in flight must survive.
    const sent = new Set(items);
    this.digestQueue = this.digestQueue.filter(q => !sent.has(q));
    this.saveState();
    return msg;
  }

  // ── Status (for the `notifications` Slack command) ─────────────────────────

  status() {
    const muted = this.isMuted();
    const muteDesc = !muted ? 'off'
      : this.muteUntil === Infinity ? `on until you say \`unmute\`${this.muteAll ? ' (including critical)' : ''}`
      : `on for another ${Math.ceil((this.muteUntil - this.now()) / 60000)} min${this.muteAll ? ' (including critical)' : ''}`;
    const cutoff = this.now() - 60 * 60 * 1000;
    const recent = this.immediateTimes.filter(t => t > cutoff).length;
    return {
      muted,
      muteDesc,
      queued: this.digestQueue.length,
      immediateLastHour: recent,
      maxImmediatePerHour: this.maxImmediatePerHour,
      digestIntervalMin: Math.round(this.digestIntervalMs / 60000),
      quietHours: this.quietHours,
    };
  }
}

/** Parse "2h", "30m", "45 min", "1 hour" → ms. null when no duration given. */
export function parseDuration(text) {
  const m = String(text || '').match(/(\d+)\s*(h(ours?)?|m(in(utes?)?)?|d(ays?)?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2][0].toLowerCase();
  if (unit === 'h') return n * 60 * 60 * 1000;
  if (unit === 'd') return n * 24 * 60 * 60 * 1000;
  return n * 60 * 1000;
}

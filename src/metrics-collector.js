import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { notify } from './lib/notify.js';
import { serviceVerdict, VERDICT_POLICY } from './lib/service-verdict.js';

mkdirSync('/opt/jarvis/memory', { recursive: true });

const app = express();
app.use(express.json());
const server = createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[metrics] WS client connected. Total: ${clients.size}`);
  ws.send(JSON.stringify(collectMetrics()));
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[metrics] WS client disconnected. Total: ${clients.size}`);
  });
  ws.on('error', () => clients.delete(ws));
});

// The canonical port map (CLAUDE.md's service table). Jarvis owns 9200–9212.
// 9212 is the dashboard's public liveness ping, deliberately separate from 9206.
const JARVIS_SERVICES = {
  memory: 9200, screenshot: 9201, metrics: 9202, slack: 9203, audit: 9204,
  orchestrator: 9205, dashboard: 9206, 'deploy-gate': 9207, gateway: 9208,
  agents: 9209, deck: 9210, browser: 9211,
};

function safeExec(cmd, fallback = '0') {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return fallback;
  }
}

// Exact port match (2026-07-30). `grep :${port}` matched the port as a substring
// anywhere on the line, which is how earlier revisions reported co-tenant
// processes as Jarvis health (see the vapron note below). Compare the LISTENING
// address's trailing port instead.
// One `ss` per sweep, not one per port (2026-07-30, found by the code-health
// spine reviewing the exact-match fix above — written the same morning). safeExec
// is synchronous, so calling this once per service meant every collectMetrics()
// forked eleven shell pipelines and blocked the event loop on all of them. That
// runs on each WebSocket connect, on the collector's own interval, and on every
// GET /metrics/current — so the HUD polling made the box measure itself.
function listeningPorts() {
  const out = safeExec(`ss -tlnH 2>/dev/null | awk '{print $4}'`, '');
  const ports = new Set();
  for (const addr of out.split('\n')) {
    // Trailing port of the LISTENING address: 127.0.0.1:9200, [::1]:9200, *:80.
    const m = addr.trim().match(/[:.](\d+)$/);
    if (m) ports.add(m[1]);
  }
  return ports;
}

function checkPort(port, ports = null) {
  const set = ports || listeningPorts();
  return set.has(String(port)) ? 'ONLINE' : 'OFFLINE';
}

function collectMetrics() {
  const cpuRaw = safeExec("top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}'");
  const memRaw = safeExec("free | grep Mem | awk '{printf \"%.1f\", ($3/$2)*100}'");
  const diskRaw = safeExec("df / | tail -1 | awk '{print $5}' | tr -d '%'");
  const loadRaw = safeExec("cat /proc/loadavg | awk '{print $1}'");

  let platformHealth = [];
  try {
    platformHealth = JSON.parse(readFileSync('/opt/jarvis/memory/platform-health.json', 'utf8'));
  } catch {}

  return {
    timestamp: new Date().toISOString(),
    cpu: Math.round(parseFloat(cpuRaw) || 0),
    mem: Math.round(parseFloat(memRaw) || 0),
    disk: parseInt(diskRaw) || 0,
    load: parseFloat(loadRaw) || 0,
    uptime: Math.floor(process.uptime()),
    // All of them, not four (2026-07-30). The HUD showed memory/screenshot/audit
    // and nothing else, so eight services could die without even appearing on
    // the panel Craig watches — never mind alerting.
    jarvis: (() => {
      const ports = listeningPorts();   // one subprocess for all of them
      return Object.fromEntries(Object.entries(JARVIS_SERVICES).map(
        ([name, port]) => [name, name === 'metrics' ? 'ONLINE' : checkPort(port, ports)],
      ));
    })(),
    // NOTE: no local `vapron` port block — vapron runs on box 158, not here.
    // Local port checks matched unrelated co-tenant processes (:3000/:443) and
    // reported false health. vapron health comes from fleet-check/the heartbeat.
    platforms: platformHealth
  };
}

// Public-site probe targets come from the registry (2026-08-19, audit move 21):
// this was a hardcoded five that drifted from config/platforms.json — voxlen,
// gluecron and davenroe have public sites and were never probed here. Every
// active platform with a site_url, read fresh each sweep (the registry
// hot-reloads). Reads the file directly to avoid coupling this collector to
// conversation.js's heavier surface.
function platformTargets() {
  try {
    const reg = JSON.parse(readFileSync('/opt/jarvis/config/platforms.json', 'utf8')).platforms || {};
    return Object.entries(reg)
      .filter(([, v]) => v.site_url && v.status === 'active')
      .map(([name, v]) => ({ name: name.toUpperCase(), url: v.site_url }));
  } catch {
    return [{ name: 'ZOOBICON', url: 'https://zoobicon.com' }, { name: 'VAPRON', url: 'https://vapron.ai' }];
  }
}

async function checkPlatformHealthAsync() {
  const targets = platformTargets();

  const results = await Promise.allSettled(
    targets.map(async (t) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const start = Date.now();
        const r = await fetch(t.url, { signal: controller.signal, method: 'HEAD' });
        clearTimeout(timeout);
        return {
          name: t.name,
          url: t.url,
          status: r.ok ? 'ONLINE' : 'WARN',
          statusCode: r.status,
          latencyMs: Date.now() - start,
          checkedAt: new Date().toISOString()
        };
      } catch (e) {
        clearTimeout(timeout);
        return {
          name: t.name,
          url: t.url,
          status: 'OFFLINE',
          error: e.message,
          checkedAt: new Date().toISOString()
        };
      }
    })
  );

  const health = results.map(r => r.value || { name: 'unknown', status: 'ERROR' });
  writeFileSync('/opt/jarvis/memory/platform-health.json', JSON.stringify(health, null, 2));
  return health;
}

// Broadcast to all WS clients every 5 seconds
setInterval(() => {
  if (clients.size === 0) return;
  const metrics = collectMetrics();
  const msg = JSON.stringify(metrics);
  clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}, 5000);

// Platform health check every 60 seconds
setInterval(checkPlatformHealthAsync, 60000);
checkPlatformHealthAsync();

// ── Resource guards / pre-OOM alerting (2026-07-19, Roadmap move #2) ────────
// Runs on ITS OWN interval, independent of WS client count — the whole point
// is catching a leak at 3am when nobody has the deck open, not just painting
// a number nobody's watching. Sustained-over-N-checks filters a transient
// spike (a build job's brief CPU/mem burst is normal); memory-server's own
// 10-min notification dedup keeps a persisting condition from spamming.
const MEM_WARN = 85, MEM_CRIT = 95;
const DISK_WARN = 85, DISK_CRIT = 95;
const GUARD_INTERVAL_MS = 30_000;
const SUSTAIN_CHECKS = 3; // ~90s sustained before alerting

function makeGuard(label, warnAt, critAt) {
  let streak = 0, alertedLevel = null;
  return (value) => {
    const level = value >= critAt ? 'crit' : value >= warnAt ? 'warn' : null;
    streak = level ? streak + 1 : 0;
    if (level && streak >= SUSTAIN_CHECKS && level !== alertedLevel) {
      alertedLevel = level;
      notify({
        source: 'metrics', level: level === 'crit' ? 'alert' : 'warn',
        title: `${level === 'crit' ? '🔴' : '⚠️'} ${label} at ${value}% — ${level === 'crit' ? 'critical' : 'climbing'}`,
        body: `Sustained for ${Math.round(streak * GUARD_INTERVAL_MS / 1000)}s.`,
        speech: level === 'crit' ? `Sir, ${label.toLowerCase()} is critically high at ${value} percent.` : undefined,
      }).catch(() => {});
    } else if (!level && alertedLevel) {
      notify({ source: 'metrics', title: `✅ ${label} back to normal (${value}%)` }).catch(() => {});
      alertedLevel = null;
    }
  };
}
const memGuard = makeGuard('Memory', MEM_WARN, MEM_CRIT);
const diskGuard = makeGuard('Disk', DISK_WARN, DISK_CRIT);

// ── Jarvis watches itself (2026-07-30) ──────────────────────────────────────
//
// The fleet-watcher had no watcher. Nothing anywhere notified when one of
// Jarvis's OWN services died: no OnFailure= on any unit, nothing checking unit
// state, and the HUD only looked at four ports. Demonstrated the same evening —
// jarvis-slack crash-looped for a minute after a bad deploy of mine and the
// inbox recorded absolutely nothing. The only self-liveness that existed was
// external (the GitHub watchdog and the PC worker), and both only probe whether
// the BOX answers, which a dead jarvis-slack does not affect at all.
//
// Deliberately NOT systemd OnFailure=: with Restart=always a unit is
// "activating", not "failed", while it crash-loops, so OnFailure fires late or
// never — and it would mean editing twelve unit files that are documented as not
// fully in sync with this repo. A port probe catches every case, including a
// process that is alive but no longer listening.
const SERVICE_DOWN_CHECKS = 2;   // ~60s at GUARD_INTERVAL_MS — rides out a restart
const downStreaks = {};
const downAlerted = new Set();

// Only consulted when a port probe has already failed, so this costs nothing on
// the happy path.
function unitState(name) {
  const out = safeExec(`systemctl show jarvis-${name} -p ActiveState -p SubState 2>/dev/null`, '');
  const get = (k) => {
    const m = out.match(new RegExp(`^${k}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  return { active: get('ActiveState'), sub: get('SubState') };
}

function watchOwnServices(jarvis) {
  for (const [name, status] of Object.entries(jarvis)) {
    if (name === 'metrics') continue;   // if this loop is running, metrics is up
    const down = status !== 'ONLINE';

    // Ask systemd what it thinks before deciding how loud to be (2026-07-30). A
    // port that stops answering during a deploy is not the same event as a unit
    // systemd has given up on, and this watcher treated them identically — it
    // pushed a device alert for a 50-second restart of mine at 09:03. See
    // lib/service-verdict.js.
    const verdict = down ? serviceVerdict({ portDown: true, ...unitState(name) }) : 'ok';
    const policy = VERDICT_POLICY[verdict] || VERDICT_POLICY.notlistening;

    // A restart in progress is not a strike. Without this, a slow deploy still
    // accumulates toward the alert threshold and fires the moment it crosses.
    if (verdict === 'restarting') continue;
    downStreaks[name] = down ? (downStreaks[name] || 0) + 1 : 0;

    // Patience per verdict, not one global threshold — see VERDICT_POLICY.
    const streakMet = downStreaks[name] >= (policy.minChecks ?? SERVICE_DOWN_CHECKS);
    if (down && policy.alert && streakMet && !downAlerted.has(name)) {
      downAlerted.add(name);
      const secs = Math.round(downStreaks[name] * GUARD_INTERVAL_MS / 1000);
      const why = {
        failed: 'systemd reports the unit as FAILED, so it has already given up — no waiting to confirm.',
        stopped: 'systemd reports it INACTIVE, which with Restart=always means something stopped it deliberately.',
        notlistening: `systemd believes it is running, but the port has not answered ${downStreaks[name]} consecutive checks (~${secs}s) — a live process that has stopped serving.`,
      }[verdict];
      notify({
        source: 'metrics',
        level: policy.level,
        title: `jarvis-${name} is not listening on :${JARVIS_SERVICES[name]}`,
        body: `${why} Nothing else in the estate alerts on a dead Jarvis service — the off-box watchdog and the `
          + 'PC worker only prove the BOX answers. '
          + `Check: systemctl status jarvis-${name} && journalctl -u jarvis-${name} -n 50 --no-pager`,
        speech: verdict === 'stopped'
          ? `Sir, jarvis ${name} has been stopped.`
          : `Sir, jarvis ${name} has stopped listening.`,
      }).catch(() => {});
    } else if (!down && downAlerted.has(name)) {
      downAlerted.delete(name);
      notify({
        source: 'metrics', level: 'info',
        title: `jarvis-${name} is back`,
        body: `Listening on :${JARVIS_SERVICES[name]} again.`,
      }).catch(() => {});
    }
  }
}

setInterval(() => {
  const m = collectMetrics();
  memGuard(m.mem);
  diskGuard(m.disk);
  watchOwnServices(m.jarvis);
}, GUARD_INTERVAL_MS);

// HTTP endpoints
app.get('/metrics/current', (req, res) => res.json(collectMetrics()));
app.get('/metrics/platforms', async (req, res) => {
  const health = await checkPlatformHealthAsync();
  res.json({ platforms: health, checked_at: new Date().toISOString() });
});
app.get('/metrics/health', (req, res) => {
  res.json({ status: 'ok', ws_clients: clients.size, uptime: process.uptime() });
});

const PORT = 9202;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-metrics] HTTP + WebSocket on http://127.0.0.1:${PORT}`);
});

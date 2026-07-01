/**
 * Jarvis Dashboard Server — src/dashboard-server.js
 *
 * Serves the cyberpunk command center at http://<server>:9206
 * Aggregates real-time data from metrics (9202) and orchestrator (9205)
 * into a single WebSocket feed the browser connects to.
 *
 * Message types sent to browser:
 *   { type: 'metrics',  payload: MetricsSnapshot }
 *   { type: 'jobs',     payload: Job[] }
 *   { type: 'event',    payload: { ts, category, message } }
 *   { type: 'history',  payload: LogEntry[] }
 *   { type: 'dispatch_result', payload: { jobId?, error? } }
 *
 * Messages accepted from browser:
 *   { type: 'dispatch',     platform, task }
 *   { type: 'health_sweep' }
 *   { type: 'ping' }
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ORCHESTRATOR  = 'http://127.0.0.1:9205';
const METRICS_REST  = 'http://127.0.0.1:9202';
const METRICS_WS    = 'ws://127.0.0.1:9202';
const MEMORY        = 'http://127.0.0.1:9200';

// ── Event log (circular buffer) ──────────────────────────────────────────────

const eventLog = [];
const MAX_LOG  = 150;

function logEvent(category, message) {
  const entry = {
    ts: new Date().toISOString(),
    category,
    message: String(message).slice(0, 160),
  };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  broadcast({ type: 'event', payload: entry });
}

// ── WebSocket server ─────────────────────────────────────────────────────────

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  logEvent('NET', `Browser connected — ${clients.size} client(s) active`);

  // Send history so the log panel populates immediately
  ws.send(JSON.stringify({ type: 'history', payload: eventLog.slice(-80) }));

  // Send a fresh snapshot right away
  fetchMetrics().then(m => { if (m) ws.send(JSON.stringify({ type: 'metrics', payload: m })); });
  fetchJobs().then(j  => { if (j) ws.send(JSON.stringify({ type: 'jobs',    payload: j })); });

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      if (msg.type === 'health_sweep') {
        logEvent('SWEEP', 'Platform health sweep initiated');
        fetch(`${METRICS_REST}/metrics/platforms`)
          .then(r => r.json())
          .then(data => {
            const online  = (data.platforms || []).filter(p => p.status === 'ONLINE').length;
            const total   = (data.platforms || []).length;
            logEvent('SWEEP', `Health sweep complete — ${online}/${total} platforms ONLINE`);
          })
          .catch(e => logEvent('ERR', `Health sweep failed: ${e.message}`));
        return;
      }

      if (msg.type === 'dispatch') {
        const { platform, task } = msg;
        if (!platform || !task) {
          ws.send(JSON.stringify({ type: 'dispatch_result', payload: { error: 'platform and task required' } }));
          return;
        }
        logEvent('DISPATCH', `Queuing → ${platform}: ${task.slice(0, 80)}`);
        try {
          const r = await fetch(`${ORCHESTRATOR}/dispatch`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ platform, task }),
          });
          const result = await r.json();
          if (result.jobId) {
            logEvent('JOB', `Agent started — job ${result.jobId.slice(0, 8)} on ${platform}`);
          } else {
            logEvent('ERR', `Dispatch failed: ${result.error}`);
          }
          ws.send(JSON.stringify({ type: 'dispatch_result', payload: result }));
        } catch (e) {
          logEvent('ERR', `Orchestrator unreachable: ${e.message}`);
          ws.send(JSON.stringify({ type: 'dispatch_result', payload: { error: e.message } }));
        }
        return;
      }
    } catch {
      // ignore malformed messages
    }
  });

  ws.on('close',  () => { clients.delete(ws); });
  ws.on('error',  () => { clients.delete(ws); });
});

// ── Upstream data fetchers ───────────────────────────────────────────────────

async function fetchMetrics() {
  try {
    const r = await fetch(`${METRICS_REST}/metrics/current`);
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchJobs() {
  try {
    const r = await fetch(`${ORCHESTRATOR}/jobs`);
    return await r.json();
  } catch {
    return null;
  }
}

// Connect to metrics WebSocket — proxies its broadcasts to all browser clients
let metricsWs = null;
let metricsReconnectTimer = null;

function connectToMetrics() {
  if (metricsWs) {
    try { metricsWs.terminate(); } catch {}
  }
  metricsWs = new WebSocket(METRICS_WS);

  metricsWs.on('open', () => {
    logEvent('SYS', 'Metrics stream connected — live telemetry active');
    if (metricsReconnectTimer) {
      clearTimeout(metricsReconnectTimer);
      metricsReconnectTimer = null;
    }
  });

  metricsWs.on('message', (raw) => {
    try {
      const metrics = JSON.parse(raw.toString());
      broadcast({ type: 'metrics', payload: metrics });
    } catch {}
  });

  metricsWs.on('close', () => {
    logEvent('WARN', 'Metrics stream disconnected — reconnecting in 5s');
    metricsReconnectTimer = setTimeout(connectToMetrics, 5000);
  });

  metricsWs.on('error', () => {
    // close handler will reconnect
  });
}

// Track job status changes and emit events for new/completed jobs
let prevJobMap = new Map();

async function pollAndDiffJobs() {
  const jobs = await fetchJobs();
  if (!Array.isArray(jobs)) return;

  broadcast({ type: 'jobs', payload: jobs });

  // Detect status transitions
  for (const job of jobs) {
    const prev = prevJobMap.get(job.id);
    if (!prev && job.status === 'running') {
      logEvent('JOB', `Agent running — ${job.id.slice(0, 8)} on ${job.platform}`);
    } else if (prev?.status === 'running' && job.status === 'completed') {
      logEvent('JOB', `Agent complete — ${job.id.slice(0, 8)} on ${job.platform}`);
    } else if (prev?.status === 'running' && job.status === 'failed') {
      logEvent('ERR', `Agent failed — ${job.id.slice(0, 8)} on ${job.platform} (exit ${job.exitCode})`);
    }
    prevJobMap.set(job.id, job);
  }
  // Prune old entries
  if (prevJobMap.size > 200) {
    const ids = new Set(jobs.map(j => j.id));
    for (const id of prevJobMap.keys()) {
      if (!ids.has(id)) prevJobMap.delete(id);
    }
  }
}

// ── Express HTTP ─────────────────────────────────────────────────────────────

app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/dashboard.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status:   'ok',
    clients:  clients.size,
    events:   eventLog.length,
    metrics:  metricsWs?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected',
  });
});

// ── Boot ─────────────────────────────────────────────────────────────────────

connectToMetrics();
setInterval(pollAndDiffJobs, 3000);

logEvent('SYS', 'JARVIS Mothership initializing...');
logEvent('SYS', 'Core orchestrator online — awaiting connections');

const PORT = 9206;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[jarvis-dashboard] Serving at http://0.0.0.0:${PORT}`);
  console.log(`[jarvis-dashboard] Open your browser: http://66.42.121.161:${PORT}`);
});

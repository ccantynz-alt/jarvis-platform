import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';

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

function safeExec(cmd, fallback = '0') {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return fallback;
  }
}

function checkPort(port) {
  const result = safeExec(`ss -tlnp 2>/dev/null | grep :${port}`, '');
  return result.length > 0 ? 'ONLINE' : 'OFFLINE';
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
    jarvis: {
      memory: checkPort(9200),
      screenshot: checkPort(9201),
      metrics: 'ONLINE',
      slack: checkPort(9203),
      audit: checkPort(9204)
    },
    vapron: {
      web: checkPort(3000),
      api: checkPort(3001),
      gateway: checkPort(8090),
      deploy_agent: checkPort(9099),
      caddy: checkPort(443)
    },
    platforms: platformHealth
  };
}

async function checkPlatformHealthAsync() {
  const targets = [
    { name: 'ZOOBICON', url: 'https://zoobicon.com' },
    { name: 'VAPRON', url: 'https://vapron.ai' },
    { name: 'ALECRAE', url: 'https://alecrae.com' },
    { name: 'MARCOREID', url: 'https://marcoreid.com' },
    { name: 'GATETEST', url: 'https://gatetest.ai' },
  ];

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

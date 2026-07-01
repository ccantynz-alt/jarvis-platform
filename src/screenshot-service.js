import { spawn } from 'child_process';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync, copyFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import express from 'express';

mkdirSync('/root/jarvis-screenshots', { recursive: true });
mkdirSync('/root/jarvis-baselines', { recursive: true });

const SLACK_BRIDGE = 'http://127.0.0.1:9203';
const BASELINE_DIR = '/root/jarvis-baselines';

const app = express();
app.use(express.json());

const SCREENSHOT_DIR = '/root/jarvis-screenshots';

function detectChromium() {
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    try {
      execSync(`which ${bin}`, { stdio: 'pipe' });
      return bin;
    } catch {}
  }
  return 'chromium-browser';
}

const CHROMIUM_BIN = process.env.CHROMIUM_BIN || detectChromium();

async function captureScreenshot(url, options = {}) {
  const { width = 1280, height = 900, waitMs = 4000, mobile = false } = options;

  const timestamp = Date.now();
  const safeName = url
    .replace(/https?:\/\//, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .slice(0, 60);
  const filename = `${safeName}_${timestamp}.png`;
  const filepath = join(SCREENSHOT_DIR, filename);

  return new Promise((resolve, reject) => {
    const hardTimeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Screenshot timeout (30s) for ${url}`));
    }, 30000);

    const args = [
      '--headless=new',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--single-process',
      '--no-zygote',
      '--run-all-compositor-stages-before-draw',
      `--window-size=${mobile ? '390' : width},${mobile ? '844' : height}`,
      `--screenshot=${filepath}`,
      `--virtual-time-budget=${waitMs}`,
      url
    ];

    const proc = spawn(CHROMIUM_BIN, args, { stdio: 'pipe' });

    proc.on('close', () => {
      clearTimeout(hardTimeout);
      try {
        const data = readFileSync(filepath);
        if (data.length < 100) {
          reject(new Error(`Screenshot too small (${data.length} bytes)`));
          return;
        }
        resolve({
          ok: true,
          filepath,
          filename,
          url,
          size: data.length,
          captured_at: new Date().toISOString(),
          base64: data.toString('base64'),
          mimeType: 'image/png'
        });
      } catch (e) {
        reject(new Error(`Screenshot file missing: ${e.message}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(hardTimeout);
      reject(new Error(`Chromium spawn error: ${err.message}`));
    });
  });
}

app.post('/screenshot/capture', async (req, res) => {
  const { url, options } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const result = await captureScreenshot(url, options || {});
    res.json(result);
  } catch (err) {
    console.error(`[screenshot] Failed for ${url}:`, err.message);
    res.status(500).json({ ok: false, error: err.message, url });
  }
});

app.post('/screenshot/batch', async (req, res) => {
  const { urls, options } = req.body;
  if (!urls?.length) return res.status(400).json({ error: 'urls array required' });
  const results = [];
  for (const url of urls.slice(0, 10)) {
    try {
      const r = await captureScreenshot(url, options || {});
      results.push({ url, ok: true, filepath: r.filepath, size: r.size });
    } catch (err) {
      results.push({ url, ok: false, error: err.message });
    }
  }
  res.json({ results, captured: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
});

app.post('/screenshot/platform', async (req, res) => {
  const PLATFORM_URLS = {
    zoobicon: ['https://zoobicon.com', 'https://zoobicon.com/builder'],
    vapron: ['https://vapron.ai'],
    alecrae: ['https://alecrae.com'],
    marcoreid: ['https://marcoreid.com'],
    gatetest: ['https://gatetest.ai'],
  };
  const { platform } = req.body;
  const urls = platform ? (PLATFORM_URLS[platform] || []) : Object.values(PLATFORM_URLS).flat();
  res.json({ ok: true, message: `Capturing ${urls.length} screenshots`, urls });
  for (const url of urls) {
    try {
      await captureScreenshot(url);
      console.log(`[screenshot] Captured: ${url}`);
    } catch (e) {
      console.error(`[screenshot] Failed: ${url} — ${e.message}`);
    }
  }
});

app.get('/screenshot/list', (req, res) => {
  try {
    const files = readdirSync(SCREENSHOT_DIR)
      .filter(f => f.endsWith('.png'))
      .map(f => ({ filename: f, path: join(SCREENSHOT_DIR, f) }))
      .slice(-100);
    res.json({ screenshots: files, count: files.length });
  } catch (e) {
    res.json({ screenshots: [], count: 0, error: e.message });
  }
});

// POST /screenshot/compare — capture, diff against baseline, alert Slack on regression
app.post('/screenshot/compare', async (req, res) => {
  const { url, platform } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  let current;
  try {
    current = await captureScreenshot(url);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }

  const safeName = url.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 60);
  const baselinePath = join(BASELINE_DIR, `baseline_${safeName}.png`);

  if (!existsSync(baselinePath)) {
    copyFileSync(current.filepath, baselinePath);
    return res.json({ ok: true, regression: false, message: 'Baseline set', url });
  }

  const baselineHash = createHash('md5').update(readFileSync(baselinePath)).digest('hex');
  const currentHash  = createHash('md5').update(readFileSync(current.filepath)).digest('hex');

  if (baselineHash === currentHash) {
    return res.json({ ok: true, regression: false, url });
  }

  // Visual change detected — alert Slack with the new screenshot
  const label = platform || safeName;
  console.log(`[screenshot] Regression detected for ${label} — alerting Slack`);

  try {
    await fetch(`${SLACK_BRIDGE}/slack/image-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: label,
        message: `📸 Visual change detected on *${label}* — screenshot attached`,
        filepath: current.filepath,
        filename: current.filename,
      }),
    });
  } catch (e) {
    console.error('[screenshot] Slack alert failed:', e.message);
  }

  // Update baseline to current
  copyFileSync(current.filepath, baselinePath);
  res.json({ ok: true, regression: true, url, platform: label });
});

app.get('/screenshot/health', (req, res) => {
  res.json({ status: 'ok', chromium_bin: CHROMIUM_BIN, screenshot_dir: SCREENSHOT_DIR, uptime: process.uptime() });
});

const PORT = 9201;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[jarvis-screenshot] Running on http://127.0.0.1:${PORT}`);
  console.log(`[jarvis-screenshot] Chromium: ${CHROMIUM_BIN}`);
});

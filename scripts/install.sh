#!/bin/bash
# JARVIS PLATFORM — ONE-COMMAND INSTALL
# Usage: bash install.sh
# Run as root on Vultr Chicago (149.28.119.158)
# This script is idempotent — safe to run multiple times

set -e

JARVIS_DIR="/opt/jarvis"
REPO_URL="https://github.com/ccantynz-alt/jarvis-platform.git"

echo "================================================"
echo " JARVIS PLATFORM INSTALL"
echo " $(date)"
echo "================================================"

# --- 1. Check we're root ---
if [ "$EUID" -ne 0 ]; then
  echo "ERROR: Run as root (sudo bash install.sh)"
  exit 1
fi

# --- 2. Check Node.js ---
echo ""
echo "[1/9] Checking Node.js..."
if ! command -v node &> /dev/null; then
  echo "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_VERSION=$(node --version)
echo "Node.js: $NODE_VERSION ✓"

# --- 3. Install Chromium ---
echo ""
echo "[2/9] Installing Chromium..."
if ! command -v chromium-browser &> /dev/null && ! command -v chromium &> /dev/null; then
  apt-get update -qq
  apt-get install -y chromium-browser 2>/dev/null || apt-get install -y chromium
fi

CHROMIUM_BIN=""
for bin in chromium-browser chromium google-chrome; do
  if command -v $bin &> /dev/null; then
    CHROMIUM_BIN=$bin
    break
  fi
done

if [ -z "$CHROMIUM_BIN" ]; then
  echo "ERROR: Could not install Chromium. Install manually then re-run."
  exit 1
fi
echo "Chromium: $CHROMIUM_BIN ($($CHROMIUM_BIN --version 2>/dev/null || echo 'version unknown')) ✓"

# --- 4. Clone or update repo ---
echo ""
echo "[3/9] Setting up Jarvis repo..."
if [ -d "$JARVIS_DIR/.git" ]; then
  echo "Repo exists — pulling latest..."
  cd $JARVIS_DIR && git pull origin main
else
  echo "Cloning..."
  git clone $REPO_URL $JARVIS_DIR
fi

# --- 5. Create directories ---
echo ""
echo "[4/9] Creating directories..."
mkdir -p $JARVIS_DIR/{memory,screenshots,reports,logs,config}
echo "Directories created ✓"

# --- 6. Install npm dependencies ---
echo ""
echo "[5/9] Installing dependencies..."
cd $JARVIS_DIR
npm install --production
echo "Dependencies installed ✓"

# --- 7. Create secrets file if missing ---
echo ""
echo "[6/9] Configuring secrets..."
if [ ! -f "$JARVIS_DIR/config/secrets.env" ]; then
  cp $JARVIS_DIR/config/secrets.env.example $JARVIS_DIR/config/secrets.env
  echo ""
  echo "⚠️  SECRETS FILE CREATED: $JARVIS_DIR/config/secrets.env"
  echo "⚠️  Edit this file and add your Slack token before Slack will work."
  echo "⚠️  Other services work without it."
fi
chmod 600 $JARVIS_DIR/config/secrets.env

# Write detected chromium bin to secrets
if ! grep -q "^CHROMIUM_BIN=" $JARVIS_DIR/config/secrets.env; then
  echo "CHROMIUM_BIN=$CHROMIUM_BIN" >> $JARVIS_DIR/config/secrets.env
fi

# --- 8. Install systemd services ---
echo ""
echo "[7/9] Installing systemd services..."
for service in jarvis-memory jarvis-screenshot jarvis-metrics jarvis-slack jarvis-audit; do
  cp $JARVIS_DIR/systemd/${service}.service /etc/systemd/system/
  echo "Installed: ${service}.service"
done

systemctl daemon-reload

for service in jarvis-memory jarvis-screenshot jarvis-metrics jarvis-slack jarvis-audit; do
  systemctl enable $service
  systemctl restart $service
  sleep 1
done

echo "Systemd services installed and started ✓"

# --- 9. Verify ---
echo ""
echo "[8/9] Verifying services..."
sleep 3

ALL_OK=true
for port in 9200 9201 9202 9203 9204; do
  if curl -sf http://127.0.0.1:${port}/*/health > /dev/null 2>&1 || \
     curl -sf http://127.0.0.1:${port}/memory/health > /dev/null 2>&1 || \
     curl -sf http://127.0.0.1:${port}/screenshot/health > /dev/null 2>&1 || \
     curl -sf http://127.0.0.1:${port}/metrics/health > /dev/null 2>&1 || \
     curl -sf http://127.0.0.1:${port}/slack/health > /dev/null 2>&1 || \
     curl -sf http://127.0.0.1:${port}/audit/health > /dev/null 2>&1; then
    echo "Port $port: ONLINE ✓"
  else
    echo "Port $port: NOT RESPONDING ✗"
    ALL_OK=false
  fi
done

# --- 10. Test screenshot ---
echo ""
echo "[9/9] Testing screenshot capture..."
SCREENSHOT_TEST=$(curl -sf -X POST http://127.0.0.1:9201/screenshot/capture \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","options":{"waitMs":2000}}' 2>/dev/null || echo '{"ok":false}')

if echo "$SCREENSHOT_TEST" | grep -q '"ok":true'; then
  echo "Screenshot test: PASSED ✓"
else
  echo "Screenshot test: FAILED ✗ (Chromium may need --no-sandbox flags)"
fi

echo ""
echo "================================================"
if [ "$ALL_OK" = true ]; then
  echo " ✅ JARVIS INSTALL COMPLETE"
else
  echo " ⚠️  JARVIS INSTALLED WITH WARNINGS"
  echo " Check: journalctl -u jarvis-<name> -n 30"
fi
echo ""
echo " Next steps:"
echo " 1. Edit secrets: nano $JARVIS_DIR/config/secrets.env"
echo " 2. Add Slack token (SLACK_BOT_TOKEN)"
echo " 3. Set platform paths (ZOOBICON_PATH, VAPRON_PATH etc.)"
echo " 4. Restart after editing: systemctl restart jarvis-slack jarvis-audit"
echo " 5. Test session: bash $JARVIS_DIR/scripts/session-start.sh zoobicon"
echo "================================================"

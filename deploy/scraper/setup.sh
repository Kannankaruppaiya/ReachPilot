#!/usr/bin/env bash
# One-shot setup for the ReachPilot lead-scraper service on a fresh Ubuntu/Debian
# VPS (NO Docker needed). Installs Node 20, Google Chrome, Xvfb, the repo deps,
# and a systemd service that runs the scraper headful under a virtual display.
# Run as root:   bash setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Kannankaruppaiya/ReachPilot.git}"
APP_DIR="${APP_DIR:-/opt/reachpilot}"

echo "==> System packages (Xvfb + Chrome libs)"
apt-get update
apt-get install -y --no-install-recommends \
  git curl ca-certificates gnupg xvfb fonts-liberation \
  libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxshmfence1

echo "==> Google Chrome"
curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
apt-get install -y /tmp/chrome.deb
rm -f /tmp/chrome.deb

echo "==> Node.js 20"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Clone + install"
[ -d "$APP_DIR" ] || git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR/server-v2"
npm install

if [ ! -f .env ]; then
  cp ../deploy/scraper/.env.scraper.example .env
  echo "!! Edit $APP_DIR/server-v2/.env — set GEMINI_API_KEY + SCRAPER_SERVICE_TOKEN — then: systemctl restart reachpilot-scraper"
fi

echo "==> systemd service"
cp ../deploy/scraper/reachpilot-scraper.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now reachpilot-scraper

echo "==> Done.  Health:  curl localhost:4100/health   Logs:  journalctl -u reachpilot-scraper -f"

# ReachPilot lead-scraper service — headful Chrome under Xvfb.
#
# Runs the free Google → LinkedIn scraper on a headless Linux box: Xvfb gives
# Chrome a virtual screen so it launches FULLY headful (passes bot-detection)
# with no physical monitor. Build from the REPO ROOT:
#
#   docker build -f deploy/scraper/Dockerfile -t reachpilot-scraper .
#   docker run -d --name scraper -p 4100:4100 --env-file server-v2/.env reachpilot-scraper
#
FROM node:20-bookworm

# Xvfb + Google Chrome + the shared libs headful Chrome needs on a slim image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb wget gnupg ca-certificates fonts-liberation \
      libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxshmfence1 \
    && wget -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get install -y /tmp/chrome.deb \
    && rm -f /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server-v2
COPY server-v2/package*.json ./
RUN npm install
COPY server-v2 ./

ENV DISPLAY=:99
EXPOSE 4100
# xvfb-run wraps the process with a virtual display on :99.
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1920x1080x24", "npm", "run", "start:scraper"]

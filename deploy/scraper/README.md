# Lead-scraper service — VPS deployment (Xvfb)

Runs ReachPilot's free Google → LinkedIn scraper on a cheap Linux box so the
browser work no longer needs your always-on PC. **Xvfb** gives Chrome a virtual
screen, so it launches *fully headful* (passes Google's bot-detection) with no
monitor attached.

**Safe to move off the PC:** this path reads Google only — it never touches a
LinkedIn account session, so a datacenter VPS IP can't get an outreach account
banned. (The LinkedIn driver is different — it must keep a consistent home/
residential IP, so don't move that here without a residential proxy.)

## Architecture

```
Leads UI / AI "scrape_leads"  ──►  main worker (PC)  ──HTTP──►  scraper service (VPS + Xvfb)
                                        │                              │ patchright headful Chrome
                                        │◄──────── leads JSON ─────────┘ → Google → parse → validate
                                        └──►  LeadsService.importLeads (dedup)
```

- Set `SCRAPER_SERVICE_URL` (and matching `SCRAPER_SERVICE_TOKEN`) on the **main
  worker** to offload scraping to the VPS. Leave it empty and everything scrapes
  locally in-process exactly as before — this change is fully backward-compatible.
- If the service is unreachable, the worker **falls back to a local scrape**, so a
  VPS blip never drops a job.

## Deploy — option A: bare metal (no Docker)

On a fresh Ubuntu 22.04+ VPS, as root:

```bash
git clone https://github.com/Kannankaruppaiya/ReachPilot.git /opt/reachpilot
bash /opt/reachpilot/deploy/scraper/setup.sh
# edit /opt/reachpilot/server-v2/.env  → set GEMINI_API_KEY + SCRAPER_SERVICE_TOKEN
systemctl restart reachpilot-scraper
curl localhost:4100/health          # -> {"ok":true}
journalctl -u reachpilot-scraper -f # live logs
```

## Deploy — option B: Docker

From the repo root:

```bash
docker build -f deploy/scraper/Dockerfile -t reachpilot-scraper .
docker run -d --name scraper -p 4100:4100 --env-file server-v2/.env reachpilot-scraper
```

## Wire the main worker (on the PC) to use it

In `server-v2/.env` on the PC:

```
SCRAPER_SERVICE_URL=http://<vps-ip>:4100      # or a tunnel URL
SCRAPER_SERVICE_TOKEN=<same long secret as the VPS>
```

Restart the worker. Trigger a scrape from the Leads screen — the browser now opens
on the VPS, not your PC. Confirm in the worker log:
`lead-scrape: got leads from scraper service`.

## Notes

- **Auth:** keep port 4100 behind the VPS firewall or a tunnel; the bearer token is
  the only guard if it's exposed. Prefer binding it to a private network / tunnel.
- **Resources:** headful Chrome wants ~1–2 GB RAM per concurrent browser; a 2 GB
  VPS handles the single-concurrency scraper fine.
- **Chrome:** the image/setup installs `google-chrome-stable`; patchright uses it
  via `channel:'chrome'` and falls back to bundled Chromium if absent.
- **Free tier:** an Oracle Cloud *Always Free* ARM VM (or any ~₹300–500/mo VPS)
  runs this comfortably.

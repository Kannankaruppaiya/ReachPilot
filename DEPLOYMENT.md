# Deployment (free, PC-hosted backend)

Live frontend: **https://reachpilot-eight.vercel.app** (Vercel, always up).
Backend (API + worker) runs on **your PC** and is reached via a Cloudflare tunnel.
DB is Supabase (cloud). So the app is live **only while your PC + the 3 processes below run**.

```
Browser → Vercel (frontend)
   │ /api  (vercel.json rewrite)
   ▼
Cloudflare Tunnel  →  your PC:  API :4000  +  Worker (Playwright)  →  Supabase (cloud DB)
```

## Start it (3 terminals on your PC)

```powershell
# 1. API
cd C:\Users\Kannan\Documents\ReachPilot-main\server-v2 ; npm run start:api

# 2. Worker
cd C:\Users\Kannan\Documents\ReachPilot-main\server-v2 ; npm run start:worker

# 3. Tunnel (keep open — do NOT close)
& "C:\Program Files (x86)\cloudflared\cloudflared" tunnel --url http://localhost:4000
```

## 🔴 When the tunnel restarts, the URL changes → update + redeploy

The free quick-tunnel prints a new `https://<random>.trycloudflare.com` each start.
When it changes:

1. Edit `vercel.json` → set the `rewrites[0].destination` to the new
   `https://<new>.trycloudflare.com/api/:path*`.
2. Redeploy the frontend:
   ```powershell
   cd C:\Users\Kannan\Documents\ReachPilot-main ; vercel --prod --yes --name reachpilot
   ```

To avoid this churn later: add a free domain to Cloudflare and use a **named tunnel**
(stable hostname), or move the backend to an always-on host (e.g. Oracle Cloud Always Free).

## Notes

- Frontend calls `/api` relative; Vercel proxies it to the tunnel (no CORS, no secret on Vercel).
- Secrets (`.env`) never leave your PC — only the static frontend is on Vercel.
- Worker must run for automation (connect/sync/etc.); signup/login work with just the API.
- PC off ⇒ frontend still loads but API calls fail until the PC + tunnel are back.

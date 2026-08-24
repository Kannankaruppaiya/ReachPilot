# Deployment runbook

> **Read the decision table before deploying anything.** The most expensive
> mistake with this stack is deploying to the servers and assuming you're done —
> for LinkedIn browser changes, the servers are not where the code runs.
>
> Last verified end-to-end: **2026-08-24**.

## Topology

```
Browser → Vercel (frontend, static)
   │ /api
   ▼
Oracle VM  reachpilot         129.225.104.114   pm2 rp-api      :4000
   │                                  │
   │  both talk to the SAME Redis ────┤  (worker VM, private IP 10.0.0.168:6379)
   ▼                                  │
Oracle VM  reachpilot-worker  129.225.68.89     pm2 rp-worker
   │
   │  LINKEDIN_DRIVER=remote → NO browser on the server.
   │  Actions are pushed to Redis `agent:inbox:<accountId>`
   ▼
YOUR PC — ReachPilot desktop app (Electron)
   runs the real Playwright driver on your own residential IP
```

Database is Supabase (cloud). Both VMs are `VM.Standard.E2.1.Micro` (Always Free).

## 🔴 The gotcha that cost us a debugging session

`server-v2/.env` on **both** VMs has:

```
LINKEDIN_DRIVER=remote
```

`remote` selects `RemoteAgentDriver`, which **never launches Playwright**. It
hands each action to the desktop app over Redis. The desktop app runs the real
`PlaywrightLinkedInDriver`.

But that driver is not a separate copy — `desktop/agent/build.js` esbuild-bundles
**the server source file** into the app:

```
server-v2/src/modules/drivers/playwright-linkedin.driver.ts
        │  npm run build:agent (esbuild)
        ▼
desktop/agent/driver.bundle.js
        │  npm run dist (electron-builder → app.asar)
        ▼
%LOCALAPPDATA%\Programs\ReachPilot\resources\app.asar
```

`desktop/main.js` does `require(path.join(__dirname, 'agent', 'driver.bundle.js'))`
— i.e. from **inside the installed app.asar**, not from the repo.

**Therefore: editing the LinkedIn driver and only scp-ing it to the VMs changes
nothing at runtime.** You must rebuild and reinstall the desktop app.

⚠️ `driver.bundle.js` and `desktop/dist/` are **gitignored**, so a stale local
bundle can sit weeks behind the source without any signal. It did: an Aug-7
bundle against an Aug-24 driver. Always run `build:agent` before believing a
desktop change is live.

## Decision table — what changed → what to deploy

| You changed | Server deploy | Desktop rebuild |
|---|---|---|
| `drivers/playwright-linkedin.driver.ts` | optional (source parity) | ✅ **required** |
| Anything else the desktop bundles (see `build.js` aliases/shims) | optional | ✅ **required** |
| `engine/` (pacing, scheduler), `worker.ts` | ✅ worker | — |
| API modules, controllers, services | ✅ api | — |
| Shared code used by both | ✅ both | — |
| `.env` on a VM | ✅ restart that proc | — |
| Frontend `src/` | Vercel deploy | — |

When unsure whether the desktop bundles a file:

```bash
cd desktop && npm run build:agent && grep -c "<a string you just added>" agent/driver.bundle.js
```

Non-zero ⇒ the desktop needs rebuilding.

## Runbook A — server deploy

The VMs are an **rsync'd copy at `/opt/ReachPilot/`, NOT a git checkout**.
`git push` deploys nothing; the servers never pull. Copy files directly.

Both processes run `npm run start:<api|worker>` with **ts-node** from
`/opt/ReachPilot/server-v2`, so copying the `.ts` source is enough — there is no
build step.

🔴 **Use `~/.ssh/oci_reachpilot.key`.** The other two keys on this machine both
fail, for different reasons, and neither says so obviously:
- `~/Downloads/ssh-key-2026-08-05.key` (what this runbook used to say) — OpenSSH
  REFUSES it: on Windows the file inherits Downloads' loose ACL, so you get
  `WARNING: UNPROTECTED PRIVATE KEY FILE` → `bad permissions` → `Permission
  denied (publickey)`. Moving a key into `~/.ssh/` is what fixes the ACL; left in
  Downloads it is not usable at all.
- `~/.ssh/oracle_reachpilot` — loads fine but the VMs reject it (wrong key).

Verified working 2026-08-25: `ssh -i ~/.ssh/oci_reachpilot.key ubuntu@129.225.68.89`
→ `reachpilot-worker`.

Run from the repo root. Substitute the path of whatever you changed.

```bash
scp -i ~/.ssh/oci_reachpilot.key server-v2/src/modules/drivers/playwright-linkedin.driver.ts ubuntu@129.225.68.89:/opt/ReachPilot/server-v2/src/modules/drivers/playwright-linkedin.driver.ts
```

```bash
scp -i ~/.ssh/oci_reachpilot.key server-v2/src/modules/drivers/playwright-linkedin.driver.ts ubuntu@129.225.104.114:/opt/ReachPilot/server-v2/src/modules/drivers/playwright-linkedin.driver.ts
```

```bash
ssh -i ~/.ssh/oci_reachpilot.key ubuntu@129.225.68.89 "pm2 restart rp-worker --update-env && pm2 list"
```

```bash
ssh -i ~/.ssh/oci_reachpilot.key ubuntu@129.225.104.114 "pm2 restart rp-api --update-env && pm2 list"
```

Verify the file actually landed (grep a string you just added):

```bash
ssh -i ~/.ssh/oci_reachpilot.key ubuntu@129.225.68.89 "grep -c '<your new string>' /opt/ReachPilot/server-v2/src/modules/drivers/playwright-linkedin.driver.ts"
```

Logs:

```bash
ssh -i ~/.ssh/oci_reachpilot.key ubuntu@129.225.68.89 "pm2 logs rp-worker --lines 50 --nostream"
```

## Runbook B — desktop deploy (required for driver changes)

Close the ReachPilot app first. Then, from the repo root:

```bash
cd desktop && npm run dist
```

That runs `build:agent` (esbuild) then `electron-builder --win nsis`, producing
`desktop/dist/ReachPilot Setup 0.1.0.exe`. Install it silently (PowerShell):

```powershell
Start-Process "C:\Users\Kannan\Documents\ReachPilot-main\desktop\dist\ReachPilot Setup 0.1.0.exe" -ArgumentList "/S" -Wait
```

`perMachine: false`, so it installs to `%LOCALAPPDATA%\Programs\ReachPilot`
without admin. App data in `%APPDATA%` survives the reinstall.

**Verify the fix is actually inside the installed app** — this is the step that
would have caught the stale bundle:

```bash
grep -c "<a string you just added>" "$LOCALAPPDATA/Programs/ReachPilot/resources/app.asar"
```

Zero means the app is still running old code no matter what the servers say.
Then reopen ReachPilot so the agent reconnects and starts polling for jobs.

## Runbook C — frontend

```bash
vercel --prod --yes --name reachpilot
```

## Facts

| | |
|---|---|
| SSH user | `ubuntu` |
| SSH key | `~/.ssh/oci_reachpilot.key` |
| Server code path | `/opt/ReachPilot/` (rsync'd, not git) |
| Server env | `/opt/ReachPilot/server-v2/.env` |
| API | `129.225.104.114`, pm2 `rp-api`, port 4000 |
| Worker | `129.225.68.89`, pm2 `rp-worker` |
| Redis | worker VM `:6379`; API reaches it at `10.0.0.168:6379` (private VCN IP) |
| Desktop install | `%LOCALAPPDATA%\Programs\ReachPilot` |
| pm2 logs | `/home/ubuntu/.pm2/logs/rp-{api,worker}-{out,error}.log` |

Current server flags worth knowing: `EMAIL_DRIVER=gmail`,
`LINKEDIN_SYNC_ENABLED=false` (acceptance/reply detection is OFF).

## Why this file exists

A connect batch failed with `connect_target_mismatch`: profiles opened, the
dropdown expanded, then every job aborted back to `scheduled`. The driver fix was
written, tested, scp'd to both VMs, and both pm2 processes restarted — and it
would still have changed nothing, because `LINKEDIN_DRIVER=remote` means the
browser work happens in the desktop app, whose bundled copy of the driver was
three weeks stale. Verify at the asar, not at the server.

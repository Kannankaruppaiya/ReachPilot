# ReachPilot Desktop — Phase 1 POC

Proves the core pivot: **the LinkedIn automation browser runs on the user's own
machine, so every action egresses from the user's OWN residential IP** — the fix
for the datacenter/server-IP ban problem. No proxy, no server-side browser.

This POC is standalone (no NestJS, no Redis, no server). It reuses the server
driver's launch strategy: persistent Chrome profile + real Chrome channel +
stealth patches. It is **safe** — step 3 only *detects* the Connect control, it
never clicks or sends an invite.

## Run

```
cd desktop
npm install
npm start
```

(First `npm install` downloads Electron + Playwright's Chromium — a few hundred MB,
once. If you have Google Chrome installed, the app prefers it via `channel:'chrome'`.)

## What to check

1. **Check IP** → opens a local browser, hits ipify, shows the egress IP.
   Compare with your real IP (whatismyip.com). **Same = the browser runs locally,
   LinkedIn sees your own IP.** ✅ (This is the whole thesis.)
2. **Open LinkedIn** → log in yourself (we never see the password). The session
   cookie persists in the local profile (`userData/linkedin-profile`).
3. **Find Connect** → paste a profile URL; it navigates and reports whether the
   Connect control is present (button OR top-card anchor, name-scoped). No click.

## Next (Phase 2+, see memory `reachpilot-desktop-app-plan.md`)

- Wire the REAL `PlaywrightLinkedInDriver` (server-v2) in place of the trimmed
  logic here.
- Job-dispatch protocol: pull jobs from the server API (WebSocket/long-poll),
  execute locally, report results — server keeps pacing/scheduling/DB.
- Single-active-runner lock, embedded self-login onboarding, server-driven
  selectors, stub installer + auto-update.

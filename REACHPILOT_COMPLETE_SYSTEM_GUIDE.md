# ReachPilot — Complete System Guide

> **An Expandi/Dripify-class LinkedIn + Email outreach automation platform.**
> This document captures *everything* — how the system works, how it must be built,
> what to use, and how to use it. Nothing from our discussion is left out.
>
> Read this top-to-bottom before building. It is the single source of truth.

---

## Table of Contents

1. [What we are building](#1-what-we-are-building)
2. [The core idea in one picture](#2-the-core-idea-in-one-picture)
3. [How LinkedIn connection actually works](#3-how-linkedin-connection-actually-works)
4. [Sessions & staying "logged in" forever](#4-sessions--staying-logged-in-forever)
5. [Browser automation — the real mechanism](#5-browser-automation--the-real-mechanism)
6. [Finding buttons & elements on LinkedIn](#6-finding-buttons--elements-on-linkedin)
7. [The scenario matrix (what LinkedIn throws at you)](#7-the-scenario-matrix)
8. [The ban-avoidance stack (why accounts survive)](#8-the-ban-avoidance-stack)
9. [System architecture](#9-system-architecture)
10. [Current codebase state (what exists today)](#10-current-codebase-state)
11. [The tech stack — what to use & why](#11-the-tech-stack)
12. [How to build it — step by step](#12-how-to-build-it-step-by-step)
13. [Building the LinkedIn Playwright driver (the hard part)](#13-building-the-linkedin-playwright-driver)
14. [How to run everything (dev & prod)](#14-how-to-run-everything)
15. [Legal & compliance reality](#15-legal--compliance-reality)
16. [Build roadmap / checklist](#16-build-roadmap--checklist)

---

## 1. What we are building

ReachPilot automates outreach on **LinkedIn** (and email) on behalf of a user:
it connects to their LinkedIn account, then automatically sends connection
requests, messages, follow-ups, profile visits, likes, and emails — following a
**smart campaign sequence** (if-then graph) — while staying under LinkedIn's radar
so the account **doesn't get banned**.

Same category as **Expandi, Dripify, Waalaxy, MeetAlfred**. The value is *not* the
clicking — it's doing it **safely, at scale, 24/7, per user**.

**Core promise to the user:** "Connect your LinkedIn once → we run human-like
outreach for you from a dedicated IP → your account stays safe."

---

## 2. The core idea in one picture

```
User logs in ONCE (signup)
        │
        ▼
We capture the LinkedIn SESSION COOKIE (li_at)  ──►  store it encrypted
We store the 2FA seed                            ──►  auto-answer challenges
We assign a dedicated country IP (proxy)         ──►  consistent identity
        │
        ▼
For every action (connect / message / like):
   spin up a cloud browser → inject cookie → route via the proxy →
   act like a human (jitter, working hours, caps) → detect trouble → report
        │
        ▼
A queue (the "brain") paces everything so it looks human → account survives
```

**Two things do all the work:**
- The **stored cookie** = the account is "logged in" without ever re-entering a password.
- The **queue/scheduler** = paces actions so LinkedIn sees a normal human, not a bot.

---

## 3. How LinkedIn connection actually works

### The signup login flow (what the onboarding Step 2 & 3 screens represent)

```
1. User types LinkedIn email + password → "Connect LinkedIn"
        │
2. Backend launches a cloud browser (Playwright)
        │   routed through the user's DEDICATED country IP (e.g. India)
        ▼
3. Browser opens linkedin.com/login → types email + password  (ONE time only)
        │
4. LinkedIn authenticates → issues a SESSION COOKIE (li_at)
        │
5. Backend CAPTURES the li_at cookie  ← the golden ticket
        │
6. Encrypts it → stores in database
        │
7. THROWS AWAY the raw password (good tools never keep it)
```

**Key insight:** the password's *only* job is to obtain the `li_at` cookie once.
After that the cookie **is** the login. This is why the UI can honestly say
*"Your credentials are encrypted, never shared or visible"* — we used the password
once and discarded it.

### 2FA — locking the session to the IP (Step 3)

LinkedIn challenges logins from *new* IPs. The 2FA step handles this:

```
User pastes the 2FA SECRET KEY (base32, e.g. JBSWY3D...) into the platform
        │
Platform stores the seed → can now GENERATE the 6-digit PIN itself, anytime
        │
LinkedIn: "this IP + this session + valid 2FA = trusted"  → session becomes stable
```

**Why storing the 2FA seed matters:** it's not just for this one login. With the
seed saved, the platform auto-generates the PIN **every future time LinkedIn asks** —
without waking the user. That's the promise: *"ReachPilot enters the PIN whenever
LinkedIn asks."* The library for this is **`otplib`** (already in `server-v2`).

---

## 4. Sessions & staying "logged in" forever

### The big correction: NO browser stays open 24/7

A common misunderstanding: "the browser stays logged in inside." Physically, **no.**
Thousands of accounts can't each keep a Chrome window open forever (RAM explosion).

Instead the login is **stored, then replayed on demand** — *stateless re-hydration*:

```
              ┌──────────────────────────────┐
Signup  ──►   │   DATABASE (encrypted)        │
              │   li_at cookie:   xY9k...      │  ← "the logged-in state" lives HERE
              │   2fa_seed:       JBSWY...     │
              │   proxy:          India-IP     │
              └──────────────────────────────┘
                            │
   every job (connect/message/like/etc.):
                            ▼
   spin up browser → inject cookie → NOW logged in → act → tear down
   spin up browser → inject cookie → NOW logged in → act → tear down
```

The account "stays logged in" because the **cookie is saved**, not because a browser
is running. Exactly like your phone's LinkedIn app — it never asks you to log in
again because it holds the token and reuses it. Same principle, server-side.

### Keeping the session alive over months

The cookie can break. Keeping it alive is active engineering:

| Mechanism | How it keeps you logged in |
|---|---|
| **Dedicated stable IP** | Consistent IP → fewer challenges → cookie lives longer |
| **Stored 2FA seed** | Auto-enters PIN when challenged → session survives, user never notices |
| **Keep-warm visits** | Occasionally load the feed via the cookie so the session stays fresh |
| **Session-health checks** | Before each job, verify cookie still valid; if not → flag reconnect |
| **Cookie refresh** | LinkedIn issues new cookies during use → capture & update the stored one |

### When re-login IS needed (rare)

- User **changes LinkedIn password** → all sessions killed
- User **logs out** manually somewhere
- **Hard security lockout** (email/phone verification)
- Cookie **expires** (`li_at` ≈ 1 year; stable IP + activity keeps refreshing it)

→ Platform marks account **"Disconnected"** → asks user to reconnect (re-enter
password once → capture a fresh cookie). Everything else stays automatic.

---

## 5. Browser automation — the real mechanism

### Two ways to perform any LinkedIn action

| | **Headless browser** (Playwright) | **Voyager API** (private endpoints) |
|---|---|---|
| How | Real Chrome loads cookie, *clicks* buttons | HTTP calls to `/voyager/api/...` with cookie |
| Realism | Very high — real DOM, real clicks | Lower — raw HTTP |
| Speed | Slow (seconds/action, heavy RAM) | Fast (ms) |
| Detectability | Harder to fingerprint | Easier to fingerprint as bot |
| Fragility | Breaks on UI change | Breaks on API change |

**Safety-first tools (Expandi) use the browser approach.** `server-v2` is designed
around **Playwright** (`LinkedInDriver` interface). Realism > speed for account safety.

### The headless-browser flow, step by step

```
1. One browser CONTEXT per account (isolated cookies/cache/fingerprint)
2. Restore session:  context.addCookies([{ name:'li_at', value:<decrypted>, ... }])
3. Route through the account's proxy + matching userAgent/locale/timezone
4. Act like a human: scroll → hover → random delay → click → type char-by-char
5. Stealth-patch:  hide navigator.webdriver, spoof plugins/WebGL/canvas
6. Checkpoint check: if CAPTCHA/security page → STOP, pause account, alert user
7. Report result → DB → release per-account lock (concurrency = 1)
```

**Critical anti-detection detail:** the browser's **timezone + locale must match the
proxy's geography.** A US IP with an India timezone is a mismatch LinkedIn checks for.

### Where browsers physically run

- A **worker fleet** — stateless containers, each running N browser contexts, autoscaled by queue depth.
- Contexts are **spun up per job, then torn down** (not kept open 24/7 → saves RAM, reduces long-session fingerprint risk).
- The **queue (BullMQ)** decides *which* account acts *when*; the browser just executes one action and reports.

---

## 6. Finding buttons & elements on LinkedIn

### The problem: LinkedIn's DOM is hostile on purpose

A real "Connect" button looks like:

```html
<button class="artdeco-button artdeco-button--2 ember-view _1x2y3z">
  <span class="artdeco-button__text">Connect</span>
</button>
```

- `_1x2y3z` → hashed class names that **change every deploy**
- `ember1234` IDs → **auto-generated, different every page load**
- Buttons get **A/B tested** (different users, different DOM)
- Content is **lazy-loaded** (button may not exist on first paint)

→ **Never rely on class names or IDs.** Use stable anchors, in priority order:

### The selector hierarchy (most robust → least)

```
Priority 1: visible TEXT        page.getByRole('button', { name: 'Connect' })   ⭐ most stable
Priority 2: ARIA role/label     [aria-label="Invite John Doe to connect"]        ⭐ a11y = stable
Priority 3: data-* attributes   [data-control-name="connect"]
Priority 4: relative XPath      button under .pvs-profile-actions containing 'Connect'
Priority 5: CSS classes         ._1x2y3z                                          ❌ breaks weekly — forbidden
```

### Two must-handle patterns

1. **Wait, don't click blindly** (lazy load):
   ```js
   const btn = page.getByRole('button', { name: 'Connect' });
   await btn.waitFor({ state: 'visible', timeout: 10000 });
   await btn.click();
   ```
2. **Fallback cascade** (Connect often hidden in a "More" menu):
   ```js
   if (await page.getByRole('button', { name: 'Connect' }).count()) {
     await page.getByRole('button', { name: 'Connect' }).click();
   } else {
     await page.getByRole('button', { name: 'More actions' }).click();
     await page.getByRole('menuitem', { name: 'Connect' }).click();
   }
   ```

**A single selector never survives; a *cascade* does.** This is why real tools have
engineers whose whole job is keeping selectors working through LinkedIn redesigns.

*(The Voyager API approach sidesteps selectors entirely — it POSTs to an endpoint
using the profile's entity ID — but trades robustness for higher detectability.)*

---

## 7. The scenario matrix

The same "send a connection request" job hits **dozens of different states.** You
cannot ad-hoc `if/else` this — model every action as a **state machine returning a
known outcome enum.**

### A. Profile-state scenarios
| Scenario | Action |
|---|---|
| Already 1st-degree | Skip → `ALREADY_CONNECTED` |
| Invite already pending | Skip → `PENDING` |
| Connect is direct | Click |
| Connect hidden in "More" | Open More → click |
| No Connect (only Follow/Message) | Follow / InMail / skip → `NO_CONNECT_BUTTON` |
| Connect requires email | Skip / flag |
| Out of network (3rd°+) | InMail only (needs premium) |
| "LinkedIn Member" (private) | Skip |
| Profile deleted | `PROFILE_GONE` → mark lead dead |
| You've been blocked | Detect → `BLOCKED` → skip |

### B. Limit & throttle scenarios
| Scenario | Action |
|---|---|
| Weekly invite limit (~100–200) | `LIMIT_REACHED` → pause account, don't retry |
| "Add a note" limited (free ~5/mo) | Send without note, or skip note |
| Daily self-cap reached | Defer remaining to tomorrow |
| Commercial Use Limit (search throttle) | Back off searches |

### C. Security / challenge scenarios 🔴 (the dangerous ones)
| Scenario | Action |
|---|---|
| CAPTCHA | STOP, alert, don't push through |
| Checkpoint ("verify it's you") | Pause account, surface in UI |
| 2FA/PIN mid-session | Auto-enter stored code, or pause |
| Email/phone verification | Pause, notify user |
| Cookie expired/invalidated | Mark disconnected, prompt re-login |
| Temporary restriction (24–48h) | Auto-pause, retry after cooldown |
| Permanent ban | Stop all, alert, mark account dead |

### D. UI / timing scenarios
Button not loaded → auto-wait • modal intercepts click → dismiss first • chat overlay
covers buttons → close after use • infinite scroll → scroll incrementally • A/B variant
→ fallback cascade • overnight redesign → maintenance patch.

### E. Content / messaging scenarios
Missing personalization token → fallback text (never send "Hi {{firstName}}") • special
chars/titles → normalize • non-Latin names → handle encoding • message too long → truncate
• duplicate lead across campaigns → dedup.

### F. Post-action / outcome scenarios
Invite accepted → advance sequence • ignored N days → withdraw stale invite → email fallback
• **replied → auto-pause sequence, hand to human** • "not interested"/"stop" → blacklist
• bounce → mark email invalid.

### How to tame the chaos
1. **Every action returns ONE known outcome enum** — never "it just crashed":
   ```
   SENT | ALREADY_CONNECTED | PENDING | NO_CONNECT_BUTTON |
   LIMIT_REACHED | CHECKPOINT | PROFILE_GONE | BLOCKED | ERROR
   ```
2. **Detect state first, act second** — read the page, classify, then choose.
3. **Fail safe, not forward** — in any doubt (unknown modal, security page) → *pause*, don't guess. A skipped lead is free; a ban is catastrophic.
4. **Idempotent & resumable** — re-running a job must never double-send.
5. **The queue owns recovery** — retries+backoff for transient, dead-letter+alert for permanent. The browser worker only *reports*; the scheduler decides next.

> The click is ~10% of the work. This scenario matrix is the other ~90%. This is
> exactly why Expandi/Dripify are real companies with engineering teams, not scripts.

---

## 8. The ban-avoidance stack

Why accounts survive despite LinkedIn forbidding automation — ranked by impact:

```
IP consistency         ████████████  ~35%   (dedicated, country-matched, residential, never shared)
Volume/warm-up caps    █████████     ~25%   (start 15-18/day → ramp to 45/day over ~2-3 weeks)
Human mimicry          ██████        ~18%   (jitter, working hours in acct TZ, natural action mix)
Session hygiene        ████          ~12%   (1 action at a time, cookie reuse not re-login)
Checkpoint detection   ███           ~7%    (small %, but prevents the WORST outcome — ban)
List/content hygiene   █             ~3%    (dedup, blacklist, non-spammy content, verified emails)
```

### Layer detail
1. **IP consistency (most critical)** — one residential/mobile proxy per account,
   pinned for life, country-matched. Datacenter IPs & shared IPs & IP churn are the
   top ban triggers.
2. **Volume discipline** — warm-up ramp + hard daily caps (~45 connects/day, ~50
   emails/day); withdraw stale invites. Sudden volume spikes = clearest bot signal.
3. **Human mimicry** — randomized jitter (minutes, not fixed intervals), working-hours
   windows in the account's timezone, natural action mix (visit → follow → like → then
   connect), randomized order.
4. **Session hygiene** — per-account concurrency = 1, cookie reuse over repeated logins,
   stable browser fingerprint.
5. **Checkpoint detection (circuit breaker)** — on CAPTCHA/challenge → STOP & alert,
   never push through. This is the difference between a 24h restriction and a dead account.
6. **List/content hygiene** — dedup + blacklist, avoid spammy identical templates, verify
   emails before sending.

**The two that carry most weight: IP consistency + volume discipline.** Get those two
wrong and no amount of jitter saves you. These aren't "polish" — **they ARE the product.**

> ⚠️ This is risk *reduction*, not removal. LinkedIn runs periodic enforcement sweeps
> that catch even well-configured accounts. The account owner holds the residual risk.

---

## 9. System architecture

Three layers that matter:

```
                    ┌───────────────────────────────┐
                    │        Client (React SPA)       │  ← the existing frontend
                    └───────────────┬─────────────────┘
                                    │ HTTPS / JSON, JWT
                          ┌─────────▼──────────┐
                          │   API layer         │  auth, tenant scoping, CRUD,
                          │   (NestJS/REST)     │  enqueue work — NEVER talks to LinkedIn
                          └─────────┬──────────┘
                    ┌───────────────┼───────────────┐
              ┌─────▼─────┐   ┌─────▼─────────┐   ┌──▼────────────┐
              │ PostgreSQL │   │ Redis+BullMQ  │   │ Object storage │
              │ (system of │   │ queues, sched,│   │ (attachments)  │
              │  record,   │   │ rate limits,  │   └───────────────┘
              │  RLS)      │   │ locks, jitter │
              └───────────┘   └─────┬─────────┘
                                    │ jobs dispatched
                    ┌───────────────┴──────────────────┐
                    │      Worker fleet (autoscaled)     │
              ┌─────▼──────┐  ┌──────▼──────┐  ┌────────▼────────┐
              │ LinkedIn   │  │ Email send  │  │ Inbox sync      │
              │ automation │  │ worker      │  │ (poll replies)  │
              │ (Playwright│  └─────────────┘  └─────────────────┘
              │  per acct) │
              └─────┬──────┘
                    │ 1 dedicated residential proxy per account
              ┌─────▼──────┐
              │ Proxy mgr   │──►  LinkedIn (country-matched egress IP)
              └────────────┘
```

1. **API layer** — synchronous, stateless, scalable. Serves SPA, validates, writes
   Postgres, **enqueues** work. Never touches LinkedIn. `POST /campaigns/:id/start`
   returns `202` and enqueues.
2. **Queue/scheduler (the brain)** — Redis + BullMQ. Turns campaign steps into
   time-scheduled, rate-limited, per-account jobs. Owns all pacing & safety.
   - One logical queue per capability: `linkedin-actions`, `email-send`, `inbox-sync`, `enrichment`, `webhooks`.
   - **Per-account concurrency = 1** (Redis lock keyed by `linkedin_account_id`).
   - Daily/weekly caps in Redis counters, warm-up ramp, working-hours windows, human jitter, delayed jobs for multi-day sequences, retries+backoff, dead-letter queue.
3. **Worker/automation layer** — long-running processes performing real actions and
   reporting results. LinkedIn (Playwright), Email (SMTP/OAuth/ESP), Inbox-sync (poll replies).

### Smart-campaign engine (the if-then sequences)
Model as a **directed graph state machine**:
- **Action nodes:** connect, message, InMail, email, visit, follow, like, endorse, wait, enrich, webhook, move-to-campaign.
- **Condition nodes (branch):** if connected / if replied / if email opened / if profile visited — each with true/false edges.
- Per-lead **enrollment** holds a cursor + timers. Step completes → evaluate edges →
  enqueue next step as a **delayed job**. Reply/accept events advance the graph in
  near-real-time (event-driven, not fixed clock).

---

## 10. Current codebase state

Two backends live in this repo. Know which is which:

### `server/` — the DEMO (mock, not real)
- Single Express process + flat `data.json` + a `setInterval` "send" loop.
- `POST /api/linkedin/connect` (`server/index.js:245`) **fakes** a `103.x.x.x` IP,
  waits 1.2s, stores it. **No real login, no cookie, no proxy, no browser.**
- Perfect for the UI demo. Cannot run real outreach. The password you type goes nowhere.

### `server-v2/` — the PRODUCTION backend (mostly built)
Already scaffolded with the right architecture:

| Piece | Status | Where |
|---|---|---|
| NestJS API, modular | ✅ Built | `server-v2/src/modules/*` |
| Postgres + Kysely + **RLS** | ✅ Built | `src/db/*` |
| **BullMQ + Redis** queues | ✅ Wired | `bullmq`, `ioredis` deps |
| Auth (JWT + **argon2**) | ✅ Built | `src/modules/auth/*` |
| **2FA via `otplib`** | ✅ Built | dep present |
| **PacingService** (daily/weekly caps, working hours, TZ, jitter) | ✅ Built | `src/modules/engine/pacing.service.ts` |
| Campaign **graph engine** (executor + condition evaluator) | ✅ Built | `src/modules/engine/*` |
| Jobs, leads, inbox, campaigns, accounts, analytics, billing, webhooks | ✅ Built | `src/modules/*` |
| **Driver abstraction** (`LinkedInDriver` / `EmailDriver` interfaces) | ✅ Built | `src/modules/drivers/*` |
| **`SimulatorDriver`** (fake driver for testing) | ✅ Built | `src/modules/drivers/simulator.driver.ts` |
| **REAL Playwright LinkedIn driver** | ❌ **MISSING** | *this is the gap* |
| Proxy pool manager (real residential proxies) | ⚠️ Partial | `src/modules/accounts/proxies.service.ts` |

**The single biggest missing piece:** a real `PlaywrightLinkedInDriver` that
implements the `LinkedInDriver` interface — cookie capture at connect, cookie
injection per job, proxy routing, human-paced selectors, checkpoint detection.
Everything *around* it (pacing, queue, engine, storage, 2FA) already exists.

The `LinkedInDriver` interface you must implement:
```ts
export interface LinkedInDriver {
  sendConnectRequest(targetUrl, message, proxyConfig?): Promise<{ status:'sent'|'failed'; externalId?; error? }>;
  sendMessage(targetUrl, message, proxyConfig?): Promise<{ status:'sent'|'failed'; externalId?; error? }>;
}
```
*(Recommend extending it to also cover `login/captureCookie`, `visitProfile`,
`follow`, `like`, and returning the richer outcome enum from §7.)*

---

## 11. The tech stack

| Layer | Use | Why (epadi decide pannirukkom) |
|---|---|---|
| Frontend | **React + Vite + Tailwind** | Already built (`src/`) — keep as-is |
| API | **Node.js + NestJS (TypeScript)** | Same language as SPA; DI, guards, validation. Already in `server-v2` |
| DB | **PostgreSQL + Kysely + RLS** | ACID, relational campaign/lead data, tenant isolation. Already wired |
| Queue/scheduler | **Redis + BullMQ** | Delayed jobs, per-key concurrency, rate limits, retries, DLQ. Already wired |
| Automation | **Playwright** (1 context/account) | Real LinkedIn actions, checkpoint handling. **← build this** |
| Stealth | **playwright-extra + stealth plugin** | Hide `navigator.webdriver`, spoof fingerprints |
| Proxies | **Residential/mobile, 1 dedicated IP/account** | Bright Data / IPRoyal / Smartproxy. Account safety, country match |
| 2FA | **otplib** | Generate LinkedIn PIN from stored seed. Already present |
| Email | **Gmail/O365 OAuth or SMTP; or Smartlead/ESP** | Deliverability, warm-up, SPF/DKIM/DMARC |
| Passwords | **argon2** | Strong hashing. Already present |
| Secrets | **KMS + envelope encryption** | Protect `li_at` cookies & OAuth tokens at rest |
| Realtime | **WebSocket/SSE** | Live queue/inbox/account-status updates to the SPA |
| Observability | **pino logs + OpenTelemetry + Prometheus/Grafana** | Traces, per-account health, alerting. `pino` already present |
| Object storage | **S3-compatible** | Attachments, exports, personalized images |

---

## 12. How to build it — step by step

Migration path from demo → production. The **frontend does not change** during
steps 1–3; the API keeps its endpoint shapes, only the implementation gets real.

1. **Stand up `server-v2`** — Postgres + Redis (Docker), run migrations, point the
   SPA's `/api` proxy at it instead of the demo `server/`.
2. **Auth + tenancy** — JWT sessions, `workspace_id` on every row, enable RLS
   (already scaffolded). Every query tenant-scoped.
3. **Swap the demo `setInterval` for BullMQ** — `send/create` enqueues delayed,
   rate-limited jobs (already wired in `server-v2`).
4. **Build the real Playwright LinkedIn driver** (§13) — replace `SimulatorDriver`.
   Replace the fake `103.x.x.x` IP generator with **real proxy assignment**.
5. **Proxy pool manager** — assign a residential country-matched IP at connect time,
   pin it for the account's lifetime, health-check, rotate same-geo on failure.
6. **Cookie capture + encrypted storage** — at connect, capture `li_at`; store
   encrypted (KMS envelope). Inject per job. Session-health checks + refresh.
7. **Checkpoint detection + account pause** — the circuit breaker (§7C).
8. **Inbox sync + webhooks** — poll replies (LinkedIn convos + email IMAP/Gmail API);
   reply → auto-pause that lead's sequence → create thread. Emit signed outbound webhooks.
9. **Email sending / Smartlead integration** — true multichannel.
10. **Harden** — secrets encryption, observability, autoscaling, DLQ handling,
    idempotency keys, dedup index, blacklist.

---

## 13. Building the LinkedIn Playwright driver

This is the gap. Below is the shape of what to build — a real implementation of the
`LinkedInDriver` interface, incorporating everything from §5–§8.

> ⚠️ Illustrative skeleton — real code needs stealth plugins, robust selector
> cascades per action, full outcome-enum handling, and continuous selector maintenance.

```ts
// server-v2/src/modules/drivers/playwright-linkedin.driver.ts
import { chromium, BrowserContext } from 'playwright';
import { LinkedInDriver } from './linkedin-driver.interface';

// Human-like helpers -------------------------------------------------
const rnd = (min: number, max: number) => Math.floor(Math.random() * (max - min) + min);
const think = () => new Promise(r => setTimeout(r, rnd(2000, 6000)));
async function typeLikeHuman(el, text: string) {
  for (const ch of text) { await el.type(ch, { delay: rnd(40, 160) }); }
}

// Build an account-pinned context: proxy + cookie + matching TZ/locale
async function openContext(opts: {
  proxyIp: string; proxyUser: string; proxyPass: string;
  li_at: string; userAgent: string; timezone: string; locale: string;
}): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true }); // use Xvfb+headful in prod
  const ctx = await browser.newContext({
    proxy: { server: opts.proxyIp, username: opts.proxyUser, password: opts.proxyPass },
    userAgent: opts.userAgent,
    locale: opts.locale,          // e.g. 'en-IN'  — MUST match proxy geo
    timezoneId: opts.timezone,    // e.g. 'Asia/Kolkata' — MUST match proxy geo
  });
  await ctx.addCookies([{ name: 'li_at', value: opts.li_at, domain: '.linkedin.com', path: '/' }]);
  // TODO: apply playwright-extra stealth patches (navigator.webdriver, WebGL, canvas...)
  return ctx;
}

// Checkpoint detection — the circuit breaker
async function detectCheckpoint(page): Promise<boolean> {
  return (await page.locator('text=/security check|captcha|unusual activity|verify it/i').count()) > 0;
}

export class PlaywrightLinkedInDriver implements LinkedInDriver {
  // (inject cookie/proxy/fingerprint from the account record before each call)

  async sendConnectRequest(targetUrl, message, proxyConfig?) {
    const ctx = await openContext(/* account creds + proxy */ ...);
    const page = await ctx.newPage();
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await think();

      if (await detectCheckpoint(page)) {
        // STOP — do NOT push through. Signal the scheduler to pause the account.
        return { status: 'failed', error: 'CHECKPOINT' };
      }

      // Already connected / pending? → skip (map to outcome enum in real code)
      if (await page.getByRole('button', { name: /^Message$/ }).count()
          && !(await page.getByRole('button', { name: /^Connect$/ }).count())) {
        return { status: 'failed', error: 'ALREADY_CONNECTED' };
      }

      // Selector cascade: direct button → else "More" menu
      let connect = page.getByRole('button', { name: 'Connect' });
      if (!(await connect.count())) {
        await page.getByRole('button', { name: 'More actions' }).click();
        connect = page.getByRole('menuitem', { name: 'Connect' });
      }
      await connect.waitFor({ state: 'visible', timeout: 10000 });
      await page.mouse.move(rnd(100, 400), rnd(100, 400)); // human noise
      await connect.click();

      // Add a note (if the flow offers it and message is provided)
      if (message && await page.getByRole('button', { name: 'Add a note' }).count()) {
        await page.getByRole('button', { name: 'Add a note' }).click();
        await typeLikeHuman(page.getByRole('textbox'), message);
      }
      await think();
      await page.getByRole('button', { name: /^Send/ }).click();

      return { status: 'sent' };
    } catch (err) {
      return { status: 'failed', error: String(err) };
    } finally {
      await ctx.close(); // tear down — nothing runs between jobs
    }
  }

  async sendMessage(targetUrl, message, proxyConfig?) {
    // Same pattern: open context → goto → checkpoint check → open messaging
    // overlay → typeLikeHuman → send → close. Handle "no message button" cases.
    return { status: 'sent' };
  }
}
```

**Login / cookie-capture flow** (separate method, run once at connect):
```ts
// 1. openContext WITHOUT a cookie, WITH the proxy
// 2. goto linkedin.com/login → fill email+password → submit
// 3. if 2FA page: generate PIN from stored seed (otplib) → fill → submit
// 4. read the li_at cookie:  const [c] = (await ctx.cookies()).filter(c => c.name === 'li_at')
// 5. encrypt + persist c.value; DISCARD the password
// 6. store fingerprint (userAgent/viewport) so future sessions match
```

**The pacing/queue side is already done** — `PacingService.checkPacingAndRegister()`
enforces daily/weekly caps + working hours + timezone, and `getRandomJitterMs()`
(30–180s) adds human jitter. The worker calls pacing → if allowed, calls this driver →
maps the result to an outcome → the engine advances the graph.

---

## 14. How to run everything

### The demo (current, works today)
```bash
cd Application
npm install
npm run dev            # Express API :4000 + Vite SPA :5173  (concurrently)
# open http://localhost:5173
```
- `npm run server` — API only (`server/index.js`)
- `npm run web` — SPA only (Vite)
- `npm run build` — production build

### The production backend (`server-v2`)
```bash
cd Application/server-v2
cp .env.example .env          # fill DB, Redis, proxy, KMS, JWT secrets
docker compose up -d          # Postgres + Redis (see docker-compose.yml)
npm install
npm run migrate               # apply schema (scripts/migrate.ts)
npm run seed                  # optional seed data

# run API + worker in two terminals:
npm run start:api:dev         # NestJS API  (ts-node-dev, hot reload)
npm run start:worker:dev      # BullMQ worker fleet
```
Then point the SPA's Vite proxy (`vite.config.ts`, currently `/api → :4000`) at the
`server-v2` API port instead of the demo, and you're on the real backend.

Other useful scripts: `npm run codegen` (regenerate DB types from schema),
`npm test` (Jest), `npm run lint`.

---

## 15. Legal & compliance reality

- **LinkedIn's User Agreement prohibits third-party automation.** Full stop.
- **The ToS breach is by the USER, not the tool company** — LinkedIn's main lever is
  restricting *user accounts*, which is why these SaaS products keep operating.
- **Legal action against the tools is limited** (*hiQ v. LinkedIn* was mixed). LinkedIn
  fights mostly on the **detection** side → it's a permanent arms race.
- **The whole safety design (§8) reduces but never eliminates ban risk.** LinkedIn runs
  periodic sweeps that catch even careful accounts.
- **The risk is asymmetric:** the vendor loses one customer; the *user* loses their
  network, history, and premium subscriptions. **Surface this to users; keep defaults
  conservative** (the UI already does: 18/day warm-up, working hours, "risk disconnects").

> Build the safety layers not as optional polish but as the core product. Be honest
> with users about residual risk.

---

## 16. Build roadmap / checklist

```
PHASE 0 — Foundation (mostly DONE in server-v2)
  [x] NestJS API, modular, tenant-scoped
  [x] Postgres + Kysely + RLS
  [x] Redis + BullMQ queues
  [x] JWT auth + argon2 + otplib 2FA
  [x] PacingService (caps, hours, TZ, jitter)
  [x] Campaign graph engine (executor + conditions)
  [x] Driver abstraction + SimulatorDriver

PHASE 1 — Make LinkedIn real  ← THE GAP
  [ ] PlaywrightLinkedInDriver: login + cookie capture
  [ ] Cookie injection per job + encrypted storage (KMS)
  [ ] Proxy pool manager: assign + pin + health-check residential IPs
  [ ] Selector cascades per action (connect/message/visit/follow/like)
  [ ] Stealth patches (playwright-extra)
  [ ] Checkpoint detection → account pause → user alert
  [ ] Full outcome-enum handling (§7) + idempotency

PHASE 2 — Multichannel & feedback loop
  [ ] Inbox sync worker (poll replies → auto-pause sequence)
  [ ] Email send worker (OAuth/SMTP or Smartlead) + warm-up
  [ ] Outbound signed webhooks + integrations (HubSpot/Zapier)
  [ ] Realtime WebSocket/SSE to SPA

PHASE 3 — Harden & scale
  [ ] Secrets in vault/KMS, encrypted at rest
  [ ] Observability: OTel traces, per-account health dashboards, alerting
  [ ] Autoscale worker fleet by queue depth
  [ ] DLQ handling + manual requeue
  [ ] Dedup index + shared blacklist + unsubscribe handling
```

**Bottom line:** the demo (`server/`) is a UI mock; `server-v2/` is the real system and
is ~70% there. The remaining core work is the **Playwright LinkedIn driver + proxy +
cookie management** (Phase 1) — the part that actually talks to LinkedIn safely.
Everything else (pacing, queue, engine, storage) is already built and waiting for it.
```

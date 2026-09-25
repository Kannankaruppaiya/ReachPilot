# 02 — LinkedIn account safety: how detection works, how competitors handle it, what ReachPilot must add

> **Read first.** LinkedIn's User Agreement prohibits bots and automation tools,
> and its help centre says accounts suspected of automation "may be suspended or
> restricted". No architecture makes automation *allowed*; the realistic goal —
> the one every vendor in doc 01 sells — is **keeping each customer's account
> inside the behaviour LinkedIn tolerates from a real, careful human**: human
> volumes, human timing, one consistent device and location, and outreach people
> actually accept. This document is written to that goal. It deliberately does
> **not** cover tricks whose purpose is to exceed LinkedIn's limits (see §5).

## 1. What LinkedIn actually looks at

### 1a. Published by LinkedIn (help centre, Sept 2026)
An account can be restricted from sending invitations when:
1. it sent **many invitations in a short time**;
2. **many invitations were ignored, left pending, or marked as spam**;
3. it sent an excessive number **and LinkedIn suspects an automation tool**.

Other published facts that should drive product rules:
- A first restriction lasts a few hours; several in a day → a few days; **too
  many outstanding invitations → up to a month**. Most lift within a week;
  Support will not remove one or say why.
- **Withdrawing an invitation blocks re-inviting that person for up to 3 weeks.**
  Withdrawing does not lift an active restriction.
- Free (Basic) members can add a personalised note to only **5 invitations per
  month** (ReachPilot already falls back to a note-less invite when the quota is
  spent — `server-v2/src/modules/drivers/connect-with-fallback.ts`).
- Network cap: 30,000 first-degree connections.
- LinkedIn publishes **no weekly number**. Third-party guidance converges on
  ~50–75/week for new accounts, ~100/week for established ones, up to ~200/week
  for trusted accounts with >40% acceptance; keep pending invites under ~400–500.

### 1b. Observed in LinkedIn's web client (independent researchers, 2025–2026)
LinkedIn's main JS bundle contains an anti-abuse module
(`AbuseFeaturesCollectionCoordinator`) that, on Chromium browsers:
- builds a **device fingerprint** from ~48 browser characteristics (canvas,
  WebGL, audio, fonts, hardware…);
- **probes for ~6,200 Chrome extension IDs** by fetching known files from each
  (`chrome-extension://<id>/<file>`) — the list grew from ~460 (2024) to 6,167
  (Feb 2026);
- walks the DOM for `chrome-extension://` traces left by injected UI;
- loads a HUMAN Security (PerimeterX) sensor and reCAPTCHA v3 Enterprise.

Implication: **extension-based tools are the most exposed architecture**, which
is why Waalaxy abandoned it and why the market treats "no extension" as a
baseline claim. ReachPilot's desktop agent uses its own browser profile with no
extensions — good.

### 1c. Session, network and behaviour signals (vendor documentation)
Consistently cited by Linked Helper, Expandi and HeyReach:
- **Login location / IP consistency** — the same account suddenly appearing from
  a new country, a datacenter/VPN range, or an IP with a high fraud score.
- **Simultaneous sessions** — the account active in the tool *and* the phone app
  at the same moment; two tools running on one account.
- **Timezone vs IP mismatch** — browser clock in one zone, IP in another.
- **Unnatural navigation** — opening many profiles back-to-back by direct URL
  ("LinkedIn can log you out if you open a lot of pages one after another via
  direct links as usually only bots do" — Linked Helper).
- **Machine timing** — identical gaps, identical daily counts, instant typing.
- **Repetitive content** — many near-identical invitations/messages.

## 2. How competitors respond (by architecture)

| Layer | Expandi | HeyReach | Waalaxy | Dripify | Linked Helper | La Growth Machine |
|---|---|---|---|---|---|---|
| Where the browser runs | Vendor cloud | Vendor cloud | Vendor cloud (since 2024) | Vendor cloud | User's PC / user's VPS | Vendor cloud |
| IP | Dedicated, country-based | Dedicated residential, never rotates | Fixed, near user, ≤5 users/IP (VPN) | Observed: shared datacenter | User's own; optional per-account proxy + proxy checker | Dedicated 5G mobile |
| Warm-up | Automatic ramp | Limits per sender | Monthly invite quota | Plan quotas + ramp | Smart daily-limit adjustment | Per identity |
| Limits | Per action type, ranges | Per sender, shared across campaigns | 300 / 800 invites per month | Published per-plan daily caps | Across all campaigns; advanced per-type limits | Per identity |
| Randomization | "Human behaviour" | Working hours | "Smart intervals" | Random delays, cooling-down | Delays between micro-steps, typing, click coords, start-time & count randomization | — |
| Health governance | Limit recommendations | Rotate sender on acceptance drop >20% or >30 pending | — | Activity control | Warnings + logout avoidance | Social warming before invite |

## 3. What ReachPilot already does (verified in code)

ReachPilot's pacing is **already at or above market level** on the "timing and
volume" axis:

| Layer | Where | Behaviour |
|---|---|---|
| Warm-up ramp | `server-v2/src/modules/engine/warmup.ts` | Starts at 5/day, +3 every 2 days, up to `warmup_target` (capped by `warmup_daily_limit`) |
| Daily-cap jitter | `pacing.service.ts` `jitterDailyLimit` | ±15% per account per day, deterministic |
| Inter-action spacing | `pacing.service.ts` `interactionGapMs` | Re-rolled per action: 90 s–7 min, ~15% of the time an 8–20 min break |
| Working hours / weekends | `pacing.service.ts` | In the **account's** timezone, wrap-around windows supported |
| Weekly invite cap | `pacing.service.ts` (`weekly_invite_cap`, default 100) | Invites only; views/follows/likes use the daily counter |
| Pre-action jitter | `worker.ts` (`getRandomJitterMs`) | 30–180 s before each job |
| Duplicate-invite guard | `scheduler.service.ts` + `jobs/profile-key.ts` | Never invites the same profile twice (URN or vanity slug) |
| Login once, reuse session | `accounts/login-policy.ts`, `linkedin-accounts.service.ts` | 6 h Redis login cooldown; login skipped when a session exists |
| Halt on checkpoint / limit / signed-out | `worker.ts` (`haltAccount`) | Pauses the account, notifies, holds jobs instead of burning leads |
| Real device + real IP | `desktop/main.js` + `RemoteAgentDriver` | Actions execute on the user's laptop via the bundled driver; session + IP never touch the server |
| Real Chrome, persistent profile per account | `playwright-linkedin.driver.ts` (`launchPersistentContext`, `channel: 'chrome'`) | One profile directory per LinkedIn account |

## 4. Gaps and how to close them

Priorities: **P0** = do before scaling users · **P1** = next · **P2** = later.

### G1 (P0) — Govern acceptance rate and pending invitations (LinkedIn's trigger #2)
**Today:** nothing measures acceptance or pending invites in production — the
data needs LinkedIn sync, which does not run in remote mode (doc 03).
**Build:**
1. After doc 03 lands, compute per account: `pending_invites` (sent
   `connect_request` jobs whose lead is not yet accepted), `acceptance_rate_14d`,
   `ignored_30d`.
2. Add a **health gate in `PacingService.checkPacingAndRegister`** for invites:
   - acceptance_rate_14d < 20% over ≥30 invites → halve the daily invite cap and
     notify ("your invites are being ignored — refine targeting");
   - pending_invites > 400 → stop new invites for the day, notify;
   - pending_invites > 600 → pause invites until the user acts.
3. **Pending cleanup job** (desktop agent action `withdraw_stale_invites`, doc 03):
   withdraw invites older than **28 days**, oldest first, **max 10 per day**,
   counted against the daily action budget; never re-invite a withdrawn person
   for 21 days (store `withdrawn_at` in the job payload/lead enrichment and have
   `createBatch` + scheduler skip them).
**Acceptance test:** a seeded account with 450 pending invites gets
`allowed:false` for `connect_request` but still sends messages.

### G2 (P0) — Make the weekly cap a true rolling 7 days, and fix the TTL leak
**Today:** the weekly counter is one Redis key whose 7-day TTL is set on the
*first* increment, so the window resets in a block; and `release()` can recreate
the key without a TTL, making the cap permanent (reproduced during the audit —
see the earlier bug report).
**Build:** store invite timestamps in a Redis sorted set
`pacing:linkedin:<acct>:invites` (score = epoch ms); `ZREMRANGEBYSCORE` older than
7 days, `ZCARD` to check, `ZADD` to register, `ZREM` the member on release. This
is rolling by construction and has no TTL edge. Also roll back the daily slot,
the campaign slot and `nextallowed` when the weekly check blocks (today it leaks
all three — `pacing.service.ts` ~line 192).

### G3 (P0) — Keep the browser profile somewhere the OS will not delete
**Today:** `profileDir()` puts each account's persistent Chrome profile under
`os.tmpdir()/reachpilot-profiles/<accountId>`
(`playwright-linkedin.driver.ts:443`). Windows Storage Sense / temp cleaners and
macOS reboot cleanup can wipe it; the next action then has to restore or re-login,
and **repeated logins are the #1 restriction trigger** (CLAUDE.md).
**Build:** in the desktop app pass a profile root from
`app.getPath('userData')` (e.g. `%APPDATA%/ReachPilot/profiles/<accountId>`) into
the bundled driver (an env var read by `agent/shims/env.js` is enough); migrate an
existing temp profile on first start. Rebuild + ship the desktop app (driver
changes only reach users through the desktop build — `DEPLOYMENT.md`).

### G4 (P0) — One runner per account, and warn about simultaneous use
**Today:** any desktop agent logged into the workspace pops jobs for *every*
account in it (`agent.controller.ts` `next`), and two laptops can drive the same
account from two IPs at once (the "split-brain" case the worker already logs via
`last_ip`).
**Build:**
1. Agent registers `(agentId, accountIds it has a session for)`; `next-job` only
   pops inboxes for those accounts.
2. Redis lease `agent:owner:<accountId>` = agentId (SET NX EX 60, renewed on each
   poll); a second agent gets no jobs for that account and the UI shows "running
   on <device>".
3. When `last_ip` changes country or ASN, notify: "Account X ran from a new
   network".
4. In the desktop app, show "LinkedIn automation is running — avoid using this
   LinkedIn account on your phone right now" during working hours.

### G5 (P1) — Per-action daily limits (like Expandi / Linked Helper)
**Today:** one daily counter covers all LinkedIn actions, plus the weekly invite
cap. A campaign heavy on profile visits eats the invite budget, and vice versa.
**Build:** add columns (or a JSON `limits`) on `linkedin_accounts`:
`daily_invites`, `daily_messages`, `daily_visits`, `daily_follows`,
`daily_inmails` with conservative defaults (invites follow the warm-up ramp;
messages 50; visits 80; follows 30; InMails 20) and a keyed Redis counter per
type. Keep the global spacing gap across all types.

### G6 (P1) — Account health score and automatic slow-down
Combine: acceptance_rate_14d, pending_invites, failed-send ratio (7d),
restriction/checkpoint events (30d), session-expiry count, IP changes. Expose as
**Healthy / Watch / At risk** on the Connections page and dashboard; *At risk*
automatically halves limits for 7 days. HeyReach publishes exactly these signals
as its agency SLA, so customers already expect them.

### G7 (P1) — Navigation realism for profile opens
**Today:** every action starts by opening the target profile by direct URL
(`gotoProfile`, `playwright-linkedin.driver.ts` ~line 282). With visits,
invites and messages all opening profiles directly, a busy day is a long run of
direct profile loads — the pattern Linked Helper documents as a logout trigger.
**Build (conservative):** keep volumes low (G5 caps visits), and do not stack
actions on the same person on the same day (visit → invite ≥ 1 day apart in the
default sequence templates). Evaluate, on a throwaway account, whether reaching
a share of profiles through LinkedIn's own UI (e.g. from a saved search results
page the user created) reduces logouts before building it broadly.

### G8 (P1) — Content variation guard
LinkedIn inspects repetitive text (Linked Helper). ReachPilot already has
spintax (`engine/spintax.ts`) and AI notes (`ai/connection-note.service.ts`).
Add a **pre-launch check** in the campaign builder: render the template for 20
sample leads; if more than 80% of renders are identical after variable
substitution, warn and suggest spintax or AI personalisation.

### G9 (P2) — Optional always-on runner (for customers who cannot keep a laptop open)
Cloud competitors win customers precisely because "campaigns stop when your
computer does" (Expandi's migration guide on Linked Helper). If ReachPilot adds
a hosted runner, it must match the market's safety bar: **one dedicated ISP or
residential IP per account, country-matched, never a datacenter range, never
rotating**, a fraud-score check before first login (Linked Helper warns that proxies scoring > 75 raise the chance of LinkedIn warnings),
and a clean migration of the existing session. `docs/PROXY_IP_RESEARCH.md`
already explains why the Oracle VMs (AS31898, one geolocating to Texas) must not
be used as egress. Make it an opt-in paid add-on; keep the laptop mode as the
default and the safety headline.

### G10 (P1) — Honest risk disclosure and customer consent
Add to signup / LinkedIn-connect: a plain statement that automation is against
LinkedIn's User Agreement, that restrictions are possible, and that ReachPilot
enforces conservative limits; store the acceptance timestamp. Every serious
vendor has this in its terms; it also protects the business (doc 11).

## 5. What not to build
- **Limit-bypass features** (e.g. deliberately using a second invitation channel
  to exceed LinkedIn's weekly allowance, as some vendors advertise). They target
  the restriction itself rather than normal behaviour, and they are exactly what
  trigger #3 ("suspected automation") exists to catch.
- **Fake or bought accounts, account rental, or account pools** — this is what
  LinkedIn has sued over (Proxycurl, ProAPIs).
- **Chrome-extension mode** — see §1b.
- **Profile scraping through a customer's sending account** — keep data
  extraction and sending separate (doc 05).

## 6. Rollout order
1. G3 (profile location) + G4 (runner lease) — both small, both stop real damage.
2. G2 (rolling weekly window + leak fixes).
3. Doc 03 (sync) → then G1 (acceptance/pending gate) and G6 (health score).
4. G5 per-action limits, G8 content check, G10 disclosure.
5. G7 and G9 only after measuring restriction rates on real accounts.

**Metric to watch after each step:** restrictions / checkpoints per 100 active
accounts per week (log them — `haltAccount` already writes notifications; add a
`account_events` table so this can be charted).

## Sources
- LinkedIn Help — invitation restrictions: https://www.linkedin.com/help/linkedin/answer/a551012 · invitation limit reached: https://www.linkedin.com/help/linkedin/answer/a550555
- Extension probing research: https://browsergate.eu/how-it-works/ · https://github.com/jaylane/linkedin-spyware-analysis · https://github.com/mdp/linkedin-extension-fingerprinting
- Linked Helper safety docs: https://support.linkedhelper.com/hc/en-us/articles/360015454919 · https://support.linkedhelper.com/hc/en-us/articles/23378382591250 · https://www.linkedhelper.com/safety-kit
- Waalaxy cloud move: https://www.waalaxy.com/blog/linkedin-automation-software/waalaxy-cloud
- HeyReach sender health: https://www.heyreach.io/blog/linkedin-automation-for-agencies
- Limits guidance: https://www.revenueflow.com/blog/linkedin-connection-limit · https://linkedapi.io/guides/linkedin-connection-limit-2026
- Dripify IP test: https://www.linkedhelper.com/reviews/dripify-review

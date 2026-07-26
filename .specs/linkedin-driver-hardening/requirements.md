# linkedin-driver-hardening — Requirements

- **Status:** Ready to build
- **Priority:** P0
- **Related:** `server-v2/src/modules/drivers/playwright-linkedin.driver.ts`,
  `warmup-browse.service.ts`, `linkedin-sync.service.ts`, `CLAUDE.md` (selectors, safety)

## Problem

The real Playwright driver works for the proven paths (login, cookie bootstrap, connect),
but several action selectors (acceptance/reply **sync**, **withdraw stale invites**, and
**engagement**: follow/visit/like/endorse) are written to the file's patterns but **not
yet validated against a live account**. LinkedIn's DOM is class-hashed and hostile, and
rapid/incorrect automation gets accounts checkpointed or banned. We need to harden and
validate the driver so real outreach is safe.

## Context that constrains the solution (learned the hard way)

- LinkedIn's profile top card is **not** a `<section>`; degree ("· 1st") is detected by
  TEXT; the "People also viewed" rail is a SIBLING — always scope to the `<h1>`-anchored
  top card or you act on the WRONG person.
- The persistent Chrome profile is the **single session owner**. Never inject a bare
  `li_at`; never replay full `storageState`. Missing session → throw `SESSION_MISSING`.
- Hard-navigating to the SPA-only `/preload/custom-invite/` deep-link causes an
  `ERR_TOO_MANY_REDIRECTS` loop that **poisons the profile's cookies** for all later
  actions. Must be prevented via a main-frame route-abort (not a click preventDefault).
- **Back-to-back browser sessions** on one account/IP read as bot activity. A shared
  cross-loop cooldown must gate actions vs warm-up-browse vs sync.

## User stories

1. As an operator, every action targets the correct person and the intended control, so I
   never send an invite/message to the wrong profile.
2. As an operator, a checkpoint or dead session pauses the account and notifies me, rather
   than retrying into a ban.
3. As an operator, the system never opens rapid back-to-back sessions on one account.
4. As an operator, I can trust the sync/withdraw/engagement actions because they've been
   validated against a throwaway account before prod.

## Acceptance criteria (EARS)

- **AC1** — WHEN performing any top-card action, the system SHALL scope element lookup to
  the `<h1>`-anchored top card and SHALL NOT match controls in the "also viewed" rail.
- **AC2** — IF a "Connect" control is only in the overflow ("More") menu as a
  `/preload/custom-invite/` link, THEN the system SHALL open the composer via the in-app
  click and SHALL abort any main-frame navigation to that URL (route-abort).
- **AC3** — WHEN opening any account browser context, the system SHALL require an existing
  profile session and SHALL throw `SESSION_MISSING` (before navigating) if absent, mapping
  to status `disconnected` + a reconnect notification, with **no retry**.
- **AC4** — WHEN LinkedIn presents a checkpoint/challenge, the system SHALL set the account
  to `checkpoint`/`paused`, notify the user, and hold the job (no automated retry).
- **AC5** — WHILE any loop (actions, warm-up browse, sync) considers opening a session, the
  system SHALL skip if another session for that account occurred within the shared cooldown
  (`BROWSER_SESSION_COOLDOWN_MS`), stamped on every browser open.
- **AC6** — The sync, withdraw-stale-invites, and engagement (follow/visit/like/endorse)
  selectors SHALL be validated against a live throwaway account and SHALL degrade safely
  (log + skip, never act on the wrong element) when a selector no longer matches.
- **AC7** — WHERE stealth is enabled, the system SHALL apply `playwright-extra` patches
  (hide `navigator.webdriver`, spoof WebGL/canvas/fingerprint) on every context.

## Non-goals

- Buying/operating residential proxies (tracked separately — proxy pool manager).
- Multi-account scale-out.

## Definition of done

- All ACs met; a full action set run against a throwaway account completes without
  redirect loops, wrong-target actions, or checkpoints caused by our own pacing.
- Selector cascades documented in `CLAUDE.md`; a `scripts/verify-linkedin.ts` run passes.

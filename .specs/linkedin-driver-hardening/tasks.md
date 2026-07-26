# linkedin-driver-hardening — Tasks

⚠️ Safety: validate against a **throwaway** account only, **one run at a time**, with
30–60 min rest between runs. Live scripts bypass pacing and will rate-limit an account.

## Lock in the safety mechanisms (verify they're present & correct)

- [ ] Confirm the custom-invite **route-abort** (`**/preload/custom-invite/**`, main-frame
      navigation only) is in place; add a regression check that the composer still opens.
- [ ] Confirm `openAccountContext` throws `SESSION_MISSING` before navigating when the
      profile has no `li_at`; worker → disconnect + notify, no retry.
- [ ] Confirm the shared `linkedin:browser:last:<acct>` cooldown is stamped on every open
      and honored by warm-up-browse and sync loops.
- [ ] Confirm checkpoint detection → `checkpoint`/`paused` + notify + hold (no retry).

## Selector validation (the actual gap)

- [ ] Move/confirm all action selectors as documented **cascades** in `linkedin-selectors.ts`.
- [ ] Add an h1-anchored top-card scope helper; ensure every top-card action uses it (AC1).
- [ ] Add a "wrong-person" guard (scoped name must match target) before acting.
- [ ] Validate **acceptance/reply sync** selectors live → fix → document.
- [ ] Validate **withdraw-stale-invites** selectors live → fix → document.
- [ ] Validate **engagement** (follow / visit / like / endorse) selectors live → fix → document.
- [ ] Ensure each cascade **logs + skips** on no-match (never a broad fallback).

## Stealth

- [ ] Add `playwright-extra` + stealth plugin behind `STEALTH_ENABLED`; apply per context.
- [ ] Add `STEALTH_ENABLED` to `.env` + `.env.example` + config schema.

## Verify & document

- [ ] `scripts/verify-linkedin.ts` passes end-to-end on the throwaway account.
- [ ] Update `CLAUDE.md` selector notes with any DOM changes found.
- [ ] Tick off acceptance criteria AC1–AC7 in `requirements.md`.

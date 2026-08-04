# Campaign Sequence Engine — Build Plan

Status snapshot: the sequence engine core is **built and end-to-end verified** (2026-07-31).
This plan tracks the remaining work to reach the commercial "safe tier" that Expandi /
HeyReach / La Growth Machine / Lemlist operate at. It is derived from competitor +
account-safety research (see the published architecture artifact) and mapped onto the
current ReachPilot codebase.

Guiding principle: **the sequence engine is done; the remaining differentiator is
account-safety infra + closing the feedback loop.** Every item below EXTENDS the current
engine — nothing is thrown away.

---

## ⚠ SCOPE (revised 2026-08-01, per Kannan): CAMPAIGN FEATURE ONLY.
Do NOT touch Auto Connect or Auto Mail (they work — leave them alone). That parks the
shared-infra items below that also affect those flows: **P2 (pacing), P3 (proxy), P4
(withdraw) are DEFERRED** (global engine, shared with Auto Connect/Auto Mail). P1 code is
done but dormant (flag off). Focus is completing the CAMPAIGN feature itself:

### Campaign completion (this scope)
- **① Edit existing campaign — ✅ DONE + verified (2026-08-01).** `persistSteps` (shared by
  create+update) + `decompile` (steps graph → builder nodes, inverse of compile incl. wait-fold
  + branch-else reconstruction). `update()` accepts `steps` → rebuilds sequence, cancels pending
  jobs, restarts enrollments at new entry. `get()` returns `builderNodes`. FE: CampaignBuilder
  `edit` prop (pre-fills, PATCH-not-POST, "Save changes"); Detail "Edit" → builder. Round-trip
  verified via throwaway script.
- **② Manage leads in detail + delete — ✅ DONE + verified.** Per-enrollment pause/resume/remove,
  "Add leads" modal (lead-picker → enroll), Delete campaign (confirm). Backend `remove()`,
  `setEnrollmentStatus()`, `removeEnrollment()` + endpoints `DELETE /:id`,
  `PATCH|DELETE /:id/enrollments/:eid` (cancel pending jobs on each). Verified.
- **④ Validation polish — ✅ DONE.** Launch/save blocked unless ≥1 action step; draft→Launch
  button in detail. (Skipped exposing untracked condition types — misleading without email
  tracking.)
- **③ A/B note variants — NOT done.** ab_tests/ab_variants tables exist; builder doesn't create
  variants, runner doesn't assign, Analytics doesn't report. The one remaining campaign feature.

Below (P1–P7) = the ORIGINAL full-engine roadmap, kept for reference; P2–P4/P6 are out of the
current campaign-only scope.

---

## Done (baseline)
- Editable multi-step sequence builder (7 node types, add/remove/reorder) — `src/screens/Campaigns.tsx`.
- Conditional branching (condition + else-fallback fork) — compiled to `campaign_steps`.
- Durable runner + paced queue — `campaign-runner.service.ts`, `graph-executor.ts`, `scheduler.service.ts`.
- Warm-up ramp, human pacing (6–14 min spacing + working-hours gate), passive browse warm-up.
- Personalization: variables + spintax + Gemini + Apify enrichment.
- Migration `0007_campaign_engine.sql` (step_entered_at) applied.

---

## P1 — Close the feedback loop (sync-driven conditions)  ✅ CODE DONE (flag off, awaiting live test)
**Why:** `if_connected` / `if_replied` conditions read `lead.status` (accepted/replied). That
status is only updated by `LinkedInSyncService`, which is currently DISABLED
(`LINKEDIN_SYNC_ENABLED=false`). Until it runs, every branch is blind — leads never flip to
"accepted", so on_true paths never fire.

**Work (code, account-safe to build):**
- Make the sync interval configurable + set a safer, lower default (was a hardcoded 5 min →
  env `LINKEDIN_SYNC_TICK_MS`, default 30–60 min). Fewer browser opens = safer.
- Confirm the shared browser-session cooldown (`linkedin:browser:last:<acct>`) prevents sync
  from stacking on top of an action/warm-up session.
- Verify the condition evaluator reads the synced status end-to-end.

**Account-touching switch (Kannan flips during a supervised live test):**
`LINKEDIN_SYNC_ENABLED=true` — this opens a real browser on the account on a timer. Keep it
OFF in code; turn on only when ready to watch it.

**Acceptance:** with sync on, an accepted invite flips the lead to `accepted`, and a campaign
`if_connected` branch takes the on_true path on the next runner tick.

**Done (2026-08-01):** `LINKEDIN_SYNC_TICK_MS` env added (default 45 min; was hardcoded 5 min);
worker uses it. Feedback-loop correctness verified by code — `ConditionEvaluator` reads
`lead.status==='accepted'|'replied'`, `LinkedInSyncService.apply()` sets `accepted`. Backend
tsc clean, worker boots clean (sync still DISABLED as intended). ⬅ **Kannan: flip
`LINKEDIN_SYNC_ENABLED=true` in `server-v2/.env` during a supervised live test to activate.**

---

## P2 — Randomized pacing distribution  (pure code, zero account risk)
**Why:** research shows real human pacing is 45s–8min in bursts-then-quiet, not a flat gap.
A metronome is a detection signal.
**Work:** replace the flat inter-action gap with a realistic distribution (2–3 action bursts,
then a long quiet stretch) + per-action jitter, in `pacing.service.ts`. Keep hard daily/weekly
caps + working-hours gate intact.
**Acceptance:** consecutive action timestamps show burst+quiet variance, still under caps.

---

## P3 — Per-account residential proxy at scale
**Why:** the one missing piece vs the safe tier. Home IP is fine for one warmed test account,
not multi-account production.
**Work:** wire the existing 1-proxy-per-account model (`assignProxy`, unique `proxy_id`) to a
real country-matched residential provider; egress each account's browser through its proxy.
**Acceptance:** each account's browser traffic exits via its assigned residential IP.

---

## P4 — Stale-invite withdrawal
**Why:** a real safety signal (healthy humans prune) + frees weekly-invite quota.
**Work:** re-enable the withdraw path (currently off with sync); auto-withdraw pending invites
older than 4–6 weeks. Gate behind the same session cooldown.
**Acceptance:** invites pending > N weeks are withdrawn on a low-frequency pass.

---

## P5 — A/B variants per step
**Why:** the `ab_tests` / `ab_variants` tables already exist; unused.
**Work:** let a connect/message step hold 2+ note variants; assign per-enrollment (round-robin);
set `jobs.ab_variant_id`; surface accept/reply significance in Analytics (min 30 sends).
**Acceptance:** a step with 2 variants splits enrollments and reports per-variant accept rate.

---

## P6 — Multichannel polish + unified inbox
**Why:** email steps model exists + Gmail driver is live; make email first-class in-sequence and
route both channels' replies into one inbox.
**Work:** finish email-step rendering/sending inside the runner path; wire replies (LinkedIn +
Gmail) into `threads` so a human takeover is one click.
**Acceptance:** a sequence can go connect → wait → email, and a reply lands in the inbox.

---

## P7 — Guardrail dashboard
**Why:** surface the safety state the engine already tracks, the way Expandi/Dux-Soup do.
**Work:** a panel showing today's used vs cap, acceptance rate, account health, warm-up day —
"you're in the safe zone" at a glance.
**Acceptance:** the dashboard reflects live pacing/warm-up/health without a refresh.

---

Sequencing logic: **P1** unlocks the conditional engine's real value; **P2–P4** are pure
account-safety hardening (the real differentiator); **P5–P7** are commercial polish.

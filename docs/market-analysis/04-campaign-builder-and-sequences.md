# 04 — Campaign builder, sequences, personalisation and A/B testing

## 1. Market bar

| | Expandi | Dripify | La Growth Machine | Skylead | lemlist | ReachPilot today |
|---|---|---|---|---|---|---|
| Actions in builder | 19 | 10+ | LinkedIn, email, X, calls, voice | LinkedIn + email | email, LinkedIn, call, manual, WhatsApp | 5 (view, invite, message, email, follow) + wait |
| Conditions | 11 (accepted, replied, email opened, custom…) | several | accepted, "visited you back", follows you | if/else across channels | engagement-based | 3 offered in UI (`if_connected`, `if_replied`, `if_has_email`) |
| Branching | full if/else tree | tree | tree | tree | tree | linear + one condition with a single "else" action |
| A/B testing | ✅ | ✅ 3 variants/step | ✅ | ✅ | ✅ | ❌ |
| Step analytics | ✅ per step | ✅ with alerts | ✅ | ✅ | ✅ | ❌ (campaign totals only) |
| Templates library | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (read-only screen, no way to save) |
| Rich personalisation | image/GIF, video | 20+ vars + fallback | AI voice, AI copy | image/GIF | images, landing pages | 6 variables + `{{var|fallback}}`, spintax, AI note (Auto Connect only) |
| Signal-based entry | profile viewers, post engagers, groups, events | post engagers | likers, commenters, event attendees | 8 sources | intent signals | ❌ |

## 2. Current implementation (verified)

- **Builder → steps compiler:** `server-v2/src/modules/campaigns/campaigns.service.ts`
  (`compile` / `persistSteps` / `decompile`). Waits fold into the next step's
  `delay_hours`; a `branch` becomes a `condition` step whose `on_true` continues
  the main line and whose `on_false` is at most one fallback action.
- **Node palette:** `src/screens/Campaigns.tsx` (~lines 588–600).
  `NODE_ACTION` maps only invite / message / email / view / follow.
- **Executor:** `server-v2/src/modules/engine/graph-executor.ts` — now RLS-safe and
  handles canceled/sent jobs correctly (commit "fix(engine) …"). The data model
  already supports a full graph (`next_step_id`, `on_true_step_id`,
  `on_false_step_id`) — only the builder is linear.
- **Worker** can already execute `inmail`, `like_post`, `endorse_skill`
  (`worker.ts` action switch); the builder just cannot create them.
- **Conditions:** `engine/condition-evaluator.ts` has 9; `if_email_opened`,
  `if_email_clicked`, `if_inmail_opened`, `if_profile_visited`, `if_post_liked`
  read `leads.enrichment` flags that **nothing ever writes**, so they are always
  false.
- **Condition timing:** a condition is evaluated **once**, when its delay has
  elapsed. With "wait 2 days → if connected", a prospect who accepts on day 3 is
  already on the "not connected" path.
- **Unused schema:** `ab_tests`, `ab_variants`, `jobs.ab_variant_id`,
  `templates` (+ `template_stats` view), `campaign_steps.template_id`, action enum
  values `enrich`, `fire_webhook`, `move_to_campaign`, `add_tag`.

## 3. Gaps and how to close them

### S1 (P0) — "Wait until X, up to N days" conditions (event-driven)
This is how every competitor models "if accepted": keep checking for a window,
move on the moment it becomes true, take the "no" branch only at the timeout.
**Build:**
1. Add `timeout_hours` to condition steps (reuse `params` JSON — no migration
   needed since the app role has no DDL rights; or add a column via an admin
   migration).
2. In `GraphExecutor.advance`: for a condition step, if the condition is already
   true → take `on_true` immediately; else if `now < entered + timeout` → park
   until `min(timeout, now + 6h)`; else → `on_false`.
3. **Wake on event:** when sync marks a lead accepted/replied (doc 03), set
   `next_run_at = now()` on that lead's enrollments whose current step is a
   condition, so the runner re-evaluates within a minute.
4. Builder UI: "If connected within [7] days → … otherwise → …".

### S2 (P0) — Only offer conditions that can fire
- `if_profile_visited`, `if_post_liked`: have the worker set
  `leads.enrichment.profile_visited_at` / `post_liked_at` when those actions
  succeed (they are our own actions — trivial).
- `if_email_opened`, `if_email_clicked`: need tracking (doc 06 §E7); hide them
  until tracking ships, and warn that open tracking hurts deliverability.
- `if_inmail_opened`: LinkedIn exposes no read receipts to automation reliably —
  remove.
- Add genuinely useful ones: `if_connected` (already), `if_replied`,
  `if_has_email`, `if_email_bounced`, `if_already_connected_before_campaign`,
  `if_accepted_but_no_reply`, `if_tag`, `if_company_size / title matches` (from
  enrichment).

### S3 (P0) — Expose the actions the engine already runs
Add to `NODE_ACTION` and the palette: **InMail** (requires Sales Navigator/Premium
on the sender), **Like latest post**, **Endorse skill**. Then add the enum actions
that need small executor handlers: **Add tag** (`add_tag`), **Move to campaign**
(`move_to_campaign`), **Fire webhook** (`fire_webhook` → doc 08), **Enrich email**
(`enrich` → doc 05), and a new **Manual task** step (creates a to-do for a human —
lemlist and Expandi both have it; good for "comment on their post").

### S4 (P1) — Real branching in the builder
The backend already stores a graph; replace the linear builder with a tree editor
where each condition has two sub-sequences. Keep `compile`/`decompile` as the only
translation layer and extend them to recurse. Validate on save: no cycles, every
path ends, at most one invite per path.

### S5 (P1) — Templates library
1. API: `POST/PATCH/DELETE /api/templates` (service exists, controller is
   GET-only — `modules/templates/*`).
2. Builder: "Save as template" / "Insert template" on message and email steps;
   persist `campaign_steps.template_id` so `template_stats` (used, accept %) fills
   in and the **Sequences** screen stops being permanently empty
   (`src/screens/Misc.tsx` `Sequences`).
3. Also save whole sequences as reusable **sequence templates** (Waalaxy/LGM ship
   pre-built ones — useful for onboarding).

### S6 (P1) — A/B testing
1. Step editor: up to 3 variants per message/invite/email step.
2. On materialise (`graph-executor.ts` `materialise`), pick a variant
   (uniform random, or weighted once one leads) and store `jobs.ab_variant_id`.
3. Stats per variant: sent, accepted (invites), replied; show a winner only after
   ≥100 sends per variant and a significant difference (two-proportion z-test);
   optional "auto-promote winner".
4. Tables `ab_tests` (`metric` accepted|replied, `min_sends` default 30, `status`
   running|won|stopped) and `ab_variants` (`label`, **`template_id NOT NULL`**)
   already exist (`migrations/0001_schema.sql` §7). Because every variant must
   point at a template, **S6 depends on S5** — ship templates first.

### S7 (P1) — Personalisation depth
- **Custom fields:** keep extra CSV columns in `leads.enrichment` and expose
  them as `{{custom.column_name}}`.
- **One variable engine:** Auto Connect (`jobs.service.ts fillTemplate`) and
  campaigns (`graph-executor.ts renderTemplate`) use different syntaxes today —
  unify on `{{var|fallback}}` and share one module.
- **Preview:** render each step for 5 real leads before launch; flag empty
  variables and over-length invites.
- **AI per step:** reuse `ai/connection-note.service.ts` for campaign
  invites/messages (today only Auto Connect jobs carry `useAi`).
- **P2:** image/GIF personalisation (integrate Hyperise rather than build),
  LinkedIn voice notes (LGM's differentiator), video (Sendspark).

### S8 (P1) — Campaign entry sources and evergreen campaigns
- Enrol from: a saved lead list/tag, CSV, a LinkedIn search URL, a Sales Navigator
  list (doc 05), and **signals** (P2: profile viewers, post engagers — the
  direction Expandi, Waalaxy and Valley are pushing).
- **Evergreen:** a campaign bound to a tag or list keeps enrolling new leads as
  they arrive (Dripify "Evergreen leads").

### S9 (P1) — Safety rules at campaign level (competitors' "duplication security")
- Skip leads already 1st-degree connected before the campaign (use an
  "if connected" pre-filter — HeyReach does this).
- Company-level de-duplication: at most N people per company per week across all
  campaigns (Expandi dedupes at company level).
- One invite per person across *all* campaigns (already enforced by the
  duplicate-invite guard).

### S10 (P2) — Social warming and multichannel extras
Like/comment before inviting (LGM "social warming", SalesRobot auto-comment) —
only with human-approved comment text; X/Twitter; WhatsApp; call tasks.

## 4. Acceptance tests to add
- Condition with timeout: accepted on day 3 of a 7-day window → true branch on
  day 3; never accepted → false branch at day 7.
- Variant assignment is sticky per enrollment and roughly uniform over 1,000 leads.
- `compile` → `decompile` round-trips a tree with two nested conditions.
- Builder rejects a graph with a cycle or two invites on one path.

## Sources
- Expandi builder (19 actions, 11 conditions), campaign types: https://expandi.io/lead-generation/ · https://expandi.io/blog/switch-to-expandi-migration-guide/
- Dripify A/B, step analytics, variables with fallback: https://dripify.com/
- La Growth Machine conditions, voice, social warming: https://lagrowthmachine.com/pricing/ · https://lagrowthmachine.com/features/
- lemlist multichannel/manual steps: https://www.lemlist.com/product/multichannel-prospecting
- Skylead smart sequences: https://scaliq.ai/linkedin-outreach-tools

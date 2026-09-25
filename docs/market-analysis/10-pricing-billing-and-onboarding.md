# 10 — Pricing model, billing, trials and onboarding

## 1. How the market prices (Sept 2026)

| Vendor | Billing unit | Entry price | Notes |
|---|---|---|---|
| Expandi | per LinkedIn account | $99 ($79 annual) | one plan, all features; agency quote from 10 accounts; promos down to $23–39/account at 25–50 accounts |
| HeyReach | per LinkedIn sender | $79 | teammates free; Agency ~$999/mo and Unlimited ~$2,999/mo flat |
| La Growth Machine | per identity | €60 / €120 | includes enrichment credits; 25 team members free on Pro |
| Dripify | per user | $59 / $79 / $99 | daily quotas by plan |
| Waalaxy | per user | €19 / €49 / €69 | invite quotas per month; inbox is an add-on |
| lemlist | per user | $79; LinkedIn from $109 | WhatsApp add-on |
| Skylead / SalesRobot | per seat | ~$100 / $59 | |
| Instantly / Smartlead | per subscription | $47 / $39 | unlimited mailboxes |
| AI SDR (Valley …) | per seat | $149–$395+ | |

Common patterns: **7–14 day free trial without a card**, annual ≈ 2 months free,
enrichment sold as credits (charged only when found), white-label and roles on
an agency tier.

## 2. Current state (verified)
- `plans` seeded with `pro` ($79, 1 LinkedIn account) and `agency` ($249, 5
  accounts, roles + white-label) — `migrations/0001_schema.sql` §billing.
- `BillingService.getSubscription` **auto-provisions `pro`** for every workspace
  (`modules/billing/billing.service.ts`); `subscriptions` has a status
  (`trialing` default) and period dates; `invoices` table exists. No payment
  provider, no webhook, no limit is enforced anywhere.
- Settings → Billing is static: "Pro — current plan", Upgrade → "coming soon"
  (`src/screens/Misc.tsx:750`, `:766`).
- Onboarding: Workspace → LinkedIn → 2FA → Gmail (now real OAuth + Skip) →
  Warm-up → Leads (Leads step still partly fake — doc 05 L2).
- Auth: signup without email verification; **password reset never sends an
  email** (earlier audit, bug 7); Google sign-in paused; no app 2FA although a
  `user_totp` secret kind exists.

## 3. Recommendations

### P1 — Pricing model
1. **Bill per connected LinkedIn account ("sender"), teammates free** — the model
   Expandi and HeyReach converged on, and the one reviewers call the right fit for
   a channel that scales by adding senders.
2. **Use the architecture's cost advantage.** Cloud competitors pay for a
   dedicated residential IP and a server-side browser per account. ReachPilot's
   execution runs on the customer's laptop, so marginal cost per sender is mostly
   database + Redis + AI tokens. That supports pricing **below Expandi** (e.g. a
   single-sender plan well under $79) while keeping margin — or the same price
   with more included (email sequencing, AI notes, enrichment credits).
3. Tiers: *Starter* (1 sender, core features) · *Growth* (per sender, rotation,
   CRM, API/webhooks, A/B) · *Agency* (bundles of 10/25/50 senders, client
   workspaces, white-label, master view). Add-ons: enrichment credits, optional
   always-on runner (doc 02 G9) priced to cover its dedicated IP.
4. Currency: INR pricing for India, USD elsewhere.

### P1 — Billing implementation
1. **Payment providers:** Stripe Billing (international cards, Checkout +
   Customer Portal) and Razorpay Subscriptions (India: UPI/cards, INR, GST
   invoices). One `PaymentProvider` interface; store `provider`,
   `provider_customer_id`, `provider_subscription_id`, `quantity` (senders) on
   `subscriptions` (admin migration).
2. **Webhooks** (`POST /api/billing/webhooks/:provider`, public, signature-checked,
   idempotent by event id): update status (`trialing/active/past_due/canceled`),
   periods, quantity; write `invoices`.
3. **Enforcement (soft, never destructive):**
   - connecting a LinkedIn account beyond `quantity` → prompt to add a seat;
   - `past_due` > 7 days or trial ended → **pause sending** (scheduler gate like the
     account-health gate), keep all data, show a banner;
   - feature flags from `plans.features` (API, white-label, rotation).
4. **Trial:** 7 or 14 days, no card, full features, capped at 1–2 senders;
   in-app countdown; reminder emails at T-3 and T-0.
5. Settings → Billing: real plan, seats, next invoice, invoices list, portal link.

### P0 — Onboarding that activates users
The desktop agent is the product's biggest activation hurdle (worker comment:
users who finish onboarding "before opening the desktop app" got stuck).
1. Add an explicit **"Install & open the desktop app"** step after LinkedIn:
   download buttons (Win/macOS), live status from the agent heartbeat
   (`agent:hb:<accountId>`), and the app's build version (already reported).
2. Replace the fake Leads step (doc 05 L2) with: upload CSV / paste LinkedIn
   search (runs when the app is online) / "skip".
3. Offer 2–3 **sequence templates** (connect → thank-you → follow-up) to launch a
   first campaign in the wizard; target: first invite sent within 24 h of signup.
4. Checklist on the dashboard until: account connected, app online, first
   campaign live, Gmail connected, first reply.

### P0 — Auth essentials
- **Password reset email** (bug 7): send the token link via the transactional
  mailer (`nodemailer` + SMTP settings already in `config/env.ts`), add a
  `/reset?token=` page, revoke all `user_sessions` on reset.
- **Email verification** on signup (`users.email_verified_at` exists) before
  LinkedIn connect.
- **Signup in one transaction** (user + workspace + membership) — a failure
  mid-way currently leaves an orphan user who can neither sign up nor log in.
- **P1:** Google sign-in; app 2FA (TOTP, the `user_totp` secret kind is ready);
  session list with "log out other devices".

## 4. Acceptance tests
- Stripe/Razorpay webhook replayed twice → one state change.
- Trial expired → scheduler holds all jobs with `last_error=billing_inactive`;
  paying releases them without data loss.
- Password reset: email contains a working link; old refresh tokens fail after
  reset.

## Sources
- Expandi pricing: https://expandi.io/pricing/ · https://emelia.io/hub/expandi-pricing · https://expandi.io/back-to-pipeline-2026/
- HeyReach pricing: https://www.heyreach.io/pricing
- La Growth Machine pricing: https://lagrowthmachine.com/pricing/
- Waalaxy pricing: https://www.waalaxy.com/pricing
- Dripify pricing: https://www.revenueflow.com/blog/dripify
- lemlist pricing: https://prospectingmanual.com/linkedin-automation/compare/la-growth-machine-vs-lemlist/
- Per-seat vs per-account: https://www.revenueflow.com/blog/dripify

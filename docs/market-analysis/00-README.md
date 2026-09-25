# Market analysis & gap plan — index

_Prepared September 2026 on branch `claude/gracious-lamport-42zrzz`. Each document
stands alone: what competitors do (with sources), what ReachPilot does today
(with file references), numbered gaps with priorities, and how to build each one._

## Reading order

| # | Document | Answers |
|---|---|---|
| 01 | [Competitor landscape](01-competitor-landscape.md) | Who the competitors are, how each is built, prices, full feature matrix vs ReachPilot, where the market is moving |
| 02 | [Account safety & detection](02-account-safety-and-detection.md) | How LinkedIn detects automation (published + observed), how each competitor responds, what ReachPilot already does well, what to add |
| 03 | [LinkedIn sync & unified inbox](03-linkedin-sync-and-unified-inbox.md) | **The #1 gap** — acceptance/reply detection does not run in production; design via the desktop agent; Unipile considered |
| 04 | [Campaign builder & sequences](04-campaign-builder-and-sequences.md) | Conditions that actually fire, missing actions, real branching, templates, A/B, personalisation |
| 05 | [Lead sourcing & enrichment](05-lead-sourcing-and-enrichment.md) | Import paths, legal limits on scraping, blacklist, lists, email finder/verification |
| 06 | [Email channel & deliverability](06-email-channel-and-deliverability.md) | Gmail/Yahoo/Microsoft rules, unsubscribe, bounces, threading, Outlook, rotation |
| 07 | [Multi-account, teams & agencies](07-multi-account-teams-and-agencies.md) | Sender choice, rotation, desktop-agent mapping, invitations/roles, agency mode |
| 08 | [Integrations, API, webhooks & AI](08-integrations-api-webhooks-and-ai.md) | Webhooks (dead today), public API, CRM, Zapier/Make/n8n, AI replies, MCP server |
| 09 | [Analytics & reporting](09-analytics-and-reporting.md) | Timezone-correct event log, funnels, step analytics, health view, reports |
| 10 | [Pricing, billing & onboarding](10-pricing-billing-and-onboarding.md) | Market price models, recommended model, Stripe/Razorpay, trial, activation, auth essentials |
| 11 | [Platform, security & compliance](11-platform-security-and-compliance.md) | RLS switch, job reliability, hardening, CI/ops, LinkedIn ToS, GDPR, CAN-SPAM, India DPDP |
| 12 | [Roadmap](12-roadmap.md) | Phased plan with sizes, dependencies and exit criteria |

## The ten findings that matter most

1. **LinkedIn acceptance/reply detection does not run in production.** The remote
   driver's sync is a no-op and the desktop agent has no sync action, so
   "if accepted → message" sequences, acceptance rates and the LinkedIn inbox all
   stay empty (03).
2. **ReachPilot's architecture is a real differentiator.** Its "browser on the
   customer's own laptop" model matches only Linked Helper. Cloud rivals hold the
   session on their servers, and independent tests found datacenter IPs at one of
   them (01, 02).
3. **Pacing is already market-grade** (warm-up, jitter, re-rolled gaps, working
   hours). What is missing is **governing acceptance rate and pending invites**,
   which are LinkedIn's own published restriction triggers (02 G1).
4. **Session durability risk:** browser profiles live in the OS temp folder and
   can be wiped, which forces re-logins (02 G3).
5. **Single-account assumptions everywhere** (`limit(1)`), while the market
   scales by adding senders and bills per sender (07, 10).
6. **Builder depth:** 5 actions vs Expandi's 19. 5 of 9 conditions never fire,
   and there are no templates, A/B tests or step analytics (04).
7. **Email compliance:** no unsubscribe, no bounce handling, and no sending
   windows. Gmail/Yahoo rules and CAN-SPAM/GDPR require the first two (06, 11).
8. **Integrations are placeholders:** webhooks never fire, HubSpot is "coming
   soon", and there is no public API documentation (08).
9. **No billing:** every workspace is silently put on "Pro" (10).
10. **Several screens are placeholders:** Settings → Blacklist, the Leads Tag
    button, the Billing tab, and parts of the onboarding lead step (05, 10).

## Method and caveats
- Competitor facts come from vendor pages, help centres and 2025–2026 reviews,
  cited per document. Vendor claims (e.g. "undetectable") are reported as claims.
- Code facts were verified against this branch; line numbers drift, so each
  reference also names the function.
- LinkedIn prohibits automation. These documents aim to keep customer accounts
  within the behaviour LinkedIn tolerates from careful humans, and they
  explicitly exclude limit-bypass tactics (02 §5).
- Legal points are orientation, not legal advice (11 §5).

# 12 — Roadmap: closing the gaps in order

IDs refer to the other documents (e.g. **03** = doc 03, **G2** = doc 02 gap G2).
Sizes: **S** ≤ 3 dev-days · **M** ≈ 1–2 dev-weeks · **L** ≈ 3+ dev-weeks.
The sequencing follows dependencies, not wish-lists: nothing that reads
"accepted" or "replied" can work before LinkedIn sync (doc 03) exists.

## Phase 0 — Done on this branch (`claude/gracious-lamport-42zrzz`)
Campaign pause stops sends · enrollment resume no longer stalls · follow-ups stop
after a reply · lead import survives duplicate emails · onboarding Gmail uses real
OAuth (no placeholder mailbox) · inbox LinkedIn replies only recorded when sent ·
tenant-scope fixes (Leads list leak, limits UPDATE without WHERE, scheduler
cross-tenant drain, Apify token leak) · campaign engine/API keys/notifications
RLS-safe · three stale test suites repaired. Full suite: 32/32 suites green.

## Phase 1 — Make the core loop real (≈ 3 weeks, 2 engineers)
Goal: *connect → if accepted → message → stop on reply* works end-to-end in
production, safely.

| # | Item | Doc | Size | Depends on |
|---|---|---|---|---|
| 1.1 | Desktop `sync_account` + `withdraw_invites`; remote driver dispatch; worker gating | 03 §6 steps 1–2, 8 | M | — |
| 1.2 | Profile-key matching; Auto Connect creates leads + `jobs.lead_id` | 03 §3.3, 05 L1 | M | — |
| 1.3 | Outbound messages written to threads; inbox shows history | 03 §3.4 | S | 1.1 |
| 1.4 | Browser profile out of temp dir; one-runner-per-account lease | 02 G3, G4 | S | desktop release |
| 1.5 | Rolling weekly invite window; fix slot leaks; email `release()` on failure | 02 G2, 11 §2 | S | — |
| 1.6 | "Wait until accepted, up to N days" conditions + wake on sync | 04 S1 | M | 1.1 |
| 1.7 | Builder: only conditions that fire; expose InMail/like/endorse | 04 S2, S3 | S | — |
| 1.8 | Unsubscribe (headers + page + reply stop), bounce handling | 06 E1, E2 | M | 05 L4 |
| 1.9 | Real blacklist (person/email/domain) enforced in 3 places | 05 L4 | S | — |
| 1.10 | Email sending windows in account timezone | 06 E3 | S | — |
| 1.11 | Stale-job reaper; `AUTH_BYPASS` default off; trust proxy; password reset email | 11 §2–3, 10 §3 | S | — |
| 1.12 | CI with Postgres/Redis + RLS-role job; fix root lockfile; oxlint on server | 11 §1, §4 | S | — |

**Exit criteria:** on a throwaway account, a 3-step campaign advances on a real
acceptance within one sync cycle; a reply cancels the queued follow-up; pending
invites older than 28 days are withdrawn ≤ 10/day; CI is green on every push.

## Phase 2 — Parity for teams (≈ 4 weeks)
| # | Item | Doc | Size |
|---|---|---|---|
| 2.1 | Sender picker everywhere; multiple accounts in Settings | 07 M1 | M |
| 2.2 | Agent ↔ account mapping, per-account heartbeat | 07 M3 | S |
| 2.3 | Team invitations, roles guard, viewer role | 07 M4 | M |
| 2.4 | Acceptance / pending-invite safety gate; account health score | 02 G1, G6 | M |
| 2.5 | Per-action daily limits | 02 G5 | S |
| 2.6 | Templates CRUD + template picker; unified variable engine + preview | 04 S5, S7 | M |
| 2.7 | Webhooks end-to-end (events, delivery worker, UI, SSRF guard) | 08 I1 | M |
| 2.8 | Slack notifications | 08 I5 | S |
| 2.9 | Event log + timezone-correct dashboards and funnels | 09 A1, A2 | M |
| 2.10 | Email threading, full reply bodies | 06 E4, E5 | S |
| 2.11 | Billing (Stripe + Razorpay), trial, soft enforcement; onboarding "install desktop app" step | 10 | L |
| 2.12 | Inbox: AI labels, assignment, snooze, SSE, priority manual replies | 03 §4, 08 I7 (classification) | M |

**Exit criteria:** a 5-person team with 5 senders can run separate campaigns,
reply from one inbox, and pay by card/UPI; webhook consumers receive signed events.

## Phase 3 — Scale and integrations (≈ 5 weeks)
| # | Item | Doc | Size |
|---|---|---|---|
| 3.1 | Sender rotation inside campaigns | 07 M2 | M |
| 3.2 | Multiple workspaces per user + switcher (removes login scan) | 07 M5 | M |
| 3.3 | Tree builder with real branches; validation | 04 S4 | L |
| 3.4 | A/B testing with significance | 04 S6 | M |
| 3.5 | Public API v1 + scopes + key UI; Zapier/Make/n8n | 08 I2, I3 | M |
| 3.6 | HubSpot native sync | 08 I4 | M |
| 3.7 | LinkedIn search / Sales Navigator import via agent; real onboarding lead step | 05 L2, L3 | M |
| 3.8 | Lists, bulk tag, delete/merge, custom fields | 05 L5 | S |
| 3.9 | Email finder waterfall + verification + credits | 05 L6 | M |
| 3.10 | Outlook/M365 + SMTP drivers; inbox rotation; DNS health checks | 06 E6, E8, E9 | L |
| 3.11 | Step analytics, account-health view, weekly reports | 09 A3–A5 | M |
| 3.12 | Switch production to the RLS-bound role; `REQUIRE_TENANT_ISOLATION=true` | 11 §1 | S |
| 3.13 | Observability + CI deploys + desktop code signing | 11 §3–4 | M |

## Phase 4 — Differentiate (next quarter)
- Signal-based sources (profile viewers, post engagers, events) + AI ICP scoring
  (05 L7, L8).
- AI reply copilot → narrow autopilot (08 I7).
- ReachPilot MCP server built from the Assistant's tools (08 I8).
- Agency mode: organizations, master view, white-label, client viewer (07 M6).
- Optional always-on runner with dedicated ISP/residential IP per account (02 G9).
- Voice notes / image personalisation via partners (04 S7, S10).
- Push to Instantly/Smartlead for volume email (08 I6).
- SOC 2 readiness (11 §5).

## Dependencies at a glance
```
03 sync ──┬─> 04 S1 wait-until conditions
          ├─> 02 G1 acceptance/pending gate ──> 02 G6 health score ──> 09 A4
          ├─> 09 A2 funnels (acceptance)
          └─> 03 §4 inbox (LinkedIn threads) ──> 08 I7 AI replies
05 L1 leads for every send ──> 05 L4 blacklist ──> 06 E1 unsubscribe
07 M1 sender picker ──> 07 M2 rotation
04 S5 templates ──> 04 S6 A/B (ab_variants.template_id is NOT NULL)
08 I1 webhooks + 09 A1 event log (share the outbox) ──> 08 I3/I4 integrations
11 §1 RLS test job ──> 11 §1 production role switch
```

## Metrics to track from Phase 1 onward
Restrictions/checkpoints per 100 accounts per week · acceptance rate · reply rate
· median time-to-accept · jobs stuck > 1 h · agent online hours per account per
day · trial → paid conversion · time from signup to first invite.

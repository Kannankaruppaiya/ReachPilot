# 06 — Email channel and deliverability

## 1. The rules every sender must meet (not optional since 2024–2025)

| Requirement | Gmail (Feb 2024) | Yahoo (Feb/Jun 2024) | Microsoft Outlook.com (5 May 2025) |
|---|---|---|---|
| SPF **and** DKIM for bulk senders | ✅ | ✅ | ✅ (>5,000/day) |
| DMARC published (min `p=none`), From: aligned | ✅ | ✅ | ✅ |
| One-click unsubscribe (RFC 8058 `List-Unsubscribe` + `List-Unsubscribe-Post`) + visible link | ✅ required for bulk marketing | ✅ required | recommended |
| Spam-complaint rate | < 0.10% target, never ≥ 0.30% | < 0.3% | not published |
| Honour opt-outs | within 2 days | within 2 days | — |
| TLS, valid forward/reverse DNS | ✅ | ✅ | ✅ |

The 5,000/day threshold is **per sending domain across all its mailboxes**, and
Yahoo publishes no threshold at all. Cold outreach at any real scale must be built
as if these apply.

## 2. How the market does email

- **Instantly / Smartlead** (the benchmark): unlimited mailboxes, free warm-up
  network (Instantly claims 4.2M accounts), **inbox rotation** (spread one
  campaign across many mailboxes), per-mailbox daily caps, automatic
  SPF/DKIM/DMARC + blacklist checks, Smartlead buys domains and configures DNS for
  you (SmartSenders), unified inbox with AI reply labels.
- **lemlist:** lemwarm (free), inbox rotation, deliverability hub.
- **La Growth Machine:** rotating inbox (5–10 senders per identity), Gmail /
  Outlook / SMTP connections.
- **LinkedIn-first tools** (Expandi, Dripify, HeyReach, Valley): email is "a step
  in the sequence" from the user's own mailbox, ~30–200/day; for volume they
  integrate Instantly/Smartlead rather than compete.

**Positioning advice:** ReachPilot should be the second kind — excellent
LinkedIn + *sequencer-grade* email from the customer's own Google/Microsoft
mailboxes — and integrate with Instantly/Smartlead for volume (doc 08), not try to
become a mailbox-fleet platform.

## 3. Current state (verified)

| Area | Status | Where |
|---|---|---|
| Sending | Gmail API only (OAuth refresh token in vault); `EMAIL_DRIVER=gmail`. No Microsoft 365 / Outlook / SMTP driver (`nodemailer` is a dependency but unused) | `drivers/gmail.driver.ts`, `drivers/drivers.module.ts` |
| MIME | Deliberately minimal (no `List-Unsubscribe`, no footer) to look like hand-sent Gmail | `gmail.driver.ts` `buildRawMessage` |
| Sender choice | Now: the most recent active mailbox *with credentials* (fixed with the onboarding bug) | `accounts/mailbox.ts` |
| Pacing | Per-mailbox `daily_limit` + ramp (5 + 5/day since connect). **No working hours, no timezone, no weekend rule** — emails can go out at 3 am | `engine/pacing.service.ts` email branch |
| Warm-up | Mailboxes *of the same workspace* email each other (needs ≥ 2), 08:00–21:00 server time, ramp 2 + age/2 up to 8/day; off by default (`EMAIL_WARMUP_ENABLED=false`) | `drivers/email-warmup.service.ts` |
| Reply detection | Polls Gmail every 3 min (`newer_than:2d -in:sent`, 25 messages); matches `leads.email`; stores Gmail's **snippet** only; now also cancels queued follow-ups | `integrations/gmail-inbox.service.ts` |
| Threading | Follow-ups and inbox replies start **new** threads (no `threadId`, `In-Reply-To`, `References`) | `gmail.driver.ts` |
| Unsubscribe / bounces | ❌ none | — |
| Open / click tracking | ❌ none (the two related campaign conditions are dead — doc 04 S2) | — |
| DNS checks | Columns `spf_status`, `dkim_status`, `dmarc_status` exist on `email_accounts` but **nothing computes them** | `migrations/0001_schema.sql` |

## 4. Gaps and how to close them

### E1 (P0) — Opt-out that works (legal + deliverability)
1. Signed, per-recipient unsubscribe token → public endpoint
   `GET/POST /api/u/:token` (no login): marks the lead `blacklisted`, adds the email
   to the `blacklist` table (doc 05 L4), cancels pending jobs, shows a plain
   confirmation page. `POST` must work without cookies (RFC 8058).
2. Add `List-Unsubscribe: <https://…/api/u/TOKEN>, <mailto:unsubscribe+TOKEN@…>`
   and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers.
3. Body opt-out: a **plain-text line** ("Not relevant? Reply 'stop' and I won't
   follow up.") is enough for 1:1 cold outreach and does not look like a
   newsletter; make the wording a workspace setting.
4. Reply-based opt-out: classify replies containing stop/unsubscribe/remove
   (AI labels — doc 03 §4) → same suppression path.
The earlier decision to strip `List-Unsubscribe` for inbox placement conflicts
with Gmail/Yahoo bulk rules and with GDPR/CAN-SPAM; ship headers + one-line body
text, then measure placement with seed tests (E9) rather than guessing.

### E2 (P0) — Bounce handling
Gmail delivers bounces as messages from `mailer-daemon@googlemail.com` with a
DSN part. In `GmailInboxService.syncAccount`, detect them (sender +
`Content-Type: multipart/report`), extract the failed recipient, mark the lead's
email invalid (`email_verified=false`, `enrichment.bounced_at`), cancel pending
email jobs for it, and count hard bounces per mailbox. **Auto-pause a mailbox**
whose 7-day hard-bounce rate exceeds 3%.

### E3 (P0) — Sending windows in the recipient's/sender's timezone
Give `email_accounts` the same `hours_start`, `hours_end`, `timezone`,
`send_weekends` fields as LinkedIn accounts (or a workspace default) and reuse
`PacingService`'s window logic for the email branch; apply a per-send spacing gap
(e.g. 2–6 min) so a mailbox never bursts. Replace the server-local
`setHours(9)` retry times with the account timezone.

### E4 (P0) — Thread follow-ups and replies
Store Gmail's `threadId` and the RFC `Message-ID` of every sent email on the job
(payload) and in `messages.external_id`. For step 2+ of a sequence to the same
lead, send with `threadId` + `In-Reply-To` + `References` and `Re: <original
subject>` — follow-ups then appear under the first email in the prospect's inbox
(how Gmail users actually follow up; better reply rates). Inbox replies should
reply in the *received* thread from the mailbox that received it.

### E5 (P1) — Full reply bodies and our own sent mail in the inbox
Fetch `format=full` for matched replies and store the decoded text part (strip
quoted history); write every outbound campaign email into the lead's thread as a
`me` message (doc 03 §3.4).

### E6 (P1) — Microsoft 365 / Outlook and SMTP senders
Many B2B customers use Microsoft 365. Add an `OutlookDriver` (Microsoft Graph
`sendMail` + delta queries for replies, OAuth via Entra ID app) and a generic
SMTP/IMAP driver (the unused `nodemailer` dependency) behind the existing
`EmailDriver` interface; choose the driver **per mailbox** (`email_accounts.provider`)
instead of per deployment (`EMAIL_DRIVER`).

### E7 (P2) — Optional open/click tracking
Tracking pixels and redirected links reduce inbox placement for cold email, and
Apple Mail Privacy Protection inflates opens. If added: per-workspace custom
tracking domain (CNAME), off by default, used only for the `if_email_opened` /
`if_email_clicked` conditions.

### E8 (P1) — Inbox rotation and multiple mailboxes per campaign
Let a campaign use N mailboxes; pick the mailbox with remaining daily capacity
for each new lead and **keep that mailbox for the rest of that lead's sequence**
(threading requires it). Mirrors LGM's rotating inbox and Smartlead's
per-sequence mailbox control. Depends on E3's per-mailbox limits.

### E9 (P1) — Deliverability health
- DNS check job: resolve SPF, DKIM (`google._domainkey` for Google; selectors for
  M365), DMARC for each mailbox domain; fill the existing `spf_status`,
  `dkim_status`, `dmarc_status` columns; show red/green on Integrations with fix
  instructions. The Sequences screen already tells users this check is missing.
- Seed/placement test: send one campaign template to a handful of seed inboxes
  (Gmail, Outlook, Yahoo) and report inbox vs spam before launch.
- Metrics per mailbox: sent, bounces, replies, unsubscribes; warn at
  0.1% complaints-equivalent signals.

### E10 (P2) — Warm-up: keep it small and honest
The in-workspace warm-up only works for customers with ≥ 2 mailboxes and only
exchanges mail between their own inboxes. Competitors run large shared
networks, which cost real money and (per operator reports) can also *hurt*
placement when the pool is low quality. Recommendation: keep the internal
warm-up as an optional ramp helper, and for serious volume **integrate** a
warm-up/cold-email provider (Instantly, Smartlead, lemwarm) via doc 08 instead of
building a network.

## 5. Acceptance tests
- Every outgoing campaign email carries `List-Unsubscribe` and
  `List-Unsubscribe-Post`; POST to the one-click URL without cookies suppresses the
  lead and cancels its pending email job.
- A mailer-daemon bounce marks the lead email invalid and cancels its next email
  step; a mailbox with 4% hard bounces is paused.
- Step 2 email is sent with the step-1 `threadId` and `In-Reply-To` header.
- No email job is released outside the mailbox's window in its timezone.

## Sources
- Gmail sender guidelines: https://support.google.com/mail/answer/81126
- Provider rule tracker (Gmail/Yahoo/Microsoft/Apple): https://egressif.io/resources/sender-requirements/provider-rule-tracker
- Microsoft enforcement summary: https://elasticemail.com/blog/new-email-authentication-requirements
- Instantly vs Smartlead: https://instantly.ai/blog/comparing-instantly-vs-smartlead/ · https://www.genflows.com/blog/smartlead-vs-instantly-2026 · https://mailbeast.ai/blog/instantly-vs-smartlead
- La Growth Machine rotating inbox: https://lagrowthmachine.com/pricing/

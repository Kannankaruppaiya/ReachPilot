# 03 — LinkedIn acceptance/reply sync and the unified inbox (the #1 gap)

## 1. Why this is first

Every competitor in doc 01 detects **accepted invitations** and **LinkedIn
replies**, because the core LinkedIn sequence is:

> invite → *if accepted* → thank-you message → wait → *if no reply* → follow-up
> → *on reply* → stop and hand to a human.

Without sync, that sequence cannot run. In ReachPilot today:
- `if_connected` / `if_replied` branches always take the "false" path for
  LinkedIn-only leads (`engine/condition-evaluator.ts` reads `leads.status`, which
  nothing moves to `accepted`/`replied` in production);
- the Connections page's accepted / replied counts and acceptance rate stay at 0;
- LinkedIn replies never reach the Inbox and never stop a sequence;
- pending invites are never withdrawn, so LinkedIn's "too many outstanding
  invitations" restriction (up to a month) becomes likely (doc 02 §1a).

## 2. Current state (verified)

| Piece | Status | Where |
|---|---|---|
| Driver-side sync | ✅ written: reads recent connections, unread messaging threads, and the sent-invitations page | `server-v2/src/modules/drivers/playwright-linkedin.driver.ts` (`syncAccount`, `withdrawStaleInvites`; pages `/mynetwork/invite-connect/connections/`, `/messaging/`, `/mynetwork/invitation-manager/sent/`) |
| Apply logic | ✅ written, idempotent; now also cancels queued follow-ups on reply (`stopSequencesOnReply`) | `drivers/linkedin-sync.service.ts` (`apply`) |
| Worker loop | ✅ `LINKEDIN_SYNC_TICK_MS` (default 45 min) | `worker.ts` §6 |
| **Remote mode (production)** | ❌ `RemoteAgentDriver.syncAccount` returns `{accepted:[], replies:[]}`; `withdrawStaleInvites` returns 0 | `drivers/remote-agent.driver.ts` (bottom of file) |
| **Desktop agent** | ❌ `runJob` only knows `login` + the 7 send actions | `desktop/main.js` `runJob` |
| Matching accepted invites | 🟡 only leads with `status='invited'` found by `linkedin_url ILIKE '%/in/<slug>%'` — Auto Connect sends never create or update a lead, so they can never be matched | `linkedin-sync.service.ts` `apply` |
| Inbox storage | ✅ `threads` (one per lead per channel) + `messages` (dedup on `external_id`) | `migrations/0001_schema.sql` §10 |
| Inbox UI | 🟡 lists threads, sends replies (fixed to record only confirmed sends); no assignment, labels, filters, history fetch | `src/screens/Inbox.tsx`, `modules/inbox/inbox.service.ts` |
| Real-time push | 🟡 SSE endpoint exists (`GET /api/events`, `notifications.controller.ts`) but the inbox does not use it | — |

## 3. Design: sync through the desktop agent (recommended)

The session and IP must stay on the user's machine (doc 02), so sync has to run
there too — exactly like sends.

### 3.1 Protocol
1. **Server → agent.** Make `RemoteAgentDriver.syncAccount(ctx)` and
   `withdrawStaleInvites(days, ctx)` call the existing `dispatch()` with actions
   `sync_account` / `withdraw_invites` (payload: `{ since, maxThreads,
   maxWithdraw }`). `pushAndWait` already returns immediately when the agent's
   heartbeat is missing, so offline laptops cost nothing.
2. **Agent.** Add two `case`s to `runJob` in `desktop/main.js` that call the
   bundled driver's `syncAccount(ctx)` / `withdrawStaleInvites(days, ctx)`.
   Rebuild and ship the desktop app (auto-update exists since 0.1.1 —
   `desktop/main.js` updater).
3. **Cadence.** Keep the worker loop, but gate each account on:
   agent online **and** inside the account's working hours **and** ≥ 45 min
   (± random 15 min) since the last sync **and** no action job running. Add one
   extra sync right after the agent comes back online (the `AgentController`
   wake-on-reconnect path) so a laptop that was closed overnight catches up first.
4. **Budget.** A sync loads 2–3 LinkedIn pages; count it as one action against
   the daily budget and respect the spacing gap (`pacing:linkedin:<acct>:nextallowed`).

### 3.2 Richer sync result (extend `LinkedInSyncResult`)
```ts
interface LinkedInSyncResult {
  checkpoint?: boolean;
  accepted: { profileUrl: string; name?: string; seenAt: string }[];
  replies: { profileUrl?: string; fromName?: string; text: string;
             externalId: string; threadUrl?: string; sentAt?: string }[];
  // NEW
  pendingCount?: number;          // from the sent-invitations page header
  pendingOldest?: { profileUrl: string; ageDays: number }[]; // for doc 02 G1
  threadHistory?: { externalId: string; direction: 'me' | 'them';
                    text: string; sentAt: string; threadUrl: string }[];
  error?: string;
}
```
`pendingCount` feeds the pending-invite safety gate (doc 02 G1).
`threadHistory` lets the inbox show the whole conversation, not only the
prospect's last line.

### 3.3 Matching that works for every send path
Match on the **profile key**, not only on `leads.status='invited'`:
1. Build the key with `profileKey()` / `profileKeyFromSlug()` (`jobs/profile-key.ts`)
   — the same identity the duplicate-invite guard uses, which already understands
   URN vs vanity slugs and `resolvedSlug`.
2. Look up the sent `connect_request` job(s) for that key in the workspace; if the
   job has `lead_id`, update that lead; if not (Auto Connect), **create the lead**
   from the job payload (name/company/role/target) and back-fill `jobs.lead_id`.
   Better still, make Auto Connect create leads up front (doc 05 §3) so every job
   has a `lead_id`.
3. Record `accepted_at` / `replied_at` on the lead (JSON `enrichment` or new
   columns) — needed for time-to-accept analytics (doc 09).

### 3.4 Write our own outbound messages into the thread
When the worker commits a sent `linkedin_message`/`inmail` (or `send_email`),
upsert the lead's thread and insert a `direction='me'` message with the rendered
text. Then the inbox shows the conversation in order and a reply has context.
(Today only inbound messages and manual inbox replies are stored.)

## 4. The unified inbox (feature parity)

| Feature | Competitors | Build in ReachPilot |
|---|---|---|
| All accounts' LinkedIn + email threads in one list | Expandi, HeyReach Unibox, LGM, lemlist | Add `account_id` (LinkedIn account or mailbox) on `threads`; filter by account / campaign / channel / label |
| Reply as the right sender | HeyReach ("reply on behalf of colleagues") | Already routed to the account that last reached the lead (inbox.service.ts `replyAccountFor`) — extend to email (reply from the mailbox that received the reply) |
| Labels / reply classification | Instantly & Smartlead AI labels (Interested, Not interested, OOO, Referral, Unsubscribe) | Classify each inbound message with Gemini (`modules/ai/ai.service.ts`); store `threads.label`; rules: *Not interested / Unsubscribe* → lead `blacklisted`; *OOO* → push the next step by the return date |
| Assignment, notes, snooze, read/unread | HeyReach, LGM, Smartlead Master Inbox | `threads.assignee_user_id`, `threads.snoozed_until`, `thread_notes` table |
| Real-time updates | all | Emit on the existing SSE stream (`NotificationsService.emitEvent`) when a message is stored; the Inbox screen subscribes |
| Send without blocking the browser tab | cloud tools reply instantly | Queue manual replies as **priority jobs** on the agent inbox (LPUSH to the front) and show "sending…" → "sent" via SSE. Today the HTTP request waits for the desktop agent (up to 2 min before pickup), which a proxy may time out |
| Voice notes, attachments | HeyReach, LGM | P2 — needs driver support |

## 5. Alternative considered: Unipile (buy instead of build)

Unipile offers hosted LinkedIn auth, messaging and invitation endpoints, and
**webhooks for new messages and accepted invitations** at €3–5 per connected
account per month (min €49/month).
- **For:** weeks of driver work avoided; real-time events; Sales Navigator and
  Recruiter inbox support.
- **Against:** it works by reverse engineering (Unipile's own FAQ). The
  session is held by Unipile and reaches LinkedIn from an IP you provide or they
  choose — which gives up ReachPilot's core safety claim ("your session and IP
  never leave your laptop"). It adds a sub-processor for customer data (doc 11).
- **Recommendation:** build sync on the desktop agent (this doc). Revisit
  Unipile only if a hosted, always-on tier is launched (doc 02 G9); it could power
  that tier's inbox.

## 6. Implementation plan

| Step | Files | Size |
|---|---|---|
| 1. `sync_account` + `withdraw_invites` in `RemoteAgentDriver` and `desktop/main.js runJob` | `drivers/remote-agent.driver.ts`, `desktop/main.js` | S |
| 2. Worker gating (online, working hours, spacing, jitter, wake-sync) | `drivers/linkedin-sync.service.ts`, `agent/agent.controller.ts` | S |
| 3. Profile-key matching + lead creation for Auto Connect | `linkedin-sync.service.ts`, `jobs/profile-key.ts` | M |
| 4. Extended result: `pendingCount`, `threadHistory`; driver parsing | `linkedin-driver.interface.ts`, `playwright-linkedin.driver.ts` | M (selectors must be validated on a throwaway account — CLAUDE.md) |
| 5. Outbound messages written to threads | `worker.ts` sent branch | S |
| 6. Inbox: account filter, labels (AI), assignment, snooze, SSE | `inbox/*`, `ai/*`, `src/screens/Inbox.tsx` | M |
| 7. Manual replies as priority agent jobs | `inbox.service.ts`, `agent.controller.ts` | S |
| 8. Ship desktop build; turn on `LINKEDIN_SYNC_ENABLED` + `LINKEDIN_WITHDRAW_ENABLED` in prod `.env` | `DEPLOYMENT.md` checklist | S |

### Acceptance tests
- `linkedin-sync.service` unit tests with a stub driver: an accepted profile
  given as a URN matches a job sent to the vanity URL (and vice versa); an Auto
  Connect target with no lead gets a lead with status `accepted`.
- Reply → queued follow-up canceled, enrollment `replied` (already covered by
  `test/reply-stops-sequence.spec.ts`).
- Remote driver: `syncAccount` returns immediately with no heartbeat; with a
  heartbeat it pushes `sync_account` to `agent:inbox:<acct>`.
- Worker never syncs an account outside its working hours.

## Sources
- Unipile pricing & webhooks: https://www.unipile.com/pricing-api/ · https://www.unipile.com/developer-real-time/ · https://developer.unipile.com/docs/connect-accounts
- HeyReach Unibox: https://help.heyreach.io/en/articles/9897768-multiple-linkedin-senders-on-one-campaign-sender-rotation
- Expandi global inbox: https://expandi.io/back-to-pipeline-2026/
- Instantly / Smartlead inbox labels: https://instantly.ai/blog/comparing-instantly-vs-smartlead/ · https://gigradar.io/blog/smartlead-vs-instantly
- LinkedIn pending-invitation restriction: https://www.linkedin.com/help/linkedin/answer/a551012

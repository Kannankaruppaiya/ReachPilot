# 07 — Multiple LinkedIn accounts, sender rotation, teams and agencies

## 1. Why it matters commercially

LinkedIn tolerates only tens of invitations per account per day. The market's
answer is **more senders, each doing less**:
- HeyReach built its business on it: "the only way to reach out to more leads on
  LinkedIn is to scale by assigning multiple LinkedIn accounts (senders) on one
  outreach sequence and auto-rotating through them" (help centre), priced per
  sender with **teammates free**.
- Expandi, Dripify, LGM all bill per LinkedIn account/identity and sell agency
  plans with client workspaces, roles and white-label.
- Reviewers point out that per-*user* pricing is a "structural mismatch" with a
  channel whose safe model is many accounts at low volume (RevenueFlow on Dripify).

ReachPilot's customers (agencies, sales teams) will ask for this immediately.

## 2. Current state (verified)

| Area | Status | Where |
|---|---|---|
| Schema | ✅ many `linkedin_accounts` / `email_accounts` per workspace; `owner_user_id` per account; `campaigns.linkedin_account_id` / `email_account_id` | `migrations/0001_schema.sql` |
| Auto Connect / Auto Mail sender | ❌ first account via unordered `limit(1)` | `jobs/jobs.service.ts` `createBatch` |
| Campaign sender | ❌ first account via unordered `limit(1)` (email now uses the sendable-mailbox helper) | `campaigns/campaigns.service.ts` `create` |
| Settings / onboarding | one account shown and edited | `linkedin-accounts.service.ts` `getForWorkspace`, `updateLimits` |
| Desktop agent | one login account (`GET /api/agent/account`), but `next-job` pops jobs for **every** account in the workspace and marks them **all** online | `agent/agent.controller.ts` |
| Team roles | enum `owner / admin / member`; only the agent endpoints check a role | `common/auth.guard.ts`, `agent.controller.ts` |
| Invitations | table exists (hashed token, expiry); **no API or UI** | `migrations/0001_schema.sql` `invitations` |
| Multiple workspaces per user | ❌ login picks the first membership found by scanning every workspace | `auth/auth.service.ts` `findMembership` |
| White-label | `workspaces.branding jsonb` exists (comment: "Agency plan"); unused | `migrations/0001_schema.sql` |

## 3. Gaps and how to close them

### M1 (P0) — Choose the sender explicitly everywhere
1. Auto Connect / Auto Mail: add a sender dropdown (default = the user's own
   account); `createBatch` receives `linkedinAccountId` / `emailAccountId` and
   validates it belongs to the workspace and is sendable.
2. Campaigns: sender(s) chosen in the builder (M2); `create` no longer guesses.
3. Settings → LinkedIn: list all accounts with status, health (doc 02 G6), limits
   per account; "Add account" starts the same connect + desktop-login flow.

### M2 (P1) — Sender rotation inside a campaign
1. New table `campaign_senders (campaign_id, linkedin_account_id, email_account_id,
   weight)`.
2. At enrollment, assign each lead **one** sender (sticky for the whole sequence —
   a message can only go to someone connected to *that* account; email threads
   must stay in one mailbox). Pick the sender with the most remaining weekly
   capacity; ties by fewest active enrollments.
3. `graph-executor.ts` `materialise` uses `enrollment.sender_account_id` instead
   of `campaigns.linkedin_account_id`.
4. Daily limits stay **per account and shared across campaigns** (already true —
   pacing keys by account).
5. When a sender is restricted/disconnected, reassign only its *not-yet-invited*
   leads to other senders; never move leads mid-conversation.

### M3 (P0) — Desktop agent ↔ account mapping (safety-critical)
Covered in doc 02 G4: agents declare which accounts they hold a session for;
`next-job` pops only those; a per-account runner lease prevents two machines
driving one account. Additionally:
- **One laptop, several accounts:** they share the machine's IP. LinkedIn sees
  several members on one network/device (Linked Helper sells per-instance proxies
  for this). Default: one account per desktop install; allow more only with an
  explicit warning, or a per-account proxy (Linked Helper model).
- Heartbeat per account (only the accounts the agent serves), so the scheduler's
  agent gate and wake-on-reconnect are accurate.

### M4 (P0) — Team invitations and roles
1. API: `POST /api/invitations` (admin+) → email with a one-time link;
   `POST /api/invitations/accept` (creates user if needed + membership);
   `GET/DELETE /api/members`.
2. Roles: owner (billing, delete workspace), admin (accounts, members, all
   campaigns), member (own accounts + campaigns, shared inbox), **viewer**
   (read-only — for agency clients). Add `viewer` to the enum via an admin
   migration.
3. A `RolesGuard` + `@Roles()` decorator on controllers (today any authenticated
   user, and any API key, can do everything except drive the agent).
4. Ownership: members see all leads/inbox but can only launch campaigns on
   accounts they own unless admin (Expandi's "reps see only their own campaigns").

### M5 (P1) — Multiple workspaces per user and a switcher
- Replace the scan in `findMembership` with a direct lookup that does not need a
  tenant context — either a `SECURITY DEFINER` SQL function
  `memberships_for_user(uuid)` (admin migration) or a small non-RLS
  `user_workspaces` table maintained alongside `memberships`. This also removes
  the O(workspaces) cost on every login and token refresh.
- `POST /api/auth/switch-workspace` re-issues tokens for another membership;
  header dropdown in the app.

### M6 (P2) — Agency mode
- **Client workspaces** under an agency "organization" (new `organizations`
  table + `workspaces.organization_id`); agency staff are members of the org and
  inherit access to its workspaces.
- **Master view:** cross-workspace dashboard (volumes, acceptance, replies,
  sender health) and a cross-workspace inbox (HeyReach "Master View", Expandi
  centralised dashboard).
- **Client role:** viewer access to their own workspace's reports and inbox.
- **White-label:** `workspaces.branding` → logo, colours, product name, custom
  domain (CNAME to the app; issue TLS via the hosting provider's domains API),
  branded emails. Gate behind the Agency plan (doc 10).
- **Per-client limits:** seat caps per client workspace (HeyReach "seat limits").

## 4. Acceptance tests
- `createBatch` with an account id from another workspace → 400.
- Rotation: 300 leads across 3 senders with equal capacity → ~100 each; every job
  of a given lead uses the same sender.
- An agent that declared account A never receives jobs for account B; a second
  agent for A gets no jobs while the first holds the lease.
- A `member` cannot delete another user's LinkedIn account; a `viewer` gets 403 on
  every write.

## Sources
- HeyReach sender rotation & agency model: https://help.heyreach.io/en/articles/9897768-multiple-linkedin-senders-on-one-campaign-sender-rotation · https://www.heyreach.io/for-agencies · https://www.heyreach.io/pricing
- Expandi workspaces/permissions/white-label: https://expandi.io/lead-generation/ · https://emelia.io/hub/expandi-pricing
- Linked Helper per-instance proxies: https://support.linkedhelper.com/hc/en-us/articles/23378382591250
- Per-seat vs per-account economics: https://www.revenueflow.com/blog/dripify

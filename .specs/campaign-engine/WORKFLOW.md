# ReachPilot — Campaigns: Complete Workflow & Functionality

This document captures the **entire Campaigns feature exactly as it is built today** — every
screen, every button, every backend step, every guard. It describes the *current* implementation
(not a wishlist). Legend: ✅ built & verified · ⚠️ built but has a dependency · ⬜ not built yet.

Scope: the **Campaigns** feature only. Auto Connect and Auto Mail are separate, untouched flows
that share the same send engine (pacing, drivers, scheduler, queues).

Key files:
- Frontend: `src/screens/Campaigns.tsx`, `src/screens/Leads.tsx`, `src/App.tsx`, `src/lib/api/index.ts`, `src/lib/utils/template.ts`
- Backend: `server-v2/src/modules/campaigns/*`, `server-v2/src/modules/engine/*`, `server-v2/src/worker.ts`
- DB: `server-v2/migrations/0001_schema.sql`, `0007_campaign_engine.sql`

---

## 0. The big picture

A campaign is a **named directed graph of steps** that leads are **enrolled** into. A background
**runner** walks each enrolled lead through the graph: it evaluates conditions inline, and for
each action step it drops a **durable job** into a **paced queue**. The **scheduler** dispatches
due jobs to the **worker**, which performs the real LinkedIn/email action via the **driver**, then
**advances** the lead to the next step. The design deliberately splits *decide-next-step* (runner
+ executor, cheap, DB-only) from *send-under-pacing* (scheduler + worker + driver, expensive,
opens a browser / calls Gmail). That split is what lets a multi-day sequence survive restarts,
respect safety limits, and never double-send.

```
Builder (UI)  ──compile──▶  campaign_steps (the graph)      +  entry_step_id
Leads         ──enroll───▶  enrollments (one cursor per lead: current_step_id, next_run_at)
Runner tick   ──────────▶  GraphExecutor.executeStep  ──▶  jobs (scheduled | queued)
Scheduler     ──drain────▶  BullMQ  ──▶  Worker  ──▶  Driver (real send)
Worker success ─────────▶  advanceEnrollment  ──▶  enrollment moves to the next step  ──▶ (runner picks it up)
```

Two background loops keep it moving (both worker timers): the **campaign runner** (~60 s, advances
enrollments) and the **scheduler** (~30 s, dispatches due jobs). Both are re-entrancy-guarded.

---

## 1. FRONTEND — every screen & control (exhaustive)

The Campaigns nav item renders one of three views held in `App.tsx` state
`campaignView: "list" | "builder" | "detail"`, plus `activeCampaign` (the row opened) and
`editData` (the full campaign being edited).

### 1.1 Campaign List  (`CampaignList`)
Loads once on mount via `api.getCampaigns()` → `GET /api/campaigns`, newest-first
(`campaigns.created_at DESC`).

- **Header** — "Campaigns" title + subtitle "Automated LinkedIn + email sequences." + **"New
  campaign"** button. Clicking it clears `editData` and switches to Builder (new). ✅
- **Loading** — a centered spinner while the request is in flight. ✅
- **Empty state** — icon + "No campaigns yet" + hint + a "New campaign" button. Shown when the list
  is empty (or the request failed → the catch sets `[]`). ✅
- **Table** (horizontally scrollable on small screens). Each row maps one campaign:
  - **Campaign** — a status **dot** (green when `status === "Active"`, amber otherwise) + the name
    (bold) + the status text underneath (Active / Paused / Draft / Archived). ✅
  - **Leads** — enrolled distinct-lead count, from the `campaign_stats` view. Hidden < md width. ✅
  - **Sent** — count of the campaign's `sent` jobs, from `campaign_stats`. Hidden < md. ✅
  - **Accepted %** — `campaign_stats.accepted_pct` (green, bold). ✅ *(value depends on sync — §6)*
  - **Replied %** — `campaign_stats.replied_pct`. Hidden < sm. ✅ *(depends on sync — §6)*
  - **Trend** — a 14-day "sent per day" sparkline (Recharts `LineChart`). Renders only if at least
    one day has a non-zero value, else "—". Hidden < lg. ✅
  - **Actions** — a single **Pause/Resume** icon button (Pause icon if Active, Play if not).
    `onClick` stops row-propagation and calls `togglePause`. ✅
- **Row click** → sets `activeCampaign` + opens Detail. ✅
- **`togglePause(c)`** — flips Active↔Paused **optimistically** (updates the row in local state
  first), calls `api.updateCampaign(id, {status})`, toasts "Campaign paused/active"; on error it
  **rolls the row back** to the previous status and toasts the error. ✅

### 1.2 Campaign Builder  (`CampaignBuilder`) — 4 steps
Props: `onDone` (return to list) and optional `edit` (`{id, name, dailyCap, nodes}`). When `edit`
is present the builder is in **edit mode** (`isEdit = true`): it starts on step 2 (Sequence),
pre-fills the name and nodes, and saves via PATCH instead of POST.

State: `step` (0–3), `name`, `leads` (all workspace leads via `api.getLeads({limit:500})`),
`selected` (a `Set` of lead ids), `q` (audience search), `nodes` (the editable sequence),
`account` (for the warm-up cap), `previewIdx`, `saving`.

**Header** — title "New campaign" / "Edit campaign", the working name (or "Name your campaign in
Review"), and a **step pill nav** (1. Audience · 2. Sequence · 3. Schedule · 4. Review). The pills
are buttons — you can jump to any step directly. A **Back** link (← previous step) shows on 2–4.

#### Step 1 — Audience  (new campaigns only)
- **Search box** — filters `leads` **client-side** by name / company / title (case-insensitive,
  substring). No server round-trip (all up-to-500 leads are already loaded). ✅
- **"Select all matching"** — selects every lead in the *current filtered view* (`filteredLeads`).
  Label reads "Select all matching" when a query is active, else "Select all". ✅
- **Counter** — "**N** selected · **M** shown". ✅
- **Lead list** — scrollable (max-height card); each row = a checkbox + avatar + name +
  "title · company · location". Clicking the row toggles selection (`toggleLead`). ✅
- **"Continue to sequence"** button — disabled until `selected.size ≥ 1`. ✅
- **Edit mode note** — instead of requiring a re-pick, step 1 shows: "You're editing this
  campaign's sequence & settings. Leads are added or removed from the campaign page. Saving a
  sequence change restarts enrolled leads from step 1." ✅

#### Step 2 — Sequence  (the heart)
An **editable, reorderable list of nodes** (`nodes`, seeded with a sensible default sequence for
new campaigns: view → invite → wait 2d → branch(if_connected, else message) → message). Each node
= a rail icon + connector line + a card. The card header carries three controls:
- **↑ Move up** (`moveNode(uid,-1)`) — disabled on the first node. ✅
- **↓ Move down** (`moveNode(uid,+1)`) — disabled on the last node. ✅
- **🗑 Remove** (`removeNode(uid)`). ✅

Node bodies (per-kind editors) — **full detail of each in §1.2.1 below.**

- **"Add step"** button → dropdown menu (Connection request, LinkedIn message, Email, Wait,
  Condition, View profile, Follow). Each `addNode(kind)` appends a node **seeded with defaults**:
  wait→`{days:2}`, branch→`{condition:'if_connected', elseAction:{kind:'message',body:''}}`,
  email→`{subject:'',body:''}`, others→`{body:''}`. Reorder afterward with ↑/↓. ✅
- **Live Preview** panel (sticky, right column):
  - Renders the **invite** node's message (`inviteBody`) against the currently-previewed selected
    lead, with variables resolved (`renderTemplate`). ✅
  - Lead **prev/next** nav (◀ **k/N** ▶) — cycles through the selected leads (wraps around). ✅
  - Footer: "**N** action step(s) · **M** lead(s). Sends are paced by your daily limit." where N =
    count of outbound nodes (invite/message/email/follow/view). ✅
- **Length guard** — `worst = longestRender(inviteBody, selectedLeads)` computes the **longest
  rendered invite** across *all* selected leads (so the worst-case recipient is caught, not just
  the previewed one). `over = worst.len > 300` disables launch and shows a red warning. ✅

#### Step 2.1 — Every step type in full detail

"**Channel**" = which queue/worker runs it · "**action_type**" = the enum stored in
`campaign_steps.action` · "**Driver**" = the method performing the real action.

---

**① Connection request** — send a LinkedIn invite  ✅
- **Menu label:** "Connection request" · **node kind:** `invite` (accent-highlighted, the primary step)
- **Editor:** message textarea + variable chips (`{{firstName}} {{company}} {{title}} {{location}}`,
  inserted at the cursor) + **"Longest render N/300"** counter (red + blocks launch if any lead's
  rendered note exceeds LinkedIn's 300-char invite-note limit) + hints (`{{firstName|there}}`
  fallback, `{Hi|Hey}` spintax).
- **action_type:** `connect_request` · **Channel:** LinkedIn (`linkedin-actions` queue)
- **Backend:** node.body → `params.body`; at run time the executor renders it (variables + spintax)
  into `payload.message`.
- **Driver / execution:** at SEND time the worker builds the note via `ConnectionNoteService.build`
  — if AI is enabled it writes a unique note per prospect (Apify profile-enrichment optional), else
  it uses the rendered template. Then `connectWithNoteFallback` → `sendConnectRequest`: opens the
  profile, finds **that target's own** Connect control (anchor OR button, name-scoped so it never
  grabs a "People also viewed" rail profile), opens the invite composer, types the note, sends. If
  the account's free-tier **personalized-note quota is spent**, it auto-retries **note-less** (the
  invite still goes out). Send is confirmed only by an "Invitation sent" toast or a Pending flip
  (never by the composer merely closing — that was a false-positive source).
- **Counts against:** daily warm-up limit **AND** the weekly invite cap (~100/wk).
- **Outcome:** sent → lead → `invited`; `already_connected`/`pending` → skip + advance;
  `limit_reached` → deferred to tomorrow (enrollment `waiting`); `checkpoint` → account paused +
  reconnect notice (enrollment `paused`); terminal fail (e.g. `profile_gone`) → job `failed`,
  enrollment `failed`.
- **Notes:** the only step that consumes an invite; put personalization here.

---

**② LinkedIn message** — DM a 1st-degree connection  ✅
- **Menu label:** "LinkedIn message" · **node kind:** `message`
- **Editor:** message textarea + variable chips (no 300 limit shown).
- **action_type:** `linkedin_message` · **Channel:** LinkedIn
- **Driver / execution:** `linkedinDriver.sendMessage(targetUrl, renderedBody, ctx)` — opens the
  messaging thread, types and sends.
- **Counts against:** daily limit only (NOT the weekly invite cap; `isInvite=false`).
- **Requires:** the lead must be a **1st-degree connection** (accepted). In a sequence this
  normally sits *after* a Connection request + an "If connected" condition — otherwise there is no
  message box for a non-connection.
- **Outcome:** sent → lead `last_activity = "Message sent"` + advance.

---

**③ Email** — send an email step  ✅
- **Menu label:** "Email" · **node kind:** `email`
- **Editor:** **Subject** input + message textarea (variable chips).
- **action_type:** `send_email` · **Channel:** Email (`email-send` queue)
- **Backend:** `params.subject` + `params.body`; the job carries the campaign's `email_account_id`.
- **Driver / execution:** email worker paces (email daily/warm-up limit) → `emailDriver.sendEmail(
  lead.email, subject, body, { emailAccountId })`. The Gmail driver sends via the Gmail API with
  formatting indistinguishable from a hand-composed Gmail message; spintax applies.
- **Requires:** a connected Gmail mailbox + `EMAIL_DRIVER=gmail`; the lead must have an **email
  address** (else the step fails for that lead).
- **Outcome:** sent → lead `invited` + `"Email sent"`; failed → a "job failed" notification + BullMQ
  retry with exponential backoff; enrollment → `failed`.

---

**④ Wait** — pause the sequence  ✅
- **Menu label:** "Wait" · **node kind:** `wait`
- **Editor:** number input "Wait **N** days".
- **action_type:** *(none — a wait is NOT its own row).* During compile the wait **folds its days
  into the `delay_hours` of the NEXT real step**. E.g. `invite → wait 2d → message` compiles to a
  `message` step with `delay_hours = 48`.
- **Execution:** the delay is honored two ways — an outbound step's job is scheduled `now + delay`;
  a condition step waits out the delay (measured from `step_entered_at`) *before* it evaluates
  ("if not accepted **in 2 days**").
- **Notes:** consecutive waits sum. A trailing wait with no following step has no effect.

---

**⑤ Condition** — branch on the prospect's behaviour  ⚠️
- **Menu label:** "Condition" · **node kind:** `branch`
- **Editor:** **"Continue only if"** select — *Connection accepted* (`if_connected`) / *Lead replied*
  (`if_replied`) / *Lead has an email* (`if_has_email`); **"Otherwise, send a fallback"** checkbox →
  fallback channel (Email / LinkedIn message) + Subject (if email) + fallback message textarea.
- **kind:** `condition` (no action_type; the `condition` enum holds the type). **Channel:** none.
- **Backend compile:** becomes a condition step; `on_true` → the next step in the main line;
  `on_false` → a one-shot fallback step built from the elseAction (or `null` → the lead finishes).
- **Execution:** the runner waits out any delay, then `ConditionEvaluator.evaluate` reads the lead:
  `if_connected` → `lead.status ∈ {accepted, replied}`; `if_replied` → `replied`; `if_has_email` →
  a non-empty email. It then advances to `on_true` (met) or `on_false` (not met) and continues —
  **no job is created for the condition itself.**
- **⚠️ Dependency:** `accepted`/`replied` are set **only** by the LinkedIn sync, which is currently
  **OFF**. So today `if_connected`/`if_replied` are effectively always false → the branch takes the
  **fallback (on_false)** path. `if_has_email` works now (local data). Enabling `LINKEDIN_SYNC_ENABLED`
  makes the connection/reply conditions real.

---

**⑥ View profile** — visit the prospect's profile  ✅
- **Menu label:** "View profile" · **node kind:** `view` · **Editor:** none.
- **action_type:** `visit_profile` · **Channel:** LinkedIn
- **Driver / execution:** `linkedinDriver.visitProfile(targetUrl, ctx)` — opens the profile,
  human-like scroll + dwell, closes. A **warm signal** (the prospect sees "so-and-so viewed your
  profile"), commonly the first step before a connection request.
- **Counts against:** daily limit only. Low risk.

---

**⑦ Follow** — follow without connecting  ✅
- **Menu label:** "Follow" · **node kind:** `follow` · **Editor:** none.
- **action_type:** `follow` · **Channel:** LinkedIn
- **Driver / execution:** `linkedinDriver.follow(targetUrl, ctx)` — opens the profile, clicks
  **Follow** (directly or via the "More" menu); if already Following it returns a skip and the lead
  advances.
- **Counts against:** daily limit only.

---

**Supported by the send engine but NOT in the Add-step menu today:** `inmail` (`sendInMail`),
`like_post` (`likeRecentPost`), `endorse_skill` (`endorseSkill`). The worker + drivers handle
these; they're just not offered as builder nodes yet. ⬜ (easy to add to the menu + `NODE_ACTION`).

#### Step 3 — Schedule
- **Daily send cap** — displays `account.warmup.todayLimit` (e.g. "20/day", ramping to the target),
  read-only. ✅
  - ⚠️ This displays the **account** warm-up limit. The **per-campaign** `daily_cap` is enforced
    separately in the backend (§3.10) but the builder currently sends `dailyCap = account cap` and
    shows the account number — a dedicated per-campaign input is not yet in the UI.
- **Working hours / weekends / timezone** — a note that these are enforced globally by the pacing
  engine (Settings → LinkedIn limits), so every campaign shares one safe schedule. ✅
- **"Review"** button → step 4.

#### Step 4 — Review
- **Campaign name** input (required to launch/save). ✅
- **Summary card** (divided rows): Audience (N leads), Sequence (N steps), Daily cap,
  Estimated duration (~`ceil(leads / cap)` days). ✅
- **Over-limit warning** — a red alert if any invite render > 300 chars (blocks launch). ✅
- **Buttons + flows:**
  - **New campaign:** **"Launch campaign"** → `launch(true)`; **"Save as draft"** → `launch(false)`.
    Both build `steps = nodes` (strip the internal `uid`) and call
    `api.createCampaign({name, dailyCap, steps, leadIds:[...selected], launch})`. Launch → status
    Active + enrollments active; draft → status Draft + enrollments paused. On success → toast +
    `onDone()`. ✅
  - **Edit mode:** **"Save changes"** → `saveEdit()` → `api.updateCampaign(edit.id, {name, dailyCap,
    steps})` (PATCH). ✅
- **Validation** (checked in `launch`/`saveEdit`, in order, each toasts + jumps to the offending
  step): name required (→ Review) · ≥1 lead selected (new only → Audience) · **≥1 action step**
  (→ Sequence) · no over-limit render (→ Sequence). ✅

### 1.3 Campaign Detail  (`CampaignDetail`)
Props: `campaign` (the list row), `onBack`, `onEdit`. On mount / when `campaign.id` changes it
loads the **full** record via `api.getCampaign(id)` → `GET /api/campaigns/:id` (steps + builderNodes
+ enrollments + stats + trend). State: `data`, `loading`, `busy` (status change), `deleting`,
`rowBusy` (per-enrollment), plus the add-leads modal state.

- **Back** link → List. ✅
- **Header:** name + status **Badge** + action buttons:
  - **Pause** (Active) / **Resume** (Paused) / **Launch** (Draft) → `setStatus()` →
    `api.updateCampaign(id, {status})` → reload. The label is "Launch" when the campaign is a
    Draft, else "Resume". ✅
  - **Edit** → `onEdit(data)` — hands the loaded `CampaignDetailData` up to `App`, which stores it
    as `editData` and opens the Builder in edit mode (pre-filled from `builderNodes`). Disabled
    until `data` has loaded. ✅
  - **Delete** → `remove()` → a `confirm()` dialog → `api.deleteCampaign(id)` → toast → `onBack()`.
    ✅
- **Loading / error** — spinner while loading; "Couldn't load this campaign." if it failed. ✅
- **Stat tiles** (2×2 / 1×4): **Leads · Sent · Accepted % · Replied %** from the record. ✅
- **Funnel card:** three horizontal bars — Sent (100%), Accepted (`acceptedPct`), Replied
  (`repliedPct`) — each showing the absolute value and %, min-width 8% so tiny bars stay visible;
  plus the 14-day trend sparkline underneath (only if any day is non-zero). ✅
- **Sequence card:** the ordered steps (backend walks entry → next/on_true chain). Each row = a
  number badge + a human label (`stepLabel`: "Send connection request", "If connected", …), an
  optional delay chip ("after 2d" / "after 6h"), and a "Conditional" badge for condition steps. ✅
- **Leads card:**
  - Header "**Leads · N**" + **"Add leads"** button → opens the add-leads modal. ✅
  - **Add-leads modal:** loads all leads (`getLeads({limit:500})`), a search box, and a checkbox
    list **excluding already-enrolled leads** (`enrolledIds` filter). Footer: "N selected" +
    Cancel / **Add** (`api.enrollLeads(id, [...addSel])` → toast → reload). ✅
  - **Per-lead row:** avatar + name + "title · company" + an **enrollment-status Badge** (tone map:
    finished/replied → success, active → accent, waiting → warn, paused/stopped → sub, failed →
    danger) + row actions (spinner while `rowBusy`):
    - **Pause / Resume** — hidden for terminal statuses (finished/stopped/failed); `enrollmentAction(
      eid, paused ? 'resume' : 'pause')` → `PATCH …/enrollments/:eid {action}` → reload. ✅
    - **Remove** — `enrollmentAction(eid,'remove')` → `DELETE …/enrollments/:eid` (cancels that
      lead's pending jobs + deletes the enrollment) → reload. ✅

### 1.4 Leads screen → "Add to campaign"
On the Leads page, select one or more leads → the selection toolbar's **"Add to campaign"** button
opens a **campaign-picker modal** (`api.getCampaigns()`), listing each campaign with its status +
lead count. Choosing one calls `api.enrollLeads(campaignId, selectedLeadIds)` →
`POST /api/campaigns/:id/enroll`, toasts the enrolled count, and clears the selection. Empty state:
"No campaigns yet — create one from the Campaigns page first." (File: `src/screens/Leads.tsx`.) ✅

---

## 2. API ENDPOINTS (campaigns)

| Method | Path | Body | Returns | Purpose |
|---|---|---|---|---|
| GET | `/api/campaigns` | — | `CampaignRow[]` | list (with per-campaign trend) |
| GET | `/api/campaigns/:id` | — | `CampaignDetailData` | detail: steps + `builderNodes` + enrollments + stats + trend |
| POST | `/api/campaigns` | `{name, dailyCap, steps[], leadIds[], launch}` | `CampaignRow` | create (+ compile steps, + enroll, + optional launch) |
| PATCH | `/api/campaigns/:id` | `{name?, dailyCap?, status?, steps?}` | `CampaignRow` | update name/cap/status and/or **rebuild sequence** |
| POST | `/api/campaigns/:id/launch` | — | `CampaignDetailData` | set Active + wake enrollments |
| POST | `/api/campaigns/:id/enroll` | `{leadIds[]}` | `{enrolled}` | enroll leads (active) |
| DELETE | `/api/campaigns/:id` | — | `{deleted}` | delete campaign (cascade) + cancel jobs |
| PATCH | `/api/campaigns/:id/enrollments/:eid` | `{action:'pause'\|'resume'}` | `{ok}` | pause/resume one lead |
| DELETE | `/api/campaigns/:id/enrollments/:eid` | — | `{removed}` | remove one lead + cancel its jobs |

All are workspace-scoped (JWT → `workspaceId`); every read/write runs under RLS via `withWorkspace`.

---

## 3. DATA MODEL (DB) — column-level

### `campaigns`
`id` · `workspace_id` · `name` · `status` (`campaign_status`: draft/active/paused/archived, default
draft) · `daily_cap` (smallint ≥1, default 15) · `linkedin_account_id` (FK, SET NULL) ·
`email_account_id` (FK, SET NULL) · **`entry_step_id`** (FK → campaign_steps, SET NULL — the first
step) · `created_by` · `created_at` · `updated_at`.

### `campaign_steps`
`id` · `campaign_id` (FK, CASCADE) · **`kind`** (`step_kind`: action | condition) · `action`
(`action_type`, for action steps) · `condition` (`condition_type`, for condition steps) ·
`template_id` (optional FK; the builder stores the message inline in `params` instead) · **`params`**
(jsonb — `{body, subject}`) · **`delay_hours`** (int ≥0 — the wait *before* this step) ·
**`next_step_id`** / **`on_true_step_id`** / **`on_false_step_id`** (self-FKs, SET NULL) ·
`position` (jsonb, unused by this UI). CHECK enforces action⇒action_type, condition⇒condition_type.
Index `steps_by_campaign`.

### `enrollments`
`id` · `workspace_id` · `campaign_id` (CASCADE) · `lead_id` (CASCADE) · **`current_step_id`** (FK,
SET NULL — the cursor) · **`status`** (`enrollment_status`: active/waiting/paused/replied/finished/
stopped/failed) · **`next_run_at`** (when the runner should next touch it) · **`step_entered_at`**
(when the current step was entered — condition-timeout math; added in `0007`) · `enrolled_at` ·
`finished_at` · **UNIQUE(campaign_id, lead_id)** (idempotent enroll). Partial index on `next_run_at`
where status ∈ (active, waiting).

### `jobs`
`id` · `workspace_id` · `batch_id` (Auto Connect/Mail) · **`campaign_id`** / **`enrollment_id`** /
**`step_id`** (SET NULL — the campaign linkage) · `lead_id` · `linkedin_account_id` /
`email_account_id` · `ab_variant_id` (unused) · `kind` (`channel`: linkedin | email) · `action`
(`action_type`) · **`payload`** (jsonb — rendered name/target/company/role/message/subject) ·
`status` (`job_status`: scheduled/queued/running/sent/failed/canceled) · `scheduled_for` · `sent_at`
· `attempts` · `last_error` · **`idempotency_key`** (UNIQUE — `enrollment:<e>:step:<s>` for campaign
jobs). Indexes: dispatch (status, scheduled_for), per-account, by-batch, by-lead.

### Views & unused
- **`campaign_stats`** (VIEW): `leads` = distinct enrolled; `sent` = count of `sent` jobs;
  `accepted_pct` / `replied_pct` = distinct leads accepted|replied ÷ sent (from lead status +
  jobs).
- **`ab_tests` / `ab_variants`** — exist, **currently unused** (A/B not built). `ab_variants` are
  template-based (`template_id NOT NULL`).

Enums referenced: `campaign_status`, `step_kind`, `action_type` (visit_profile, follow,
connect_request, linkedin_message, inmail, like_post, endorse_skill, send_email, wait, enrich,
fire_webhook, move_to_campaign, add_tag), `condition_type` (if_connected, if_replied,
if_email_opened, if_email_clicked, if_inmail_opened, if_profile_visited, if_post_liked,
if_followed_by_you, if_has_email), `enrollment_status`, `job_status`, `channel`.

---

## 4. BACKEND WORKFLOW (step by step, with guards)

Files: `campaigns.service.ts`, `campaigns.controller.ts`, `engine/graph-executor.ts`,
`engine/campaign-runner.service.ts`, `engine/condition-evaluator.ts`, `engine/scheduler.service.ts`,
`engine/pacing.service.ts`, `worker.ts`.

### 4.1 Create  (`CampaignsService.create`)
Trims + validates the name (400 if empty). In one `withWorkspace` transaction: insert the campaign
(status `active` if `launch` else `draft`; `daily_cap`; first LinkedIn + email account ids), then
**`persistSteps`** compiles + inserts the steps and sets `entry_step_id`, then logs an activity
row. After the transaction, if `leadIds` given and there's an entry step → **`enroll`** them
(`active` if launching, else `paused`). ✅

### 4.2 Compile  (`compile` → `persistSteps`)
`compile(nodes)` walks the linear node list into a `Compiled[]` with index-based links:
- a **`wait`** accumulates `pendingDelay += days*24` and emits no step. ✅
- a **`branch`** emits a condition step; if it has an `elseAction`, a one-shot fallback action step
  is appended and wired as `on_false`. ✅
- every other node emits an action step (`NODE_ACTION` map) with `params = {body, subject}` and the
  pending delay, then resets the delay. ✅
- After the walk, the **main line** is linked: each primary step's `next` (action) or `on_true`
  (condition) points at the following primary step; the first primary step is the **entry**. ✅

`persistSteps(db, campaignId, nodes)` (shared by create + edit): **deletes all existing steps**
(FKs SET NULL detach enrollments/entry safely), compiles, **inserts** each row (capturing ids),
then a second pass **wires `next/on_true/on_false`** by real id, and sets `campaigns.entry_step_id`.
Returns the entry id (or null for an empty sequence). ✅

### 4.3 Decompile  (`decompile`, for Edit / detail)
Inverse of compile. Walks `entry → (condition? on_true : next)`, and for each step: if
`delay_hours > 0` it emits a `wait` node (`days = round(hours/24)`) first, then the node itself; a
condition becomes a `branch` node whose `elseAction` is reconstructed from the `on_false` fallback
step. `on_false` fallback steps are tracked so they're **not** emitted twice. Returned as
`builderNodes` from `GET /api/campaigns/:id`. Round-trip (compile→decompile→compile) verified. ✅

### 4.4 Enroll  (`enroll`)
For each lead id, upsert an `enrollment` at `entry_step_id` with `status` (active|paused),
`step_entered_at = now`, `next_run_at = now` (active) or null (paused). **ON CONFLICT
(campaign_id, lead_id)** re-activates an existing row (so re-adding a lead is safe). Requires the
campaign to have an entry step (400 otherwise). ✅

### 4.5 Launch  (`launch`)
Requires an entry step (400 otherwise). Sets campaign `active`, then wakes any `paused`/`waiting`
enrollments (`status = active`, `next_run_at = now`) so the runner drives them on the next tick.
Returns the fresh detail. ✅

### 4.6 Runner  (`CampaignRunnerService.tick`, worker timer ~60 s)
Re-entrancy-guarded. Enumerates workspaces (not RLS'd); for each, finds up to 200 enrollments that
are **`active`**, OR **`waiting` with `next_run_at ≤ now` (or null)**, joined to a campaign whose
**status = `active`**, ordered by `next_run_at`. Calls `GraphExecutor.executeStep` for each
(errors are logged per-enrollment and don't stop the batch). Paused campaigns / paused enrollments
are skipped. ✅

### 4.7 Execute a step  (`GraphExecutor.executeStep`) — idempotent
Loads the enrollment; only proceeds if status ∈ {active, waiting}. No current step → **finish**.
Computes `dueAt = step_entered_at + delay_hours`.
- **Condition step:** if `now < dueAt` → **park** (`waiting`, `next_run_at = dueAt`) and return.
  Else evaluate via `ConditionEvaluator`, move to `on_true`/`on_false` (resetting `step_entered_at`),
  and **recurse** (so a chain of conditions/waits resolves in one tick). ⚠️ evaluator reads
  `lead.status` (§6).
- **Non-outbound action** (`wait`/enrich/tag/webhook): if `now < dueAt` park, else advance to
  `next_step_id` and recurse. (Waits normally never reach here — they fold into delays.) ✅
- **Outbound action:** first an **idempotency guard** — if a job already exists for this
  (enrollment, step): if it's `failed` → mark the enrollment `failed`; otherwise (still pending)
  return (don't double-create). Else render body/subject (variables + spintax), insert ONE job
  with `campaign_id/enrollment_id/step_id`, `idempotency_key = enrollment:<e>:step:<s>`,
  `scheduled_for = max(now, dueAt)`, status **`queued`** (due now → also pushed to BullMQ) or
  **`scheduled`** (future → the scheduler will dispatch it). Then **park** the enrollment
  (`waiting`, `next_run_at = scheduled_for`). ✅

Helpers: `moveTo(next)` sets `current_step_id`, `status=active`, `step_entered_at=now`,
`next_run_at=now` (or finishes if null); `park(runAt)` sets `waiting` + `next_run_at`; `finish()`
sets `finished` + `finished_at`. ✅

### 4.8 Dispatch  (`SchedulerService.tick`, worker timer ~30 s)
Re-entrancy-guarded; per workspace pulls up to 100 due `scheduled` jobs (`scheduled_for ≤ now`,
oldest first) and for each applies gates before enqueuing:
- **Suppression:** lead status ∈ {blacklisted, unqualified} → job `canceled`. ✅
- **Duplicate-invite guard:** a `connect_request` whose lead already has a `sent` connect_request →
  `canceled` (`duplicate_invite`) — never invite the same person twice. ✅
- **Account health:** LinkedIn account status ∈ {checkpoint, paused, disconnected} → hold (retry in
  1 h). ✅
- Otherwise **claim** the row (`status = queued`) and add to BullMQ (jobId dedupes;
  removeOnComplete/Fail so a re-add isn't silently swallowed). On a Redis error the claim rolls
  back to `scheduled` for the next tick. ✅

### 4.9 Send  (`worker.ts`)
- **LinkedIn worker** (`linkedin-actions`): pacing gate (§4.10) → dispatch by `action` to the
  driver (connect/message/inmail/follow/visit/like/endorse). Connect uses `connectWithNoteFallback`
  (note built at send-time). ✅
- **Email worker** (`email-send`): pacing gate → `emailDriver.sendEmail(...)`. ✅
- **Outcome classification** (LinkedIn): **sent** → job `sent` + lead update (`invited` for a
  connect) + `advanceEnrollment` + activity + stat bump; **skip** (already_connected/pending) →
  job `sent` + advance (no invite counted); **account-halt** (checkpoint → pause account +
  enrollment `paused`; limit_reached → reschedule job tomorrow + enrollment `waiting`);
  **terminal-fail** → job `failed` + enrollment `failed` + release the pacing slot. Each branch
  commits before any throw so BullMQ retries never double-send. ✅
- **`advanceEnrollment(db, enrollmentId, stepId)`:** looks up the step's `next_step_id`, sets the
  enrollment's `current_step_id = next` (or finished if null), `status = active`,
  `step_entered_at = now`, `next_run_at = now` — so the runner immediately picks up the next step. ✅

### 4.10 Pacing  (`PacingService.checkPacingAndRegister`) — gate order
For a send it checks, in order, and returns `{allowed, nextScheduledAt}`:
1. **Weekend** — if weekend and `!send_weekends` → defer to next opening. ✅
2. **Working hours** (account tz, wraps past midnight supported) — outside → defer to opening. ✅
3. **Inter-action spacing** — a per-account/day randomized **6–14 min** minimum gap between
   actions (checked before the daily counter so a spacing-defer doesn't burn a slot). ✅
4. **Daily warm-up cap** — `computeWarmup(...).todayLimit` jittered ±15% per account/day; over →
   rollback + defer to tomorrow. ✅
5. **Per-campaign daily cap** *(NEW)* — if the job has a `campaign_id`, a Redis counter
   `pacing:campaign:<id>:date:<day>:daily` is checked against `campaigns.daily_cap`; over → roll
   back the campaign counter **and** the account slot, defer to tomorrow. Auto Connect/Auto Mail
   jobs carry no `campaign_id`, so they skip this entirely. ✅
6. **Weekly invite cap** (invites only) — over → defer. ✅
`release(...)` gives back a consumed slot (account daily + weekly + **campaign** counter) when a
send fails after the counter was incremented, so a retry doesn't double-charge. ✅

### 4.11 Manage
- `update(id, {name?, dailyCap?, status?, steps?})`: applies name/cap/status (pause → parks
  active/waiting enrollments; resume → wakes paused ones). If **`steps`** is present →
  `persistSteps` rebuilds the sequence, **cancels the campaign's pending jobs**
  (`scheduled/queued/running → canceled`), and **restarts** every non-stopped enrollment at the new
  entry (`current_step_id = newEntry`, active if the campaign is active else paused,
  `step_entered_at/next_run_at` reset). ✅
- `remove(id)`: cancels pending jobs, deletes the campaign (cascade removes steps + enrollments),
  logs activity. ✅
- `setEnrollmentStatus(id, eid, pause|resume)`: pause → enrollment `paused` + cancel its
  scheduled/queued jobs; resume → `active` + `next_run_at = now`. ✅
- `removeEnrollment(id, eid)`: cancel its pending jobs, delete the enrollment. ✅

---

## 5. Enrollment lifecycle (state machine)

| From | Trigger | To | Effect |
|---|---|---|---|
| — | enroll / add leads | **active** (or paused for a draft) | cursor at entry step, `next_run_at=now` |
| active | runner: outbound step | **waiting** | one job created (queued/scheduled), `next_run_at = job time` |
| active | runner: condition/wait, delay not elapsed | **waiting** | `next_run_at = dueAt` |
| active | runner: condition met/not | active (branch target) | `current_step_id` = on_true/on_false, `step_entered_at=now` |
| waiting | worker: job **sent** | **active** (next) or **finished** | `advanceEnrollment` |
| active/waiting | pause (campaign or lead) | **paused** | pending jobs canceled (per-lead pause) |
| paused | resume / launch | **active** | `next_run_at=now` |
| waiting | limit_reached | **waiting** | job + enrollment rescheduled to tomorrow |
| running | checkpoint | **paused** | account paused + reconnect notice |
| — | job terminal fail | **failed** | job `failed` |
| active | no next step | **finished** | `finished_at=now` |

---

## 6. Current status & honest gaps

| Area | Status |
|---|---|
| Builder: audience, editable sequence, all node types, live preview, validation | ✅ |
| Edit existing campaign (decompile → builder → recompile, restart enrollments) | ✅ verified |
| Manage leads (add / pause / resume / remove), delete campaign | ✅ verified |
| Compile / runner / executor / scheduler / advance | ✅ verified end-to-end |
| All step actions (view/connect/message/email/follow) via real drivers | ✅ |
| Email step sends inside a campaign | ✅ |
| Per-campaign daily cap enforcement | ✅ (new) |
| **Conditions** (`if_connected` / `if_replied`) | ⚠️ built, but the accepted/replied signal comes **only** from LinkedIn sync (**OFF**) → conditions currently always take the fallback path. `if_has_email` works now. Enable `LINKEDIN_SYNC_ENABLED=true` (opens a browser on the account) to make them fire — code is ready. |
| **A/B note variants** (`ab_tests` / `ab_variants`) | ⬜ tables exist, not built — no variant UI, no runner assignment, no per-variant analytics |
| Stale-invite withdrawal in a campaign | ⬜ gated with sync (off) |
| Per-campaign cap **UI** (dedicated input on Schedule) | ⬜ backend enforces it; the builder still sends the account cap |
| `inmail` / `like_post` / `endorse_skill` as builder nodes | ⬜ engine supports them; not in the Add-step menu |

### Honest dependencies
1. **Conditions need LinkedIn sync.** Without it, `if_connected`/`if_replied` never become true, so
   any "Continue only if connected" branch always runs the fallback. A data-source dependency, not
   an engine bug.
2. **A/B is unbuilt** — the only remaining campaign *feature* gap.
3. **Reply detection:** email replies auto-pause via the Gmail inbox sync (on); LinkedIn replies
   need LinkedIn sync (off).
4. **Email steps** need a connected Gmail (`email_account_id`) + `EMAIL_DRIVER=gmail`; leads with no
   email will fail an email step.

---

*Prepared 2026-08-01 from the live codebase. Review and flag any corrections.*

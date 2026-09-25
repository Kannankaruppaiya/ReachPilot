# 11 — Platform reliability, security, and legal compliance

Competitors sell to agencies and mid-market teams that ask about SOC 2, DPAs and
data handling (lemlist advertises SOC 2 Type II; LGM a GDPR DPA). This doc lists
what ReachPilot needs underneath the features.

## 1. Tenant isolation (highest priority)

**State:** production connects as a role that bypasses RLS
(`docs/TENANT_ISOLATION.md`). The fixes on this branch make the code *safe to
switch*: tenant queries are scoped explicitly by `workspace_id` (commit
"fix(tenancy) …") and the campaign engine, API keys, notifications, webhooks and
billing run under `withWorkspace` (commit "fix(engine) …", proven by
`test/rls-campaign-engine.spec.ts` running as a NOBYPASSRLS role).

**Do next (P0):**
1. Run the full test suite as the RLS-bound probe role (add a CI job with
   `DATABASE_URL` pointing at `rp_rls_probe` — `test/rls-role.ts` creates it) so a
   new raw `getDb()` on a tenant table fails CI.
2. Create `reachpilot_app` in production exactly as `TENANT_ISOLATION.md`
   describes; switch the **worker first** on staging, then the API; then set
   `REQUIRE_TENANT_ISOLATION=true`.
3. Fix the boot check: `isolationVerdict` only looks at `rolbypassrls`
   (`src/db/tenant-isolation.ts`); a **superuser** also bypasses RLS and is
   currently reported as isolated (observed locally). Read `rolsuper` too.
4. Login/refresh still find memberships by probing every workspace
   (`auth.service.ts findMembership`) — replace with a `SECURITY DEFINER`
   function or a non-RLS `user_workspaces` table (doc 07 M5).

## 2. Job-pipeline reliability

| Issue | Fix | Pri |
|---|---|---|
| Rows can stay `queued`/`running` forever if Redis loses the BullMQ job or the worker dies mid-job (the scheduler only re-drives `scheduled`) | Reaper in the scheduler tick: `queued` older than 30 min or `running` older than 20 min with no BullMQ job → back to `scheduled` (for message/InMail: `failed` with `agent_result_pending_review`, same rule as the worker's non-idempotent case) | P0 |
| Scheduler claim is a plain update; `ticking` is an in-process flag, so two worker processes could claim the same row | `UPDATE … SET status='queued' WHERE id=? AND status='scheduled' RETURNING id` and a Postgres advisory lock per tick (`pg_try_advisory_lock`) | P1 |
| Pacing counters live only in Redis; a Redis flush forgets today's sends and can double a day's volume | On a missing daily key, seed it from `jobs` (`sent_at` today in the account timezone) before incrementing | P1 |
| Weekly cap key can lose its TTL (permanent cap) and leaks daily/campaign slots when it blocks | Rolling sorted-set window (doc 02 G2) | P0 |
| Email failures never release their pacing slot, so BullMQ retries burn quota | Call `pacing.release(email_account_id, 'email', …)` before throwing (earlier audit, bug 10) | P0 |
| Profile directory in the OS temp folder can be wiped → forced re-logins | Move to the app's userData dir (doc 02 G3) | P0 |

## 3. Security hardening

| Item | Where | Fix | Pri |
|---|---|---|---|
| `.env.example` ships `AUTH_BYPASS=true` | `server-v2/.env.example:39` | Default `false`; refuse to boot with `AUTH_BYPASS` when `NODE_ENV=production` | P0 |
| Password reset never emails; old sessions survive a reset | `auth/auth.service.ts` | doc 10 §3 | P0 |
| Rate limiter keys on `req.ip` without `trust proxy`; behind Vercel/proxy every user may share one bucket (20 logins/min globally) | `common/rate-limiter.guard.ts`, `main.ts` | `app.set('trust proxy', <hop count>)`; key auth limits by IP **and** email | P0 |
| Google OAuth `state` is a JWT signed with `JWT_SECRET`, so for 10 min it is also a valid Bearer token; not bound to the browser (OAuth CSRF) | `integrations/integrations.service.ts` | Separate secret + `typ:'oauth_state'` claim rejected by `AuthGuard`; bind to a short-lived HttpOnly nonce cookie | P1 |
| LinkedIn password + TOTP secret travel to the desktop agent inside a Redis list entry (TTL 900 s) | `drivers/remote-agent.driver.ts` login payload; `redis.expire(inbox, 900)` | Encrypt the payload to the agent (per-agent key pair registered at install), or have the agent fetch credentials over HTTPS with a one-time token; keep Redis on a private network with `requirepass`/TLS | P1 |
| Roles unenforced (any member / any API key can do everything except drive the agent) | controllers | `RolesGuard` (doc 07 M4), API scopes (doc 08 I2) | P1 |
| Webhook SSRF | `webhooks.service.ts` | doc 08 I1 §4 | P0 with webhooks |
| Desktop app trust | `desktop/` | Code-sign Windows builds (SmartScreen) and notarise macOS; keep electron-updater signature verification on; pin the API origin | P1 |
| Secrets | `modules/vault/*` | Envelope encryption is in place; add `MASTER_KEY` rotation (re-wrap DEKs) and an access audit review | P2 |

## 4. Operations

- **CI (P0):** GitHub Actions running typecheck, the frontend build, oxlint, and
  Jest with Postgres/Redis service containers (the suites already refuse
  non-local databases — `test/local-only.ts`). Fix the root `package-lock.json`
  (`npm ci` fails today) and replace the broken server `eslint` script (no config
  or dependency) with oxlint.
- **Deploys (P1):** production is rsync'd to two Oracle VMs (`DEPLOYMENT.md`);
  move to CI-driven deploys, with the desktop agent built and published by the
  same pipeline so the bundled driver can't lag the source (a known incident).
- **Observability (P1):** error tracking (Sentry) for API, worker and desktop;
  metrics for queue depth, jobs by status, sends/day, restriction rate, agent
  online count; alerts on "no sends in N hours while jobs are due", Redis/DB
  errors, and webhook failure spikes. Remove the per-poll "TEMP DIAG" log in
  `agent.controller.ts`.
- **Backups (P1):** confirm the Supabase plan's PITR window; Redis persistence
  (AOF) for BullMQ.

## 5. Legal and compliance

> Not legal advice — have counsel review before launch in each market.

1. **LinkedIn User Agreement.** It prohibits bots, automation tools, scraping and
   browser plug-ins that automate activity; LinkedIn restricts accounts and sues
   scrapers (doc 01 §3, doc 05 §2). Put this risk in the customer terms, require
   acknowledgement when connecting an account (doc 02 G10), and keep features on
   the "user automating their own account at human pace" side.
2. **Customer terms + acceptable-use policy:** no spam, lawful basis for every
   list, no purchased lists of personal emails, customer is the data controller.
3. **DPA + sub-processor list** (ReachPilot is a processor of prospect data):
   Supabase (DB), Redis host, Vercel, Oracle Cloud, Google (Gmail API, Gemini),
   Apify, and any enrichment provider (doc 05 L6).
4. **GDPR (EU/UK prospects):** legitimate-interest assessment template for
   customers; Art. 14 notice (tell prospects where their data came from — a line in
   the first message or a privacy link); opt-out honoured everywhere (doc 06 E1);
   erasure = delete the lead and keep a hashed suppression entry so they are not
   re-imported. Some countries (e.g. Germany) require prior consent even for B2B
   email — support per-country blocking.
5. **CAN-SPAM (US):** commercial email must carry a valid postal address and a
   working opt-out honoured within 10 business days; no deceptive From/Subject.
   Add a workspace "sender address" setting to the email footer.
6. **India DPDP Act 2023 + Rules 2025:** Rules notified 13–14 Nov 2025; consent
   manager rules from 13 Nov 2026; the operative notice/consent/security/breach
   rules from **13 May 2027**. Prepare: privacy notice, grievance contact, breach
   notification (72-hour detailed report to the Board), retention/erasure policy,
   processor contracts with customers. The Act does not apply to personal data the
   person made publicly available themselves — confirm with counsel how that
   applies to profile data.
7. **Email platform rules:** Gmail/Yahoo/Microsoft bulk-sender requirements (doc 06 §1).
8. **SOC 2 (P2):** start the control set (access reviews, change management,
   logging, vendor management) once agency deals ask for it.

## Sources
- DPDP Rules: https://static.pib.gov.in/WriteReadData/specificdocs/documents/2025/nov/doc20251117695301.pdf · https://lexcounsel.in/newsletters/regulatory-update-notification-of-the-digital-personal-data-protection-rules-2025/ · https://assets.kpmg.com/content/dam/kpmgsites/in/pdf/2025/11/dpdp-rules-2025-guidance-to-dpdp-act-implementation.pdf
- LinkedIn prohibited automation: https://www.linkedin.com/help/linkedin/answer/a551012 · https://www.revenueflow.com/blog/dripify (quotes User Agreement effective 3 Nov 2025)
- Email sender rules: https://support.google.com/mail/answer/81126 · https://egressif.io/resources/sender-requirements/provider-rule-tracker
- lemlist SOC 2 / LGM DPA: https://prospectingmanual.com/linkedin-automation/compare/la-growth-machine-vs-lemlist/

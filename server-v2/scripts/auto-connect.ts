/**
 * auto-connect.ts — operator-facing LinkedIn connection-automation runner.
 *
 * The worker + scheduler already drive `connect_request` jobs for live
 * campaigns, but there was no way to run a safe, self-pacing batch of real
 * connection requests on demand (e.g. "send today's invites for account X now",
 * or smoke-test the connect flow end-to-end against the simulator). This script
 * is that runner. It reuses the SAME production building blocks the worker does
 * — the DI container, the selected LinkedIn driver, LinkedInSessionService
 * (cookie + proxy + fingerprint), PacingService (warm-up ramp, daily/weekly
 * caps, working hours, inter-action spacing), and the shared outcome
 * classification — so its behaviour is identical to a real campaign send, just
 * triggered by hand.
 *
 * ── Safety model ────────────────────────────────────────────────────────────
 *  - DRY RUN by default. It only performs REAL LinkedIn actions when the driver
 *    is `playwright` AND you pass --live. Without --live a playwright driver is
 *    refused, so you can never contact LinkedIn by accident.
 *  - Pacing is honoured exactly as in production. If an account has hit its cap
 *    or the inter-action gap hasn't elapsed, the runner waits (up to --max-wait)
 *    or stops cleanly, mirroring the worker's defer-to-scheduler behaviour. The
 *    pacing slot is released on any non-send outcome so quota isn't burned.
 *  - checkpoint / limit_reached pause the whole account and stop the run,
 *    exactly like the worker's haltAccount path — never push through a challenge.
 *  - RLS: linkedin_accounts / leads / daily_stats / activity are FORCE-RLS, so
 *    every tenant read/write is wrapped in withWorkspace(). Plain getDb() reads
 *    of those tables silently return 0 rows.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # Dry run (simulator) — pick a sendable account, send up to 10 invites to
 *   # this workspace's `new` leads, mirror all pacing/state writes:
 *   npm run connect
 *
 *   # Target a specific account by email, cap the batch, custom note:
 *   npx ts-node -r tsconfig-paths/register scripts/auto-connect.ts \
 *     --email you@gmail.com --limit 25 --note "Hi {{firstName}}, loved your work at {{company}}."
 *
 *   # Fast dispatch smoke-test (skip pacing waits) — DRY RUN only:
 *   npx ts-node -r tsconfig-paths/register scripts/auto-connect.ts --no-pace --limit 5
 *
 *   # One-off connect to a single profile, no DB lead needed (dry run):
 *   npx ts-node -r tsconfig-paths/register scripts/auto-connect.ts --url https://www.linkedin.com/in/someone
 *
 *   # REAL sends (requires LINKEDIN_DRIVER=playwright + a logged-in account):
 *   LINKEDIN_DRIVER=playwright npx ts-node -r tsconfig-paths/register scripts/auto-connect.ts --live --limit 15
 *
 * Flags:
 *   --account <uuid>   Act as this linkedin_accounts.id.
 *   --email <addr>     Act as the account with this email (alternative to --account).
 *   --workspace <uuid> Restrict lead selection to this workspace (default: the account's).
 *   --limit <n>        Max connection requests this run (default 10).
 *   --url <profileUrl> One-off connect to a profile; skips DB lead selection. Repeatable,
 *                      or comma-separated (e.g. --url a,b), so you can test a handful of URLs.
 *   --note "<tpl>"     Personalized note template ({{firstName}}, {{company}}, …). Empty = no note.
 *   --no-note          Send connection requests without a note.
 *   --live             Allow REAL sends when the driver is `playwright`. Required for real contact.
 *   --no-pace          Bypass pacing (DRY RUN only) for a quick dispatch/classification check.
 *   --max-wait <min>   How long to wait on a pacing defer before stopping (default 20).
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { getEnv } from '../src/config/env';
import { LINKEDIN_DRIVER } from '../src/modules/drivers/driver.tokens';
import {
  LinkedInDriver,
  LinkedInActionResult,
  SKIP_OUTCOMES,
  ACCOUNT_HALT_OUTCOMES,
  TERMINAL_FAIL_OUTCOMES,
} from '../src/modules/drivers/linkedin-driver.interface';
import { LinkedInSessionService } from '../src/modules/drivers/linkedin-session.service';
import { PacingService } from '../src/modules/engine/pacing.service';

/* ---------------- tiny CLI arg parser ---------------- */

type Args = {
  account?: string;
  email?: string;
  workspace?: string;
  limit: number;
  urls: string[];
  note?: string;
  noNote: boolean;
  live: boolean;
  noPace: boolean;
  maxWaitMin: number;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { limit: 10, urls: [], noNote: false, live: false, noPace: false, maxWaitMin: 20 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => argv[++i];
    switch (k) {
      case '--account': a.account = val(); break;
      case '--email': a.email = val(); break;
      case '--workspace': a.workspace = val(); break;
      case '--limit': a.limit = Math.max(1, parseInt(val(), 10) || 10); break;
      case '--url': // repeatable; also accepts a comma-separated list
        a.urls.push(...val().split(',').map((s) => s.trim()).filter(Boolean));
        break;
      case '--note': a.note = val(); break;
      case '--no-note': a.noNote = true; break;
      case '--live': a.live = true; break;
      case '--no-pace': a.noPace = true; break;
      case '--max-wait': a.maxWaitMin = Math.max(0, parseInt(val(), 10) || 20); break;
      default:
        if (k.startsWith('--')) console.warn(`(ignoring unknown flag ${k})`);
    }
  }
  return a;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const _nowIso = () => new Date().toISOString();
const localDate = () => new Date().toLocaleDateString('en-US');
const short = (id?: string | null) => (id ? id.slice(0, 8) : '-');

/** Same placeholder syntax the campaign engine uses (graph-executor.renderTemplate). */
function renderNote(tpl: string, lead: { first_name?: string; full_name?: string; company?: string; title?: string; location?: string }): string {
  const map: Record<string, string> = {
    firstName: lead.first_name || '',
    lastName: (lead.full_name || '').split(' ').slice(1).join(' '),
    fullName: lead.full_name || '',
    company: lead.company || '',
    title: lead.title || '',
    location: lead.location || '',
  };
  return tpl.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key, fb) => map[key] || fb || '');
}

const DEFAULT_NOTE = 'Hi {{firstName|there}}, I came across your profile and would love to connect.';

/* ---------------- lead selection ---------------- */

/** Statuses that make a lead a valid connect target — mirrors the scheduler's
 *  suppression gate (blacklisted/unqualified are never contacted) and avoids
 *  re-inviting anyone already in-flight (invited/accepted/replied). */
const CONNECTABLE_STATUS = 'new';

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  const driver = app.get<LinkedInDriver>(LINKEDIN_DRIVER);
  const sessions = app.get(LinkedInSessionService);
  const pacing = app.get(PacingService);
  const db = getDb();

  const isRealDriver = env.LINKEDIN_DRIVER === 'playwright';
  const live = args.live && isRealDriver;

  // Guard 1: never contact LinkedIn for real without an explicit --live.
  if (isRealDriver && !args.live) {
    console.error(
      '\n✋ LINKEDIN_DRIVER=playwright (real automation) but --live was not passed.\n' +
        '   Re-run with --live to send real connection requests, or set\n' +
        '   LINKEDIN_DRIVER=simulator for a dry run.\n',
    );
    await app.close();
    process.exit(2);
  }
  // Guard 2: --no-pace strips the safety envelope, so only allow it in dry runs.
  if (args.noPace && live) {
    console.error('\n✋ --no-pace cannot be combined with --live (it disables the pacing safety envelope).\n');
    await app.close();
    process.exit(2);
  }

  const mode = live ? 'LIVE — REAL LinkedIn sends' : `DRY RUN — ${env.LINKEDIN_DRIVER} driver (no real contact)`;
  console.log('\n╭──────────────────────────────────────────────╮');
  console.log(`│  ReachPilot auto-connect runner`);
  console.log(`│  Mode:    ${mode}`);
  console.log(`│  Pacing:  ${args.noPace ? 'DISABLED (--no-pace)' : 'enabled (caps · hours · spacing)'}`);
  console.log(`│  Limit:   ${args.limit} connection request(s)`);
  console.log('╰──────────────────────────────────────────────╯\n');

  if (live && !env.PROXY_SERVER) {
    console.warn(
      '⚠️  --live with no PROXY_SERVER — every request egresses from THIS machine\'s IP.\n' +
        '   Fine for one throwaway test account; risky for real accounts.\n',
    );
  }

  /* ---- resolve the account to act as (RLS: scan workspaces) ---- */

  type Acct = { id: string; workspace_id: string; email: string; status: string; session_secret_id: string | null };
  const workspaces = await db.selectFrom('workspaces').select(['id']).execute();
  let account: Acct | undefined;

  for (const ws of workspaces) {
    const rows = (await withWorkspace(ws.id, (d: any) =>
      d
        .selectFrom('linkedin_accounts')
        .select(['id', 'workspace_id', 'email', 'status', 'session_secret_id'])
        .execute(),
    ).catch(() => [])) as Acct[];
    for (const r of rows) {
      if (args.account && r.id !== args.account) continue;
      if (args.email && r.email?.toLowerCase() !== args.email.toLowerCase()) continue;
      // Auto-pick: prefer a sendable account (logged-in, not flagged).
      const sendable = !!r.session_secret_id && !['checkpoint', 'paused', 'disconnected'].includes(r.status);
      if (!args.account && !args.email && !sendable) continue;
      account = r;
      break;
    }
    if (account) break;
  }

  if (!account) {
    console.error(
      '❌ No matching LinkedIn account found.\n' +
        '   Pick one with --account <id> or --email <addr>, or connect an account first.\n' +
        '   (List accounts:  npx ts-node -r tsconfig-paths/register scripts/check-accounts.ts)\n',
    );
    await app.close();
    process.exit(1);
  }

  const workspaceId = args.workspace || account.workspace_id;
  console.log(
    `Account:   ${account.email}  [${short(account.id)}] status=${account.status} ` +
      `session=${account.session_secret_id ? 'yes' : 'NO'}`,
  );
  console.log(`Workspace: ${short(workspaceId)}\n`);

  if (!account.session_secret_id && live) {
    console.error('❌ Selected account has no stored session cookie — it is not logged in. Connect it first.\n');
    await app.close();
    process.exit(1);
  }

  /* ---- build the target list ---- */

  type Target = {
    leadId: string | null;
    name: string;
    url: string;
    first_name?: string;
    full_name?: string;
    company?: string;
    title?: string;
    location?: string;
  };
  let targets: Target[] = [];

  if (args.urls.length) {
    // One-off: ad-hoc profiles, no lead rows (no lead-state writes). Derive a
    // readable name from the /in/<slug> segment when possible.
    const nameFromUrl = (u: string) => {
      const m = u.match(/\/in\/([^/?#]+)/i);
      if (!m) return u;
      return m[1].replace(/-[0-9a-f]{6,}$/i, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    };
    targets = args.urls.map((u) => ({ leadId: null, name: nameFromUrl(u), url: u }));
  } else {
    const leads = (await withWorkspace(workspaceId, (d: any) =>
      d
        .selectFrom('leads')
        .select(['id', 'first_name', 'full_name', 'company', 'title', 'location', 'linkedin_url', 'status'])
        .where('status', '=', CONNECTABLE_STATUS)
        .where('linkedin_url', 'is not', null)
        .orderBy('created_at', 'asc')
        .limit(args.limit)
        .execute(),
    ).catch((e: any) => {
      console.error('❌ Lead query failed:', e.message);
      return [];
    })) as any[];
    targets = leads
      .filter((l) => (l.linkedin_url || '').includes('linkedin.com/in/'))
      .map((l) => ({
        leadId: l.id,
        name: l.full_name || l.first_name || l.linkedin_url,
        url: l.linkedin_url,
        first_name: l.first_name,
        full_name: l.full_name,
        company: l.company,
        title: l.title,
        location: l.location,
      }));
  }

  if (targets.length === 0) {
    console.log('Nothing to do: no connectable leads (status=new with a LinkedIn URL) in this workspace.\n');
    await app.close();
    process.exit(0);
  }

  console.log(`Targets:   ${targets.length} profile(s)\n${'─'.repeat(50)}\n`);

  /* ---- send loop: pacing-gated, outcome-classified, state-syncing ---- */

  const noteTpl = args.noNote ? '' : args.note ?? DEFAULT_NOTE;
  const tally: Record<string, number> = {};
  const maxWaitMs = args.maxWaitMin * 60_000;
  let sent = 0;
  let stopped = false;

  for (let i = 0; i < targets.length && !stopped; i++) {
    const t = targets[i];
    const label = `[${i + 1}/${targets.length}] ${t.name}`;

    /* Pacing gate — the real safety envelope. On defer, wait until the slot is
       ready (bounded by --max-wait) then retry the SAME target; a far-future cap
       (daily/weekly/working-hours) stops the run cleanly. Mirrors the worker. */
    if (!args.noPace) {
      let waited = 0;
      for (;;) {
        const pace = await pacing.checkPacingAndRegister(account.id, 'linkedin', workspaceId, /* isInvite */ true);
        if (pace.allowed) break;
        const waitMs = pace.nextScheduledAt
          ? Math.max(0, new Date(pace.nextScheduledAt).getTime() - Date.now())
          : maxWaitMs + 1;
        if (waitMs > maxWaitMs - waited) {
          console.log(
            `\n⏸  Pacing cap reached (next slot ~${pace.nextScheduledAt || 'unknown'}). ` +
              `Beyond --max-wait ${args.maxWaitMin}m — stopping. ${targets.length - i} target(s) remain.\n`,
          );
          stopped = true;
          break;
        }
        const mins = Math.ceil(waitMs / 60000);
        console.log(`   ⏳ ${label}: pacing defer — waiting ~${mins}m for the next slot…`);
        await sleep(waitMs + 500);
        waited += waitMs;
      }
      if (stopped) break;
    }

    /* Build the per-account session (cookie + proxy + fingerprint). Null means
       the account is not sendable (checkpoint/paused/disconnected) — release the
       pacing slot we just took and stop, rather than driving a browser at
       LinkedIn with a flagged account. */
    const ctx = await sessions.buildActionContext(account.id, workspaceId);
    if (!ctx) {
      if (!args.noPace) await pacing.release(account.id, 'linkedin', workspaceId, true).catch(() => undefined);
      console.log(`\n⏸  Account not sendable (status=${account.status}) — stopping.\n`);
      break;
    }

    const note = noteTpl ? renderNote(noteTpl, t) : '';
    process.stdout.write(`${label} … `);

    let res: LinkedInActionResult;
    try {
      res = await driver.sendConnectRequest(t.url, note, ctx);
    } catch (err: any) {
      res = { status: 'failed', error: String(err?.message || err) };
    }
    tally[res.status] = (tally[res.status] || 0) + 1;
    console.log(`${res.status}${res.error ? ` (${res.error})` : ''}`);

    /* ----- classify, exactly like the worker ----- */

    if (res.status === 'sent') {
      sent++;
      await withWorkspace(workspaceId, async (d: any) => {
        if (t.leadId) {
          await d.updateTable('leads').set({ status: 'invited', last_activity: 'Invite sent' }).where('id', '=', t.leadId).execute();
        }
        await d.insertInto('activity').values({ workspace_id: workspaceId, text: `Connection request sent — ${t.name}`, tone: 'success' }).execute();
        // Only connection requests consume an invite against the caps/stats.
        await bumpInviteStat(d, workspaceId, account.id);
      }).catch((e: any) => console.warn(`   (bookkeeping skipped: ${e.message})`));
      continue;
    }

    // Already connected / pending — advance, don't count as a send.
    if (SKIP_OUTCOMES.includes(res.status)) {
      if (!args.noPace) await pacing.release(account.id, 'linkedin', workspaceId, true).catch(() => undefined);
      await withWorkspace(workspaceId, async (d: any) => {
        if (t.leadId) {
          const status = res.status === 'already_connected' ? 'accepted' : 'invited';
          const activity = res.status === 'already_connected' ? 'Already connected' : 'Invite already pending';
          await d.updateTable('leads').set({ status, last_activity: activity }).where('id', '=', t.leadId).execute();
        }
      }).catch(() => undefined);
      continue;
    }

    // Account halt — checkpoint or weekly/daily limit. Pause the account, stop.
    if (ACCOUNT_HALT_OUTCOMES.includes(res.status)) {
      await haltAccount(workspaceId, account.id, res.status);
      console.log(
        `\n🛑 ${res.status === 'checkpoint' ? 'Security checkpoint' : 'LinkedIn limit reached'} — ` +
          `account paused, run stopped. Verify the account before resuming.\n`,
      );
      break;
    }

    // Terminal per-lead failure — no invite left our account, give the slot back.
    if (TERMINAL_FAIL_OUTCOMES.includes(res.status)) {
      if (!args.noPace) await pacing.release(account.id, 'linkedin', workspaceId, true).catch(() => undefined);
      if (t.leadId && res.status === 'profile_gone') {
        await withWorkspace(workspaceId, (d: any) =>
          d.updateTable('leads').set({ status: 'unqualified', last_activity: 'Profile unavailable' }).where('id', '=', t.leadId).execute(),
        ).catch(() => undefined);
      }
      continue;
    }

    // Generic transient failure — release the slot; leave the lead as-is so a
    // later run retries it. (A standalone runner has no BullMQ backoff, so we
    // simply move on rather than block the batch on one flaky profile.)
    if (!args.noPace) await pacing.release(account.id, 'linkedin', workspaceId, true).catch(() => undefined);
  }

  /* ---- summary ---- */

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Done. ${sent} connection request(s) ${live ? 'sent' : 'simulated'}.`);
  const breakdown = Object.entries(tally)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
  if (breakdown) console.log(`Outcomes: ${breakdown}`);
  console.log('');

  await app.close();
  process.exit(0);

  /* ---- inner helpers (share the same withWorkspace tx as the caller) ---- */

  async function bumpInviteStat(d: any, wsId: string, linkedinAccountId: string) {
    await d
      .insertInto('daily_stats')
      .values({
        workspace_id: wsId,
        linkedin_account_id: linkedinAccountId,
        day: localDate() as any,
        invites_sent: 1,
        emails_sent: 0,
        accepted: 0,
        replies: 0,
      })
      .onConflict((oc: any) =>
        oc.columns(['workspace_id', 'linkedin_account_id', 'day']).doUpdateSet({
          invites_sent: (eb: any) => eb('daily_stats.invites_sent', '+', 1),
        }),
      )
      .execute();
  }

  async function haltAccount(wsId: string, accountId: string, outcome: string) {
    await withWorkspace(wsId, async (d: any) => {
      await d
        .updateTable('linkedin_accounts')
        .set({ status: outcome === 'checkpoint' ? 'checkpoint' : 'paused' })
        .where('id', '=', accountId)
        .execute();
      await d
        .insertInto('notifications')
        .values({
          workspace_id: wsId,
          kind: outcome === 'checkpoint' ? 'account_checkpoint' : 'account_paused',
          text:
            outcome === 'checkpoint'
              ? 'LinkedIn security checkpoint detected — automation paused. Please verify your account.'
              : 'LinkedIn sending limit reached — account paused until it resets.',
        })
        .execute();
    }).catch((e: any) => console.warn(`   (halt bookkeeping skipped: ${e.message})`));
  }
}

main().catch((err) => {
  console.error('\nauto-connect crashed:', err);
  process.exit(1);
});

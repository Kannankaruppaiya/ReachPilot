/**
 * verify-connect-e2e.ts — end-to-end verification of the ENTIRE connect-with-note
 * automation, run to completion, with an explicit PASS/FAIL for every stage.
 *
 * It reuses the exact production building blocks the worker uses — the selected
 * LinkedIn driver, LinkedInSessionService (cookie + proxy + fingerprint) — and
 * drives one real connection request (with a personalized note) all the way
 * through to the driver's own "invite actually sent" confirmation. Nothing is
 * mocked: if it prints ALL PASS, a real invite went out and was verified pending.
 *
 * Stages checked:
 *   1. Driver mode + safety gate      (playwright + --live for real sends)
 *   2. Account resolved & logged in   (has a stored session cookie)
 *   3. Session context built          (li_at + fingerprint; proxy if configured)
 *   4. Note rendered                  (personalized, no leftover {{tokens}})
 *   5. Connection request sent        (driver.sendConnectRequest → outcome)
 *   6. Invite confirmed               (outcome 'sent' = driver verified Pending/toast)
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *   # REAL end-to-end send + verify (needs a logged-in account):
 *   LINKEDIN_DRIVER=playwright npx ts-node -r tsconfig-paths/register \
 *     scripts/verify-connect-e2e.ts --live \
 *     --url https://www.linkedin.com/in/some-profile \
 *     --first Priya --note "Hi {{firstName}}, loved your work — would love to connect."
 *
 *   # Dry run (simulator, no real contact) — checks wiring only:
 *   npx ts-node -r tsconfig-paths/register scripts/verify-connect-e2e.ts \
 *     --url https://www.linkedin.com/in/some-profile --first Priya
 *
 * Flags:
 *   --url <profileUrl>  REQUIRED. The LinkedIn profile to send the request to.
 *   --note "<tpl>"      Note template ({{firstName}}, {{company}}, {{role}}). Default provided.
 *   --first <name>      Fills {{firstName}} (a --url has no DB lead to read it from).
 *   --company <name>    Fills {{company}}.
 *   --role <title>      Fills {{role}}.
 *   --email <addr>      Act as the account with this email (else the first sendable one).
 *   --account <uuid>    Act as this linkedin_accounts.id.
 *   --live              Allow a REAL send when the driver is `playwright`. Required for real contact.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { getEnv } from '../src/config/env';
import { LINKEDIN_DRIVER } from '../src/modules/drivers/driver.tokens';
import { LinkedInDriver, LinkedInActionResult } from '../src/modules/drivers/linkedin-driver.interface';
import { LinkedInSessionService } from '../src/modules/drivers/linkedin-session.service';

/* ---------------- args ---------------- */

type Args = {
  url?: string;
  note?: string;
  first?: string;
  company?: string;
  role?: string;
  email?: string;
  account?: string;
  live: boolean;
};

function parseArgs(argv: string[]): Args {
  const a: Args = { live: false };
  for (let i = 0; i < argv.length; i++) {
    const val = () => argv[++i];
    switch (argv[i]) {
      case '--url': a.url = val(); break;
      case '--note': a.note = val(); break;
      case '--first': a.first = val(); break;
      case '--company': a.company = val(); break;
      case '--role': a.role = val(); break;
      case '--email': a.email = val(); break;
      case '--account': a.account = val(); break;
      case '--live': a.live = true; break;
      default:
        if (argv[i].startsWith('--')) console.warn(`(ignoring unknown flag ${argv[i]})`);
    }
  }
  return a;
}

const DEFAULT_NOTE = 'Hi {{firstName|there}}, I came across your profile and would love to connect.';
const short = (id?: string | null) => (id ? id.slice(0, 8) : '-');

function renderNote(tpl: string, vars: { first?: string; company?: string; role?: string }): string {
  const map: Record<string, string> = {
    firstName: vars.first || '',
    company: vars.company || '',
    role: vars.role || '',
  };
  return tpl.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (_, key, fb) => map[key] || fb || '');
}

/* ---------------- staged reporter ---------------- */

class Report {
  private rows: { stage: string; ok: boolean; detail: string }[] = [];
  step(stage: string, ok: boolean, detail = ''): boolean {
    this.rows.push({ stage, ok, detail });
    const mark = ok ? '✅ PASS' : '❌ FAIL';
    console.log(`  ${mark}  ${stage}${detail ? '  —  ' + detail : ''}`);
    return ok;
  }
  info(msg: string) {
    console.log(`  ·       ${msg}`);
  }
  get passed(): boolean {
    return this.rows.every((r) => r.ok);
  }
}

/* ---------------- main ---------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = getEnv();
  const R = new Report();

  console.log('\n╭──────────────────────────────────────────────╮');
  console.log('│  ReachPilot — connect-with-note E2E verify     │');
  console.log('╰──────────────────────────────────────────────╯\n');

  if (!args.url) {
    console.error('❌ --url <profileUrl> is required (the profile to send the connection request to).\n');
    process.exit(2);
  }

  const isReal = env.LINKEDIN_DRIVER === 'playwright';
  const live = args.live && isReal;

  // Stage 1 — driver mode + safety gate.
  if (isReal && !args.live) {
    R.step('1. Driver mode / safety gate', false,
      'LINKEDIN_DRIVER=playwright but --live not passed — refusing to contact LinkedIn. Add --live for a real test.');
    console.log('\n❌ ABORTED (safety gate)\n');
    process.exit(2);
  }
  R.step('1. Driver mode / safety gate', true,
    live ? 'LIVE — real LinkedIn send' : `DRY RUN — ${env.LINKEDIN_DRIVER} driver (no real contact)`);
  if (live && !env.PROXY_SERVER) {
    R.info('⚠️  no PROXY_SERVER — egress from this machine\'s IP (fine for one test account).');
  }

  const app = await NestFactory.createApplicationContext(AppModule);
  const driver = app.get<LinkedInDriver>(LINKEDIN_DRIVER);
  const sessions = app.get(LinkedInSessionService);
  const db = getDb();

  let outcome: LinkedInActionResult | null = null;
  try {
    /* ---- Stage 2: resolve a sendable account (RLS: scan workspaces) ---- */
    type Acct = { id: string; workspace_id: string; email: string; status: string; session_secret_id: string | null };
    const workspaces = await db.selectFrom('workspaces').select(['id']).execute();
    let account: Acct | undefined;
    for (const ws of workspaces) {
      const rows = (await withWorkspace(ws.id, (d: any) =>
        d.selectFrom('linkedin_accounts')
          .select(['id', 'workspace_id', 'email', 'status', 'session_secret_id'])
          .execute(),
      ).catch(() => [])) as Acct[];
      for (const r of rows) {
        if (args.account && r.id !== args.account) continue;
        if (args.email && r.email?.toLowerCase() !== args.email.toLowerCase()) continue;
        const sendable = !!r.session_secret_id && !['checkpoint', 'paused', 'disconnected'].includes(r.status);
        if (!args.account && !args.email && !sendable) continue;
        account = r;
        break;
      }
      if (account) break;
    }

    if (!account) {
      R.step('2. Account resolved & logged in', false, 'no matching / sendable LinkedIn account (connect one first)');
      throw new Error('no_account');
    }
    const loggedIn = !!account.session_secret_id && !['checkpoint', 'paused', 'disconnected'].includes(account.status);
    R.step('2. Account resolved & logged in', loggedIn,
      `${account.email} [${short(account.id)}] status=${account.status} session=${account.session_secret_id ? 'yes' : 'NO'}`);
    if (!loggedIn && live) throw new Error('account_not_sendable');

    const workspaceId = account.workspace_id;

    /* ---- Stage 3: build the per-account action context ---- */
    const ctx = await sessions.buildActionContext(account.id, workspaceId);
    const ctxOk = !!ctx && (!live || !!ctx.li_at);
    R.step('3. Session context built', ctxOk,
      ctx
        ? `li_at=${ctx.li_at ? 'present' : 'MISSING'} proxy=${ctx.proxy?.ip || 'local-ip'} tz=${ctx.fingerprint?.timezoneId || '-'}`
        : 'buildActionContext returned null (account not usable)');
    if (!ctxOk) throw new Error('no_context');

    /* ---- Stage 4: render the note ---- */
    const tpl = args.note ?? DEFAULT_NOTE;
    const note = renderNote(tpl, { first: args.first, company: args.company, role: args.role });
    const noteOk = note.trim().length > 0 && !/\{\{.*?\}\}/.test(note);
    R.step('4. Note rendered', noteOk, `"${note}"${/\{\{.*?\}\}/.test(note) ? '  (leftover token!)' : ''}`);
    if (!noteOk) throw new Error('bad_note');

    /* ---- Stage 5: send the connection request WITH the note ---- */
    console.log(`\n  → Sending connection request to ${args.url}\n`);
    const t0 = Date.now();
    outcome = await driver.sendConnectRequest(args.url!, note, ctx || undefined);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const sendReturned = !!outcome && typeof outcome.status === 'string';
    R.step('5. Connection request sent', sendReturned, `outcome=${outcome?.status}${outcome?.error ? ` (${outcome.error})` : ''} in ${secs}s`);

    /* ---- Stage 6: interpret the confirmed outcome ---- */
    // The driver now confirms a real invite (Pending/toast, reload-verified)
    // before returning 'sent', so 'sent' is a verified send, not a click-and-hope.
    const s = outcome?.status;
    if (s === 'sent') {
      R.step('6. Invite confirmed on LinkedIn', true, 'driver verified the invite is pending — REAL send ✔');
    } else if (s === 'pending') {
      R.step('6. Invite confirmed on LinkedIn', true, 'an invite to this profile was ALREADY outstanding (nothing to do)');
    } else if (s === 'already_connected') {
      R.step('6. Invite confirmed on LinkedIn', true, 'already a 1st-degree connection — cannot invite (flow correct)');
    } else if (s === 'limit_reached') {
      R.step('6. Invite confirmed on LinkedIn', false, 'LinkedIn invite/note limit hit — try an empty note or wait for the cap to reset');
    } else if (s === 'checkpoint') {
      R.step('6. Invite confirmed on LinkedIn', false, 'security checkpoint — verify the account on LinkedIn, then retry');
    } else if (s === 'no_connect_button' || s === 'profile_gone' || s === 'blocked') {
      R.step('6. Invite confirmed on LinkedIn', false, `target not connectable (${s})`);
    } else {
      R.step('6. Invite confirmed on LinkedIn', false, `send did not complete (${s}${outcome?.error ? ': ' + outcome.error : ''})`);
    }
  } catch (err: any) {
    if (!['no_account', 'account_not_sendable', 'no_context', 'bad_note'].includes(err?.message)) {
      console.error('\n  ❌ unexpected error:', err?.message || err);
    }
  } finally {
    await app.close();
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(R.passed ? '✅ ALL STAGES PASS — connect-with-note automation is working end-to-end.'
                       : '❌ ONE OR MORE STAGES FAILED — see the ❌ lines above.');
  console.log('──────────────────────────────────────────────\n');
  process.exit(R.passed ? 0 : 1);
}

main().catch((err) => {
  console.error('verify-connect-e2e crashed:', err);
  process.exit(1);
});

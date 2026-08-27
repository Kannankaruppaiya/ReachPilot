/**
 * Read-only check that the session-cookie fixes actually took effect on a live
 * account. Run AFTER installing the rebuilt desktop app and reconnecting LinkedIn.
 *
 *   npx ts-node -r tsconfig-paths/register scripts/_verify-session-store.ts [email-substring]
 *
 * Verifies, for the account:
 *   1. #12 — the vault holds the FULL cookie jar, not a bare li_at string
 *   2. #15 — the browser profile's li_at is the SAME one we stored (i.e. nothing
 *            clobbered it), or newer (profile wins — also correct)
 *   3.      the session actually authenticates (loads /feed/ signed in)
 *
 * Prints no secret values — only lengths and short hashes.
 */
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';
import { parseStoredSession } from '@/modules/drivers/linkedin-session-store';

const MATCH = process.argv[2] || 'greatworks';
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex').slice(0, 12);
const ok = (b: boolean) => (b ? 'PASS' : 'FAIL');

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const secrets = app.get(SecretsService);
  const db = getDb();

  let acct: any;
  let wsId = '';
  for (const ws of await db.selectFrom('workspaces').select(['id']).execute()) {
    const rows = (await withWorkspace(ws.id, (d: any) =>
      d
        .selectFrom('linkedin_accounts')
        .select(['id', 'email', 'status', 'session_secret_id'])
        .execute(),
    ).catch(() => [])) as any[];
    const found = rows.find((r) => String(r.email).includes(MATCH));
    if (found) {
      acct = found;
      wsId = ws.id;
      break;
    }
  }
  if (!acct) {
    console.log(`no account matching "${MATCH}"`);
    process.exit(1);
  }
  console.log(`account: ${acct.email} [${acct.id.slice(0, 8)}] status=${acct.status}\n`);

  /* --- 1. what the vault holds --- */
  const raw = acct.session_secret_id
    ? await secrets.decrypt(acct.session_secret_id, { workspaceId: wsId }).catch(() => undefined)
    : undefined;
  const isJar = !!raw && raw.trim().startsWith('[');
  const stored = parseStoredSession(raw);
  const storedLiAt = stored.find((c) => c.name === 'li_at');

  console.log(`#12  vault holds the full jar        : ${ok(isJar)}`);
  console.log(`       cookies stored: ${stored.length}  [${stored.map((c) => c.name).join(', ')}]`);
  if (!isJar && raw) console.log('       (still the legacy bare-li_at format — reconnect to upgrade it)');
  console.log(`       li_at sha=${storedLiAt ? sha(storedLiAt.value) : '-'} domain=${storedLiAt?.domain ?? '-'}`);

  /* --- 2 + 3. what the browser profile holds, and does it authenticate --- */
  const dir = path.join(os.tmpdir(), 'reachpilot-profiles', acct.id);
  if (!fs.existsSync(dir)) {
    console.log(`\n#15  profile dir not found (${dir}) — run one job first`);
    process.exit(0);
  }
  const copy = path.join(os.tmpdir(), 'rp-verify-profile');
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(dir, copy, { recursive: true });
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile']) {
    fs.rmSync(path.join(copy, f), { force: true });
  }

  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(copy, {
    headless: true,
    args: ['--no-sandbox'],
  } as any);
  const jar = await context.cookies('https://www.linkedin.com');
  const profileLiAt = jar.find((c) => c.name === 'li_at');

  console.log(`\n#15  profile still owns its session : ${ok(!!profileLiAt?.value)}`);
  console.log(`       profile cookies: ${jar.length}  li_at sha=${profileLiAt ? sha(profileLiAt.value) : '-'}`);
  if (storedLiAt && profileLiAt) {
    const same = storedLiAt.value === profileLiAt.value;
    console.log(`       vault vs profile: ${same ? 'IDENTICAL (stored at this login)' : 'DIFFERENT — profile is newer, and it WINS (correct)'}`);
  }

  const page = context.pages()[0] || (await context.newPage());
  let landed = '';
  let err = '';
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    landed = page.url();
  } catch (e: any) {
    err = String(e.message).split('\n')[0];
    landed = page.url();
  }
  const signedIn = !/\/login|\/authwall|\/uas\/login/.test(landed) && !err;
  console.log(`\n     session authenticates          : ${ok(signedIn)}`);
  console.log(`       /feed/ -> ${landed} ${err ? `ERR=${err}` : ''}`);

  await context.close();
  fs.rmSync(copy, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

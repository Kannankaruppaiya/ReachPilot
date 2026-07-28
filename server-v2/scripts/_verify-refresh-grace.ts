/**
 * Verifies the refresh-token rotation grace (cross-tab logout race fix).
 * Exercises AuthService.refresh() directly against the real DB, then cleans up.
 * Run: npx ts-node -r tsconfig-paths/register scripts/_verify-refresh-grace.ts
 */
import * as crypto from 'crypto';
import { getDb } from '../src/db';
import { AuthService } from '../src/modules/auth/auth.service';

const auth = new AuthService({ log: async () => {} } as any);
const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');
const meta = { userAgent: 'verify-script', ip: '127.0.0.1' };
const createdHashes: string[] = [];

async function seedSession(
  userId: string,
  token: string,
  opts: { revoked?: boolean; rotatedMsAgo?: number | null } = {},
) {
  const db = getDb();
  const now = Date.now();
  const expires = new Date(now + 7 * 864e5).toISOString();
  const hash = sha(token);
  createdHashes.push(hash);
  await db
    .insertInto('user_sessions')
    .values({
      user_id: userId,
      refresh_token_hash: hash,
      user_agent: meta.userAgent,
      ip: meta.ip,
      expires_at: expires,
      revoked_at: opts.revoked ? new Date(now).toISOString() : null,
      rotated_at:
        opts.rotatedMsAgo == null ? null : new Date(now - opts.rotatedMsAgo).toISOString(),
    } as any)
    .execute();
}

async function expectOk(label: string, fn: () => Promise<any>) {
  try {
    const r = await fn();
    if (r?.refreshToken) createdHashes.push(sha(r.refreshToken));
    console.log(`  PASS  ${label}`);
    return true;
  } catch (e: any) {
    console.log(`  FAIL  ${label}  (threw: ${e?.message})`);
    return false;
  }
}

async function expect401(label: string, fn: () => Promise<any>) {
  try {
    await fn();
    console.log(`  FAIL  ${label}  (expected 401, but succeeded)`);
    return false;
  } catch (e: any) {
    console.log(`  PASS  ${label}  (rejected: ${e?.message})`);
    return true;
  }
}

async function main() {
  const db = getDb();
  const user = await db.selectFrom('users').select(['id', 'email']).limit(1).executeTakeFirst();
  if (!user) throw new Error('no users in DB to test with');
  console.log(`\nTest user: ${user.email} (${String(user.id).slice(0, 8)}…)\n`);
  const results: boolean[] = [];

  // 1) Normal rotation: fresh token → succeeds, and the row gets rotated/replaced.
  const T1 = crypto.randomBytes(40).toString('hex');
  await seedSession(user.id, T1);
  results.push(await expectOk('normal rotation (fresh token)', () => auth.refresh(T1, meta)));
  const row1 = await db
    .selectFrom('user_sessions')
    .select(['revoked_at', 'rotated_at', 'replaced_by'])
    .where('refresh_token_hash', '=', sha(T1))
    .executeTakeFirst();
  const rotated = !!row1?.revoked_at && !!row1?.rotated_at && !!row1?.replaced_by;
  console.log(`  ${rotated ? 'PASS' : 'FAIL'}  rotated row has revoked_at+rotated_at+replaced_by`);
  results.push(rotated);

  // 2) GRACE: the SAME just-rotated token presented again → succeeds (concurrent tab).
  results.push(
    await expectOk('grace: re-present just-rotated token (within window)', () =>
      auth.refresh(T1, meta)),
  );

  // 3) LOGOUT: revoked with rotated_at NULL → no grace, must 401.
  const T2 = crypto.randomBytes(40).toString('hex');
  await seedSession(user.id, T2, { revoked: true, rotatedMsAgo: null });
  results.push(
    await expect401('logout token (revoked, never rotated)', () => auth.refresh(T2, meta)),
  );

  // 4) STALE: rotated 2 min ago (> 30s grace) → must 401 (reuse/theft detection).
  const T3 = crypto.randomBytes(40).toString('hex');
  await seedSession(user.id, T3, { revoked: true, rotatedMsAgo: 120_000 });
  results.push(
    await expect401('stale replay (rotated outside grace window)', () => auth.refresh(T3, meta)),
  );

  // 5) GARBAGE: unknown token → 401.
  results.push(
    await expect401('unknown token', () => auth.refresh(crypto.randomBytes(40).toString('hex'), meta)),
  );

  // cleanup every session this script created.
  for (const h of createdHashes) {
    await db.deleteFrom('user_sessions').where('refresh_token_hash', '=', h).execute();
  }
  console.log(`\ncleaned up ${createdHashes.length} test sessions.`);

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} checks passed ===\n`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

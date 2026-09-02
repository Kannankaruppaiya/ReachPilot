/**
 * Regression: "Today's invites 22 / 20" on an account whose daily cap is 20.
 *
 * OBSERVED LIVE (2026-08-28) — the pacing probe reported base(ramp)=20,
 * jittered=20, sentToday=22. Pacing had NOT overshot: two leads resolved as
 * `already_connected` / `pending`, which the worker parks in `status='sent'`
 * (terminal, never retried) with the outcome in `last_error` while explicitly
 * releasing the pacing slot, because no invite left the account.
 *
 * The dashboard counted those rows as invites, so the panel accused the engine
 * of breaking a limit it had actually obeyed.
 *
 * Pure logic — no DB, no Redis, no browser.
 */
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { SKIP_OUTCOMES } from '../src/modules/drivers/linkedin-driver.interface';
import { isRealSend, whereRealSend } from '../src/modules/jobs/real-sends';

describe('invite counting', () => {
  it('does not count a skipped lead as an invite', () => {
    for (const skip of SKIP_OUTCOMES) expect(isRealSend('sent', skip)).toBe(false);
  });

  it('still counts a real send, including one that was deferred on an earlier attempt', () => {
    expect(isRealSend('sent', null)).toBe(true);
    // last_error survives a defer and is not cleared on success.
    expect(isRealSend('sent', 'agent_unavailable')).toBe(true);
  });

  it('counts nothing that has not been sent', () => {
    for (const s of ['scheduled', 'queued', 'running', 'failed', 'canceled']) {
      expect(isRealSend(s, null)).toBe(false);
    }
  });

  it('carries the same rule into SQL', () => {
    const db = new Kysely<any>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (d: any) => new PostgresIntrospector(d),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
    });
    const compiled = whereRealSend(db.selectFrom('jobs').selectAll()).compile();
    expect(compiled.sql).toContain('last_error');
    for (const skip of SKIP_OUTCOMES) expect(compiled.parameters).toContain(skip);
  });
});

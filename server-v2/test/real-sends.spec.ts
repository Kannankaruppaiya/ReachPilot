/**
 * Regression: "Today's invites 22 / 20". Skipped leads (already_connected /
 * pending) are parked in `sent` with their slot released; the dashboard counted
 * them as invites. Pure logic.
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

/**
 * Regression: tenant isolation was off in production and nothing noticed.
 *
 * MEASURED 2026-08-27 against the live database:
 *
 *   connected as : {"current_user":"postgres","bypassrls":true,"superuser":false}
 *   jobs / leads / campaigns / memberships : rls_enabled=true forced=true policies>=1
 *   withWorkspace(Kannan's)  guc + current_workspace_id() correct, jobs = 370
 *   withWorkspace(RJP's)     guc + current_workspace_id() correct, jobs = 370
 *   raw getDb() (no context)                                       jobs = 370
 *
 * Every signal the codebase relied on looked healthy — RLS enabled, FORCE set,
 * policies attached, the GUC arriving, the helper returning the right uuid — while
 * four different workspaces read each other's rows. The cause was the connecting
 * ROLE: `postgres` carries BYPASSRLS, and Postgres skips policies entirely for such
 * a role. FORCE ROW LEVEL SECURITY does NOT override that; it only stops a table's
 * owner from bypassing its own policies.
 *
 * So the check that matters is not "is RLS configured" but "does it bite for the
 * identity we connect with", and BYPASSRLS has to be judged before anything else —
 * otherwise a perfectly configured schema reports a false all-clear.
 *
 * Pure logic — no DB, no Redis, no browser.
 */
import { isolationVerdict, type IsolationFacts } from '../src/db/tenant-isolation';

const healthyTables = ['jobs', 'leads', 'campaigns', 'memberships'].map((name) => ({
  name,
  rlsEnabled: true,
  forced: true,
  policies: 1,
}));

describe('tenant isolation verdict', () => {
  it('reports the production state as NOT isolated, despite a flawless schema', () => {
    const observed: IsolationFacts = { role: 'postgres', bypassrls: true, tables: healthyTables };
    const v = isolationVerdict(observed);
    expect(v.isolated).toBe(false);
    expect(v.reason).toMatch(/BYPASSRLS/);
  });

  it('judges BYPASSRLS before table config, so a perfect schema cannot mask it', () => {
    // The trap: every table check passes. Only role order saves us.
    const v = isolationVerdict({ role: 'postgres', bypassrls: true, tables: healthyTables });
    expect(v.reason).not.toMatch(/FORCE|no effective RLS/);
  });

  it('passes for a plain role against the same tables', () => {
    const v = isolationVerdict({ role: 'reachpilot_app', bypassrls: false, tables: healthyTables });
    expect(v.isolated).toBe(true);
  });

  it('catches a table with RLS enabled but no policy attached', () => {
    const tables = healthyTables.map((t) => (t.name === 'leads' ? { ...t, policies: 0 } : t));
    const v = isolationVerdict({ role: 'reachpilot_app', bypassrls: false, tables });
    expect(v.isolated).toBe(false);
    expect(v.reason).toMatch(/leads/);
  });

  it('catches a missing FORCE, which lets the owner read past its own policies', () => {
    const tables = healthyTables.map((t) => (t.name === 'jobs' ? { ...t, forced: false } : t));
    const v = isolationVerdict({ role: 'reachpilot_app', bypassrls: false, tables });
    expect(v.isolated).toBe(false);
    expect(v.reason).toMatch(/FORCE/);
  });

  it('never reports isolated when it has observed nothing', () => {
    // An empty table list must not read as "all clear" — that is how a probe that
    // silently matched no tables would grant a false pass.
    // Deliberately a role that would otherwise PASS — with bypassrls true the
    // first branch would catch it and the guard below would go untested.
    const v = isolationVerdict({ role: 'reachpilot_app', bypassrls: false, tables: [] });
    expect(v.isolated).toBe(false);
    expect(v.reason).toMatch(/unverified/);

    // A partial observation is just as unsafe as none.
    const partial = isolationVerdict({
      role: 'reachpilot_app',
      bypassrls: false,
      tables: [{ name: 'jobs', rlsEnabled: true, forced: true, policies: 1 }],
    });
    expect(partial.isolated).toBe(false);
    expect(partial.reason).toMatch(/leads/);
  });
});

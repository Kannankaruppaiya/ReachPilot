/**
 * Regression: isolation was off in production though RLS looked healthy (enabled,
 * forced, policies, GUC set). The connecting role had BYPASSRLS, which skips every
 * policy (FORCE only stops table owners). So BYPASSRLS is judged first. Pure logic.
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
    // Every table check passes here; only the role check catches it.
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
    // An empty table list must not pass. Uses a role that would otherwise pass, so
    // the bypassrls branch doesn't mask this guard.
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

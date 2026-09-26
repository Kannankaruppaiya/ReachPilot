/**
 * Guard for suites that write rows or enqueue jobs: the production scheduler
 * scans every workspace every 30s and would claim test jobs. Call
 * assertLocalServices() in beforeAll and skip if it throws.
 */

/** Hosts we accept as "a throwaway service on this machine". */
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', 'postgres', 'redis'];

function hostOf(url: string): string {
  // postgresql://user:pass@host:port/db  |  redis://:pass@host:port
  return /^[a-z+]+:\/\/(?:[^@/]*@)?\[?([^:\]/?]+)/i.exec(url)?.[1] || '';
}

function assertLocal(label: string, url: string | undefined) {
  if (!url) throw new Error(`${label} is not set`);
  const host = hostOf(url);
  if (!LOCAL_HOSTS.includes(host)) {
    throw new Error(
      `refusing to run: ${label} points at "${host}", not a local service. ` +
        'This suite writes rows and enqueues jobs; against the shared production ' +
        'database the live scheduler would pick them up. Create server-v2/.env.test ' +
        '(see test/setup-test-env.ts) and start the local containers.',
    );
  }
}

/** Throws unless BOTH Postgres and Redis are local. */
export function assertLocalServices(env: { DATABASE_URL?: string; REDIS_URL?: string }) {
  assertLocal('DATABASE_URL', env.DATABASE_URL);
  assertLocal('REDIS_URL', env.REDIS_URL);
}

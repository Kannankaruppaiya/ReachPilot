/**
 * Read-only: why did the last remaining job not send?
 *
 * The worker logged "Pacing limit hit — deferred to scheduler" with
 * nextRun = tomorrow's window open — but BOTH the daily-cap gate and the
 * working-hours gate return exactly that, so the log alone cannot say which one
 * fired. Evaluate the real gates, in order, using the real functions.
 */
import { getDb } from '../src/db';
import { withWorkspace } from '../src/db/rls';
import { PacingService } from '../src/modules/engine/pacing.service';
import { computeWarmup, warmupOrigin } from '../src/modules/engine/warmup';
const { sql } = require('kysely');

const LOG_TS = 1787834849093; // the "Pacing limit hit" line

(async () => {
  const db: any = getDb();
  const ws = (await db.selectFrom('workspaces').select('id').execute()) as any[];

  let acct: any = null;
  let wsId = '';
  for (const w of ws) {
    const rows = (await withWorkspace(w.id, (d: any) =>
      d.selectFrom('linkedin_accounts').selectAll().execute(),
    ).catch(() => [])) as any[];
    const found = rows.find((r) => String(r.email).includes('greatworks'));
    if (found) { acct = found; wsId = w.id; break; }
  }
  if (!acct) { console.log('account not found'); process.exit(1); }

  const now = new Date();
  const tz = acct.timezone || 'UTC';
  const localTimeStr = now.toLocaleTimeString('en-US', { timeZone: tz, hour12: false });
  const localDay = now.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' });
  const localDateIso = now.toLocaleDateString('en-US', { timeZone: tz });
  const hoursStart = acct.hours_start || '09:00';
  const hoursEnd = acct.hours_end || '18:00';

  console.log(`account   : ${acct.email}  tz=${tz}`);
  console.log(`log line  : ${new Date(LOG_TS).toLocaleString('en-US', { timeZone: tz })} (local)`);
  console.log(`now       : ${localDay} ${localTimeStr} (local)`);
  console.log(`hours     : ${hoursStart} – ${hoursEnd}   weekends=${acct.send_weekends}`);

  // --- gate 1: weekend
  const isWeekend = localDay === 'Sat' || localDay === 'Sun';
  console.log(`\nGATE 1 weekend      : ${isWeekend && !acct.send_weekends ? 'BLOCKS' : 'passes'}`);

  // --- gate 2: working hours (same comparison the service makes)
  const wrapsMidnight = hoursEnd < hoursStart;
  const inWindow = wrapsMidnight
    ? localTimeStr >= hoursStart || localTimeStr <= hoursEnd
    : localTimeStr >= hoursStart && localTimeStr <= hoursEnd;
  console.log(`GATE 2 working hours: ${inWindow ? 'passes' : 'BLOCKS'}   (now ${localTimeStr} vs ${hoursStart}-${hoursEnd})`);

  // Was the window open when that log line was written?
  const logLocal = new Date(LOG_TS).toLocaleTimeString('en-US', { timeZone: tz, hour12: false });
  const logInWindow = wrapsMidnight
    ? logLocal >= hoursStart || logLocal <= hoursEnd
    : logLocal >= hoursStart && logLocal <= hoursEnd;
  console.log(`   at log time      : ${logInWindow ? 'was OPEN' : 'was CLOSED'} (${logLocal})`);

  // --- gate 3: daily cap, via the real ramp + the real jitter
  const base = computeWarmup(
    warmupOrigin(acct.connected_at, acct.created_at),
    acct.warmup_daily_limit,
    acct.warmup_target,
    now,
  ).todayLimit;
  const effective = new PacingService().jitterDailyLimit(base, acct.id, localDateIso);

  const sentToday = Number(
    (
      await sql`select count(*)::int n from jobs
                 where kind='linkedin' and action='connect_request' and status='sent'
                   and sent_at >= date_trunc('day', now() at time zone ${tz})`.execute(db)
    ).rows[0].n,
  );

  console.log(`\nGATE 3 daily cap    : base(ramp)=${base}  jittered=${effective}  sentToday=${sentToday}`);
  console.log(`   ${sentToday >= effective ? 'BLOCKS — cap reached' : `passes — ${effective - sentToday} left`}`);
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });

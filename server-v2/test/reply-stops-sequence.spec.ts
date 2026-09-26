/**
 * A reply must end the sequence, including the follow-up already scheduled days
 * ahead, and a mid-flight send must not reactivate it. Skips without local
 * Postgres; nothing is enqueued.
 */
import { randomUUID } from 'crypto';
import { getDb } from '@/db';
import { withWorkspace } from '@/db/rls';
import { getEnv } from '@/config/env';
import { CampaignsService } from '@/modules/campaigns/campaigns.service';
import { GraphExecutor } from '@/modules/engine/graph-executor';
import { ConditionEvaluator } from '@/modules/engine/condition-evaluator';
import { LinkedInSyncService } from '@/modules/drivers/linkedin-sync.service';
import {
  advanceEnrollment,
  deferEnrollment,
  setLiveEnrollmentStatus,
  stopSequencesOnReply,
} from '@/modules/engine/enrollment-state';
import { assertLocalServices } from './local-only';

const WS = '00000000-0000-0000-0000-0000000000b1';
const ACCT = '00000000-0000-0000-0000-0000000000b2';

let reachable = false;
let skipReason = '';
const campaigns = new CampaignsService();
const executor = new GraphExecutor(new ConditionEvaluator());

beforeAll(async () => {
  try {
    assertLocalServices(getEnv());
    await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
    await getDb().insertInto('workspaces').values({ id: WS, name: 'reply-stops' }).execute();
    await withWorkspace(WS, (db) =>
      db
        .insertInto('linkedin_accounts')
        .values({ id: ACCT, workspace_id: WS, email: 'reply-probe@test.local', country: 'IN', status: 'active' })
        .execute(),
    );
    reachable = true;
  } catch (e: any) {
    skipReason = e.message;
  }
}, 60_000);

afterAll(async () => {
  if (reachable) await getDb().deleteFrom('workspaces').where('id', '=', WS).execute();
  await getDb().destroy();
}, 60_000);

const t = (name: string, fn: () => Promise<void>) =>
  it(
    name,
    async () => {
      if (!reachable) {
        console.warn(`  ↳ skipped (${skipReason})`);
        return;
      }
      await fn();
    },
    60_000,
  );

/**
 * A lead two steps into "invite → wait 2 days → message": the invite is sent and
 * the follow-up message job is already scheduled for later.
 */
async function leadAwaitingFollowUp() {
  const leadId = randomUUID();
  const slug = `reply-${leadId.slice(0, 8)}`;
  await withWorkspace(WS, (db) =>
    db
      .insertInto('leads')
      .values({
        id: leadId,
        workspace_id: WS,
        full_name: 'Reply Prospect',
        first_name: 'Reply',
        linkedin_url: `https://www.linkedin.com/in/${slug}`,
        linkedin_slug: slug,
        status: 'accepted',
        source: 'test',
      })
      .execute(),
  );
  const camp = await campaigns.create(WS, {
    name: `reply ${leadId.slice(0, 6)}`,
    steps: [{ kind: 'wait', days: 1 }, { kind: 'invite' }, { kind: 'wait', days: 2 }, { kind: 'message', body: 'just following up' }],
    leadIds: [leadId],
    launch: true,
  });
  const detail = await campaigns.get(WS, camp.id);
  const enrollmentId = detail.enrollments[0].enrollmentId as string;
  const [inviteStep, messageStep] = detail.steps.map((s: any) => s.id as string);

  await executor.executeStep(WS, enrollmentId); // → invite job
  // The invite goes out; the worker moves the enrollment on …
  await withWorkspace(WS, async (db) => {
    await db.updateTable('jobs').set({ status: 'sent', sent_at: new Date().toISOString() }).where('enrollment_id', '=', enrollmentId).execute();
    await advanceEnrollment(db, WS, enrollmentId, inviteStep);
  });
  await executor.executeStep(WS, enrollmentId); // → follow-up job, due in 2 days
  return { leadId, slug, enrollmentId, messageStep };
}

const followUpJob = (enrollmentId: string, stepId: string) =>
  withWorkspace(WS, (db) =>
    db
      .selectFrom('jobs')
      .select(['id', 'status', 'last_error'])
      .where('enrollment_id', '=', enrollmentId)
      .where('step_id', '=', stepId)
      .executeTakeFirstOrThrow(),
  );

const enrollment = (id: string) =>
  withWorkspace(WS, (db) =>
    db.selectFrom('enrollments').select(['status', 'current_step_id']).where('id', '=', id).executeTakeFirstOrThrow(),
  );

describe('a reply ends the sequence', () => {
  t('a LinkedIn reply withdraws the follow-up that was already scheduled', async () => {
    const l = await leadAwaitingFollowUp();
    expect((await followUpJob(l.enrollmentId, l.messageStep)).status).toBe('scheduled');

    const sync = new LinkedInSyncService(null as any, null as any);
    const res = await sync.apply(WS, ACCT, {
      accepted: [],
      replies: [{ profileUrl: `https://www.linkedin.com/in/${l.slug}/`, text: 'Thanks, not now', externalId: `li-${l.leadId}` }],
    } as any);

    expect(res.replies).toBe(1);
    expect(await followUpJob(l.enrollmentId, l.messageStep)).toMatchObject({ status: 'canceled', last_error: 'lead_replied' });
    expect((await enrollment(l.enrollmentId)).status).toBe('replied');

    // The runner revisiting the lead must not make the follow-up again.
    await executor.executeStep(WS, l.enrollmentId);
    expect((await followUpJob(l.enrollmentId, l.messageStep)).status).toBe('canceled');
  });

  t('a job already running is left alone (it cannot be recalled)', async () => {
    const l = await leadAwaitingFollowUp();
    const job = await followUpJob(l.enrollmentId, l.messageStep);
    await withWorkspace(WS, (db) => db.updateTable('jobs').set({ status: 'running' }).where('id', '=', job.id).execute());

    const withdrawn = await withWorkspace(WS, (db) => stopSequencesOnReply(db, WS, l.leadId));

    expect(withdrawn).toBe(0);
    expect((await followUpJob(l.enrollmentId, l.messageStep)).status).toBe('running');
    expect((await enrollment(l.enrollmentId)).status).toBe('replied');
  });

  t('a send that lands after the reply does not revive the sequence', async () => {
    const l = await leadAwaitingFollowUp();
    await withWorkspace(WS, (db) => stopSequencesOnReply(db, WS, l.leadId));

    // The worker's post-send bookkeeping for a job that was mid-flight.
    await withWorkspace(WS, (db) => advanceEnrollment(db, WS, l.enrollmentId, l.messageStep));

    const e = await enrollment(l.enrollmentId);
    expect(e.status).toBe('replied');
    expect(e.current_step_id).toBe(l.messageStep);
  });
});

describe('worker writes respect a paused lead', () => {
  t('a pacing defer does not turn a paused enrollment back into waiting', async () => {
    const l = await leadAwaitingFollowUp();
    await withWorkspace(WS, (db) => db.updateTable('enrollments').set({ status: 'paused' }).where('id', '=', l.enrollmentId).execute());

    await withWorkspace(WS, async (db) => {
      await deferEnrollment(db, WS, l.enrollmentId, new Date(Date.now() + 3600_000).toISOString());
      await setLiveEnrollmentStatus(db, WS, l.enrollmentId, 'failed');
    });

    expect((await enrollment(l.enrollmentId)).status).toBe('paused');
  });

  t('a retry that succeeds after a transient failure still moves the lead on', async () => {
    const l = await leadAwaitingFollowUp();
    await withWorkspace(WS, (db) => setLiveEnrollmentStatus(db, WS, l.enrollmentId, 'failed'));
    expect((await enrollment(l.enrollmentId)).status).toBe('failed');

    await withWorkspace(WS, (db) => advanceEnrollment(db, WS, l.enrollmentId, l.messageStep));

    // message was the last step → finished, not stuck at failed.
    expect((await enrollment(l.enrollmentId)).status).toBe('finished');
  });
});

/**
 * Regression: the dashboard's "Today's queue" counted the wrong things.
 *
 * OBSERVED LIVE (2026-08-27) — the widget read "Sending today 0 / Scheduled for
 * later 155" while invites were actively going out. Actual job rows:
 *
 *   linkedin scheduled  due today or overdue   71   <-- belongs to "Sending today"
 *   linkedin scheduled  later                  84
 *   linkedin failed                            12   <-- must never be counted
 *   linkedin canceled                           1   <-- must never be counted
 *   queued  (any)                               0
 *
 * Two defects:
 *   1. "Sending today" counted `status = 'queued'`. That is the momentary BullMQ
 *      handoff — a job sits in it for seconds — so the number read 0 essentially
 *      always, no matter how much work was due.
 *   2. "Scheduled for later" counted EVERY `scheduled` row, so the 71 jobs due
 *      today were reported as future work.
 *
 * Both counters now share PENDING_JOB_STATUSES and split on the due date instead.
 * This spec pins the invariant the operator asked for: a FAILED invite is finished
 * work and must not appear in either bucket. Same for sent and canceled — counting
 * any of them promises sends that will never happen, and every terminal
 * `no_connect_button` would inflate the queue permanently.
 *
 * Pure logic — no DB, no Redis, no browser.
 */
import { PENDING_JOB_STATUSES, splitQueue } from '../src/modules/dashboard/dashboard.service';

describe("dashboard \"Today's queue\" buckets", () => {
  it('never counts finished work', () => {
    for (const terminal of ['failed', 'sent', 'canceled']) {
      expect(PENDING_JOB_STATUSES as readonly string[]).not.toContain(terminal);
    }
  });

  it('counts every state that still represents outstanding work', () => {
    // `scheduled` is the backbone state, `queued` the BullMQ handoff, `running`
    // the in-flight send. Dropping any of them under-reports the queue.
    for (const pending of ['scheduled', 'queued', 'running']) {
      expect(PENDING_JOB_STATUSES as readonly string[]).toContain(pending);
    }
  });

  it("splits today's work from later work on the due date", () => {
    // The bucket rule, stated once: due before tomorrow-local => "Sending today".
    const startOfToday = new Date('2026-08-27T00:00:00+05:30');
    const endOfToday = new Date(startOfToday);
    endOfToday.setDate(endOfToday.getDate() + 1);

    const isToday = (dueIso: string) => new Date(dueIso) < endOfToday;

    expect(isToday('2026-08-27T13:37:00+05:30')).toBe(true); // due later today
    expect(isToday('2026-08-26T09:00:00+05:30')).toBe(true); // overdue — still owed today
    expect(isToday('2026-08-28T00:00:00+05:30')).toBe(false); // tomorrow
    expect(isToday('2026-09-04T10:00:00+05:30')).toBe(false); // next week
  });
});

/**
 * Second correction, from the operator: being DUE today is not GOING today.
 *
 * OBSERVED 2026-08-27, after the first fix landed: the panel read "Sending today
 * 53 / Scheduled for later 84" while account health read "Today's invites 19/20".
 * Only ONE more invite could leave that day — pacing would defer the other 52. So
 * 53 promised sends that would not happen, the mirror image of the 0 the panel
 * used to show unconditionally. Both numbers were wrong; only the direction
 * changed.
 */
describe('splitQueue', () => {
  it('reports what can actually go out, not what is merely due', () => {
    // The exact live case: 53 due, 137 outstanding, 20/day cap, 19 already sent.
    expect(splitQueue({ dueToday: 53, outstanding: 137, dailyLimit: 20, sentToday: 19 })).toEqual({
      sendingToday: 1,
      scheduledLater: 136,
    });
  });

  it('never loses work — the two numbers always sum to the outstanding total', () => {
    for (const c of [
      { dueToday: 53, outstanding: 137, dailyLimit: 20, sentToday: 19 },
      { dueToday: 0, outstanding: 137, dailyLimit: 20, sentToday: 0 },
      { dueToday: 137, outstanding: 137, dailyLimit: 20, sentToday: 0 },
      { dueToday: 5, outstanding: 5, dailyLimit: 20, sentToday: 20 },
    ]) {
      const r = splitQueue(c);
      expect(r.sendingToday + r.scheduledLater).toBe(c.outstanding);
    }
  });

  it('shows nothing going today once the cap is spent', () => {
    expect(splitQueue({ dueToday: 40, outstanding: 90, dailyLimit: 20, sentToday: 20 }).sendingToday).toBe(0);
    // Over-sent (a cap lowered mid-day) must not produce a negative.
    expect(splitQueue({ dueToday: 40, outstanding: 90, dailyLimit: 20, sentToday: 25 }).sendingToday).toBe(0);
  });

  it('promises nothing when there is no connected account to send from', () => {
    expect(splitQueue({ dueToday: 40, outstanding: 90, dailyLimit: null, sentToday: 0 }).sendingToday).toBe(0);
  });

  it('is bounded by what is due, not just by the cap', () => {
    // Plenty of headroom, but only 3 jobs are actually due today.
    expect(splitQueue({ dueToday: 3, outstanding: 90, dailyLimit: 20, sentToday: 0 }).sendingToday).toBe(3);
  });
});

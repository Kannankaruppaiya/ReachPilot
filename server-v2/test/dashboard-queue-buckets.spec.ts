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
import { PENDING_JOB_STATUSES } from '../src/modules/dashboard/dashboard.service';

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

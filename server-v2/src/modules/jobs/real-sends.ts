import { SKIP_OUTCOMES } from '@/modules/drivers/linkedin-driver.interface';

/**
 * Which `sent` job rows actually put an invite on the wire.
 *
 * 🔴 `status = 'sent'` means TERMINAL, not DELIVERED. A lead that resolves as
 * `already_connected` or `pending` is parked in `sent` too (so it is never
 * retried) with the outcome in `last_error` — and the worker deliberately gives
 * its pacing slot back, because nothing left the account.
 *
 * Counting those rows as invites is what put "Today's invites 22 / 20" on a
 * 20/day account: 20 real invites plus 2 skips. The engine was obeying the cap;
 * the counter was reading a state that also means "we did nothing". Any panel
 * that answers "how many invites went out" must exclude them — while the
 * duplicate-invite guard and the upload de-dupe keep counting them, since for
 * those "we already dealt with this person" is exactly the right answer.
 */
export const isRealSend = (status: string, lastError: string | null | undefined): boolean =>
  status === 'sent' && !(SKIP_OUTCOMES as readonly string[]).includes(lastError ?? '');

/** The same rule as a Kysely filter: `status = 'sent'` minus the skips. */
export const whereRealSend = (q: any): any =>
  q
    .where('status', '=', 'sent')
    .where((eb: any) =>
      eb.or([eb('last_error', 'is', null), eb('last_error', 'not in', SKIP_OUTCOMES)]),
    );

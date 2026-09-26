import { SKIP_OUTCOMES } from '@/modules/drivers/linkedin-driver.interface';

/**
 * Did this `sent` row actually send an invite? `sent` also means "skipped"
 * (already_connected / pending), which releases its pacing slot. Invite counters
 * must exclude those; the duplicate-invite guard and upload dedupe count them.
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

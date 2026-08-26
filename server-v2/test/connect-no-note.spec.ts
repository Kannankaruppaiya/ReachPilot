/**
 * LinkedIn "send connection request" — NOTE-LESS flow.
 *
 * SCOPE: only the connect_request path, and only the variant that goes out
 * WITHOUT a personalized note (the "Include a personalized note" toggle OFF in
 * Auto Connect). The with-note cases appear only as controls, to prove the
 * no-note branch is genuinely different rather than accidentally identical.
 *
 * THE CHAIN UNDER TEST
 *   AutoSend (withNote=false) → payload { noNote: true }
 *     → ConnectionNoteService.build()          ⇒ ''            (group A)
 *       → connectWithNoteFallback(driver, target, '')          (group B)
 *         → driver.sendConnectRequest(target, '', ctx)
 *           → outcome classification policy                    (group C)
 *
 * These tests are PURE: no database, no Redis, no browser, and no LinkedIn
 * traffic whatsoever. The driver is a recording fake, so nothing can reach a
 * real account. Pacing (Redis+DB) lives in connect-no-note-pacing.spec.ts and
 * the scheduler gates in connect-no-note-scheduler.spec.ts.
 */
import { ConnectionNoteService } from '@/modules/ai/connection-note.service';
import { connectWithNoteFallback, NOTE_CAP_ERROR } from '@/modules/drivers/connect-with-fallback';
import {
  SKIP_OUTCOMES,
  ACCOUNT_HALT_OUTCOMES,
  TERMINAL_FAIL_OUTCOMES,
} from '@/modules/drivers/linkedin-driver.interface';
import type {
  LinkedInDriver,
  LinkedInActionResult,
  LinkedInActionContext,
} from '@/modules/drivers/linkedin-driver.interface';

const WS = '00000000-0000-0000-0000-0000000000c1';
const TARGET = 'https://www.linkedin.com/in/test-prospect/';

/** Records every sendConnectRequest call so we can assert the note actually sent. */
function makeDriver(...results: LinkedInActionResult[]) {
  const calls: Array<{ target: string; note: string; ctx?: LinkedInActionContext }> = [];
  let i = 0;
  const driver = {
    sendConnectRequest: jest.fn(
      async (target: string, note: string, ctx?: LinkedInActionContext) => {
        calls.push({ target, note, ctx });
        return results[Math.min(i++, results.length - 1)];
      },
    ),
  } as unknown as LinkedInDriver;
  return { driver, calls };
}

const sent = (): LinkedInActionResult => ({ status: 'sent', externalId: 'li_inv_1' });
const noteCapped = (): LinkedInActionResult => ({ status: 'limit_reached', error: NOTE_CAP_ERROR });

describe('Connect request — WITHOUT a personalized note', () => {
  /* ------------------------------------------------------------------ *
   * A. Note resolution — does "no note" really resolve to an empty note?
   * ------------------------------------------------------------------ */
  describe('A. ConnectionNoteService.build() — noNote wins over everything', () => {
    let ai: { generateConnectionNote: jest.Mock };
    let scraper: { scrapeLinkedInProfile: jest.Mock };
    let svc: ConnectionNoteService;

    beforeEach(() => {
      ai = {
        generateConnectionNote: jest.fn(async () => ({ note: 'AI WROTE THIS', source: 'ai' })),
      };
      scraper = { scrapeLinkedInProfile: jest.fn(async () => 'scraped profile text') };
      svc = new ConnectionNoteService(ai as any, scraper as any);
    });

    it('A1: noNote:true returns an empty note even when a template is filled in', async () => {
      const note = await svc.build(WS, {
        noNote: true,
        message: 'Hi {{firstName}}, love your work at {{company}}!',
        name: 'Asha Rao',
      });
      expect(note).toBe('');
    });

    it('A2: noNote:true beats AI + Apify — neither service is even called', async () => {
      const note = await svc.build(WS, {
        noNote: true,
        useAi: true,
        useApify: true,
        aiGuidance: 'be warm and specific',
        message: 'fallback template',
        target: TARGET,
        name: 'Asha Rao',
      });

      expect(note).toBe('');
      // The point of the no-note path: we must not spend an AI call or an Apify
      // scrape credit on a note that will never be sent.
      expect(ai.generateConnectionNote).not.toHaveBeenCalled();
      expect(scraper.scrapeLinkedInProfile).not.toHaveBeenCalled();
    });

    it('A3 (control): without noNote the template IS returned — proving A1/A2 are a real branch', async () => {
      const note = await svc.build(WS, { message: 'Hi there!', name: 'Asha Rao' });
      expect(note).toBe('Hi there!');
    });
  });

  /* ------------------------------------------------------------------ *
   * B. Fallback helper — the no-note branch must be a single clean send
   * ------------------------------------------------------------------ */
  describe('B. connectWithNoteFallback() — empty note goes straight through', () => {
    it('B1: sends exactly once, with an empty note', async () => {
      const { driver, calls } = makeDriver(sent());

      const res = await connectWithNoteFallback(driver, TARGET, '', undefined);

      expect(res.status).toBe('sent');
      expect(driver.sendConnectRequest).toHaveBeenCalledTimes(1);
      expect(calls[0].target).toBe(TARGET);
      expect(calls[0].note).toBe('');
    });

    it('B2: a whitespace-only note counts as NO note (not a blank note send)', async () => {
      const { driver, calls } = makeDriver(sent());

      await connectWithNoteFallback(driver, TARGET, '   \n\t ', undefined);

      expect(driver.sendConnectRequest).toHaveBeenCalledTimes(1);
      // Normalised to a true empty string before it reaches the driver.
      expect(calls[0].note).toBe('');
    });

    it('B3: on the no-note path a note_cap result never triggers a retry', async () => {
      // If the driver somehow reports note_cap for a note-less send, retrying
      // without a note would be identical and would burn a second invite.
      const { driver } = makeDriver(noteCapped());

      const res = await connectWithNoteFallback(driver, TARGET, '', undefined);

      expect(driver.sendConnectRequest).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('limit_reached');
    });

    it('B4: a no-note success is NOT flagged as a fallback', async () => {
      const { driver } = makeDriver(sent());

      const res = await connectWithNoteFallback(driver, TARGET, '', undefined);

      // fellBackToNoNote means "we wanted a note and had to drop it" — it must
      // not appear when the user deliberately chose to send without one.
      expect(res.fellBackToNoNote).toBeUndefined();
    });

    it('B5: passes the action context (li_at/account) through to the driver', async () => {
      const { driver, calls } = makeDriver(sent());
      const ctx = { accountId: 'acct-1', workspaceId: WS, li_at: 'cookie' } as LinkedInActionContext;

      await connectWithNoteFallback(driver, TARGET, '', ctx);

      expect(calls[0].ctx).toBe(ctx);
    });

    it('B6 (control): WITH a note, a note_cap DOES fall back to a note-less retry', async () => {
      const { driver, calls } = makeDriver(noteCapped(), sent());

      const res = await connectWithNoteFallback(driver, TARGET, 'Hi Asha!', undefined);

      expect(driver.sendConnectRequest).toHaveBeenCalledTimes(2);
      expect(calls[0].note).toBe('Hi Asha!'); // first try keeps the note
      expect(calls[1].note).toBe(''); // retry drops it
      expect(res.status).toBe('sent');
      expect(res.fellBackToNoNote).toBe(true);
    });

    it('B7 (control): a plain weekly limit_reached does NOT retry — dropping the note would not help', async () => {
      const { driver } = makeDriver({ status: 'limit_reached' }); // no note_cap error

      const res = await connectWithNoteFallback(driver, TARGET, 'Hi Asha!', undefined);

      expect(driver.sendConnectRequest).toHaveBeenCalledTimes(1);
      expect(res.status).toBe('limit_reached');
      expect(res.fellBackToNoNote).toBeUndefined();
    });
  });

  /* ------------------------------------------------------------------ *
   * C. Outcome policy — how the worker must classify each driver result.
   *
   * These constants ARE the policy the worker switches on, so asserting
   * their membership pins the behaviour: which outcomes skip-and-advance,
   * which pause the whole account, and which fail terminally.
   * ------------------------------------------------------------------ */
  describe('C. Outcome classification policy for a connect result', () => {
    it('C1: "sent" is in no special bucket — it is the normal success path', () => {
      expect(SKIP_OUTCOMES).not.toContain('sent');
      expect(ACCOUNT_HALT_OUTCOMES).not.toContain('sent');
      expect(TERMINAL_FAIL_OUTCOMES).not.toContain('sent');
    });

    it('C2: already_connected skips and advances (must not count as an invite)', () => {
      expect(SKIP_OUTCOMES).toContain('already_connected');
      expect(ACCOUNT_HALT_OUTCOMES).not.toContain('already_connected');
    });

    it('C3: pending (invite already outstanding) skips and advances', () => {
      expect(SKIP_OUTCOMES).toContain('pending');
    });

    it('C4: no_connect_button fails terminally — never retried', () => {
      expect(TERMINAL_FAIL_OUTCOMES).toContain('no_connect_button');
      expect(SKIP_OUTCOMES).not.toContain('no_connect_button');
    });

    it('C5: limit_reached halts the whole account, it is not a per-lead failure', () => {
      expect(ACCOUNT_HALT_OUTCOMES).toContain('limit_reached');
      expect(TERMINAL_FAIL_OUTCOMES).not.toContain('limit_reached');
    });

    it('C6: checkpoint halts the whole account', () => {
      expect(ACCOUNT_HALT_OUTCOMES).toContain('checkpoint');
    });

    it('C7: profile_gone and blocked fail terminally', () => {
      expect(TERMINAL_FAIL_OUTCOMES).toContain('profile_gone');
      expect(TERMINAL_FAIL_OUTCOMES).toContain('blocked');
    });

    it('C8: generic "failed" is retriable — in none of the terminal buckets', () => {
      expect(TERMINAL_FAIL_OUTCOMES).not.toContain('failed');
      expect(ACCOUNT_HALT_OUTCOMES).not.toContain('failed');
      expect(SKIP_OUTCOMES).not.toContain('failed');
    });

    it('C9: the three buckets never overlap (one outcome cannot mean two things)', () => {
      const overlap = (a: readonly string[], b: readonly string[]) => a.filter((x) => b.includes(x));
      expect(overlap(SKIP_OUTCOMES, ACCOUNT_HALT_OUTCOMES)).toEqual([]);
      expect(overlap(SKIP_OUTCOMES, TERMINAL_FAIL_OUTCOMES)).toEqual([]);
      expect(overlap(ACCOUNT_HALT_OUTCOMES, TERMINAL_FAIL_OUTCOMES)).toEqual([]);
    });
  });

  /* ------------------------------------------------------------------ *
   * End-to-end of the pure chain: payload → note → driver call.
   * ------------------------------------------------------------------ */
  describe('D. Chain: a noNote payload reaches the driver as an empty note', () => {
    it('D1: noNote payload → build() → connectWithNoteFallback → one note-less send', async () => {
      const ai = { generateConnectionNote: jest.fn() };
      const scraper = { scrapeLinkedInProfile: jest.fn() };
      const svc = new ConnectionNoteService(ai as any, scraper as any);
      const { driver, calls } = makeDriver(sent());

      // Exactly what the worker does for a connect_request job.
      const payload = {
        noNote: true,
        useAi: true,
        message: 'template that must not be sent',
        name: 'Asha Rao',
        target: TARGET,
      };
      const note = await svc.build(WS, payload);
      const res = await connectWithNoteFallback(driver, payload.target, note, undefined);

      expect(note).toBe('');
      expect(res.status).toBe('sent');
      expect(driver.sendConnectRequest).toHaveBeenCalledTimes(1);
      expect(calls[0].note).toBe('');
      expect(ai.generateConnectionNote).not.toHaveBeenCalled();
    });
  });
});

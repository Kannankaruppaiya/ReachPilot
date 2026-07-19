/**
 * Connect-with-note, with an automatic fall back to a NOTE-LESS connect.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Free LinkedIn accounts allow only a small number of PERSONALIZED-note
 * invitations (a handful per month). Once that quota is spent, the invite
 * composer stops offering a note field and any note-based send is blocked — but
 * a plain connection request WITHOUT a note keeps working, all the way up to the
 * (much larger) weekly invite cap.
 *
 * So instead of stalling outreach the moment the note quota runs out, this
 * helper detects that specific case and retries the SAME lead with no note. It
 * lives in its own file so the fallback policy is easy to find, reason about and
 * tune independently of the (already large) Playwright driver.
 *
 * The driver signals the note quota by returning:
 *     { status: 'limit_reached', error: 'note_cap' }
 * — which is distinct from a general weekly-invite cap (plain 'limit_reached'),
 * where dropping the note would NOT help, so we do not retry there.
 */
import type {
  LinkedInDriver,
  LinkedInActionResult,
  LinkedInActionContext,
} from './linkedin-driver.interface';

/** Minimal logger shape (compatible with NestJS Logger and pino). */
export interface FallbackLogger {
  warn: (obj: unknown, msg?: string) => void;
  log?: (obj: unknown, msg?: string) => void;
}

/** The driver signal that means "the NOTE is capped, but a note-less send may still work". */
export const NOTE_CAP_ERROR = 'note_cap';

/**
 * Send a connection request, preferring the personalized note but automatically
 * dropping it if LinkedIn reports the note quota is exhausted.
 *
 * @returns the driver outcome. On a successful fallback the result carries
 *          `fellBackToNoNote: true` so callers/UI can show the invite went out
 *          without a note.
 */
export async function connectWithNoteFallback(
  driver: LinkedInDriver,
  target: string,
  note: string,
  ctx: LinkedInActionContext | undefined,
  logger?: FallbackLogger,
): Promise<LinkedInActionResult & { fellBackToNoNote?: boolean }> {
  const wantsNote = !!note && !!note.trim();

  // No note requested → this is already a note-less connect; nothing to fall back from.
  if (!wantsNote) {
    return driver.sendConnectRequest(target, '', ctx);
  }

  const withNote = await driver.sendConnectRequest(target, note, ctx);

  // Only fall back on the SPECIFIC note-cap signal. A general 'limit_reached'
  // (weekly invite cap) is left as-is — a note-less retry would hit the same cap.
  if (withNote.status === 'limit_reached' && withNote.error === NOTE_CAP_ERROR) {
    logger?.warn({ target }, 'Personalized-note quota reached — retrying connect WITHOUT a note');
    const noNote = await driver.sendConnectRequest(target, '', ctx);
    return { ...noNote, fellBackToNoNote: true };
  }

  return withNote;
}

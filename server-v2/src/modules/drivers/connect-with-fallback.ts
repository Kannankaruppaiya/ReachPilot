// Connect with a note, retrying without one when the driver reports the note
// quota is spent ({ status: 'limit_reached', error: 'note_cap' }). A plain
// 'limit_reached' is the weekly cap, where dropping the note wouldn't help.
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
 * Send a connection request, dropping the note if the note quota is exhausted.
 * A fallback result carries `fellBackToNoNote: true`.
 */
export async function connectWithNoteFallback(
  driver: LinkedInDriver,
  target: string,
  note: string,
  ctx: LinkedInActionContext | undefined,
  logger?: FallbackLogger,
): Promise<LinkedInActionResult & { fellBackToNoNote?: boolean }> {
  const wantsNote = !!note && !!note.trim();

  if (!wantsNote) {
    return driver.sendConnectRequest(target, '', ctx);
  }

  const withNote = await driver.sendConnectRequest(target, note, ctx);

  // Only on note_cap; a note-less retry would hit the same weekly cap.
  if (withNote.status === 'limit_reached' && withNote.error === NOTE_CAP_ERROR) {
    logger?.warn({ target }, 'Personalized-note quota reached — retrying connect WITHOUT a note');
    const noNote = await driver.sendConnectRequest(target, '', ctx);
    return { ...noNote, fellBackToNoNote: true };
  }

  return withNote;
}

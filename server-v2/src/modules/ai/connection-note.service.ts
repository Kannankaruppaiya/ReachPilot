import { Injectable, Logger } from '@nestjs/common';
import { AiService } from './ai.service';
import { ApifyScrapeService } from './apify-scrape.service';

/** The connect-job payload fields this service reads. */
export interface NotePayload {
  name?: string;
  target?: string; // LinkedIn profile URL
  company?: string;
  role?: string;
  message?: string; // pre-filled template — the fallback
  useAi?: boolean;
  useApify?: boolean;
  aiGuidance?: string; // optional voice/value-prop when AI is on
}

/**
 * Decides what connection note actually gets sent, at send time (in the worker):
 *   - neither toggle → the pre-filled template (`payload.message`)
 *   - AI on          → a unique, human-like note per prospect (Gemini)
 *   - AI + Apify on   → scrape the prospect's LinkedIn profile first, so the note
 *                       is grounded in a real detail about them
 *
 * Always resolves to a sendable string — AiService falls back to a safe template
 * internally, and this falls back to `payload.message` if AI isn't producing.
 */
@Injectable()
export class ConnectionNoteService {
  private readonly logger = new Logger(ConnectionNoteService.name);

  constructor(
    private readonly ai: AiService,
    private readonly scraper: ApifyScrapeService,
  ) {}

  async build(workspaceId: string, payload: NotePayload): Promise<string> {
    if (!payload?.useAi) return payload?.message || '';

    const firstName = String(payload.name || '').trim().split(/\s+/)[0] || 'there';

    let profileContext: string | undefined;
    if (payload.useApify && payload.target) {
      profileContext =
        (await this.scraper.scrapeLinkedInProfile(workspaceId, payload.target).catch(() => null)) || undefined;
      this.logger.log(
        `Note for ${firstName}: AI${profileContext ? ' + Apify profile' : ' (Apify scrape empty → basic)'}`,
      );
    }

    const { note, source } = await this.ai.generateConnectionNote(
      {
        firstName,
        fullName: payload.name,
        title: payload.role,
        company: payload.company,
        profileContext,
      },
      { valueProp: payload.aiGuidance?.trim() || undefined },
    );
    // If the AI degraded to its own generic template and we have a user-authored
    // one, prefer the user's; otherwise use the AI/template note.
    if (source === 'template' && payload.message) return payload.message;
    return note;
  }
}

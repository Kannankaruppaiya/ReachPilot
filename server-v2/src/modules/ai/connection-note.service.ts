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
  noNote?: boolean; // user chose "Send without a note" — skip the note entirely
}

/**
 * The connection note to send, decided in the worker at send time: the template,
 * an AI note (Gemini), or an AI note grounded in the scraped profile (AI + Apify).
 * Always returns a sendable string.
 */
@Injectable()
export class ConnectionNoteService {
  private readonly logger = new Logger(ConnectionNoteService.name);

  constructor(
    private readonly ai: AiService,
    private readonly scraper: ApifyScrapeService,
  ) {}

  async build(workspaceId: string, payload: NotePayload): Promise<string> {
    // "Send without a note" overrides everything; the driver then skips the note flow.
    if (payload?.noNote) return '';
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
    // If the AI fell back to its generic template, prefer the user's own.
    if (source === 'template' && payload.message) return payload.message;
    return note;
  }
}

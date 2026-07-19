import { Body, Controller, Get, Post, BadRequestException } from '@nestjs/common';
import { AiService, LeadContext, CampaignVoice } from './ai.service';

interface PreviewNoteBody {
  lead?: Partial<LeadContext>;
  voice?: CampaignVoice;
}

/**
 * AI personalization endpoints. Protected by the global AuthGuard.
 *
 * `preview-note` is the tuning surface: send a prospect + campaign voice, get a
 * generated note back so you can eyeball tone/length before wiring generation
 * into the campaign enrollment flow. It never sends anything to LinkedIn.
 */
@Controller('api/ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** Whether a Gemini key is configured (UI can show "AI on/off"). */
  @Get('status')
  status() {
    return { configured: this.ai.isConfigured() };
  }

  @Post('preview-note')
  async previewNote(@Body() body: PreviewNoteBody) {
    const lead = body?.lead;
    if (!lead?.firstName || !lead.firstName.trim()) {
      throw new BadRequestException('lead.firstName is required to generate a note.');
    }
    const result = await this.ai.generateConnectionNote(
      {
        firstName: lead.firstName.trim(),
        fullName: lead.fullName,
        title: lead.title,
        company: lead.company,
        location: lead.location,
      },
      body.voice || {},
    );
    return { ...result, chars: result.note.length };
  }
}

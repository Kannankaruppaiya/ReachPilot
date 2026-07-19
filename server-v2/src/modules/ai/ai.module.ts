import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';

/**
 * AI personalization (Google Gemini). Exports AiService so the campaign engine
 * can pre-generate personalized notes at enrollment time; the controller exposes
 * a preview endpoint for tuning tone/length.
 */
@Module({
  controllers: [AiController],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}

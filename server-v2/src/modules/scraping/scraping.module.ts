import { Module } from '@nestjs/common';
import { LeadsModule } from '@/modules/leads/leads.module';
import { AiModule } from '@/modules/ai/ai.module';
import { LeadScraperService } from './lead-scraper.service';
import { ScrapeCursorService } from './scrape-cursor.service';
import { ScrapeJobsService } from './scrape-jobs.service';
import { ScrapingController } from './scraping.controller';

/** Lead scraping: the API endpoint here, the scrape itself in the worker. */
@Module({
  imports: [LeadsModule, AiModule],
  controllers: [ScrapingController],
  providers: [LeadScraperService, ScrapeCursorService, ScrapeJobsService],
  exports: [LeadScraperService, ScrapeCursorService, ScrapeJobsService],
})
export class ScrapingModule {}

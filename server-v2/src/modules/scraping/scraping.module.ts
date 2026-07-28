import { Module } from '@nestjs/common';
import { LeadsModule } from '@/modules/leads/leads.module';
import { LeadScraperService } from './lead-scraper.service';
import { ScrapingController } from './scraping.controller';

/**
 * Free local lead sourcing: a headful stealth (patchright) browser scrapes
 * Google for LinkedIn profiles and imports them via LeadsService. The scrape job
 * itself runs in the worker (browser home); this module wires the API endpoint
 * and exposes LeadScraperService for the worker to resolve.
 */
@Module({
  imports: [LeadsModule],
  controllers: [ScrapingController],
  providers: [LeadScraperService],
  exports: [LeadScraperService],
})
export class ScrapingModule {}

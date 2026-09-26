import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './ai.service';
import { AiAgentService } from './ai-agent.service';
import { ApifyMcpService } from './apify-mcp.service';
import { ApifyScrapeService } from './apify-scrape.service';
import { ConnectionNoteService } from './connection-note.service';
import { AiChatStoreService } from './ai-chat-store.service';
import { VaultModule } from '@/modules/vault/vault.module';

/**
 * AI features on Gemini: AiService (connection notes), AiAgentService (assistant
 * chat with tools), ApifyMcpService (Apify tools for the agent).
 */
@Module({
  imports: [VaultModule],
  controllers: [AiController],
  providers: [
    AiService,
    AiAgentService,
    ApifyMcpService,
    ApifyScrapeService,
    ConnectionNoteService,
    AiChatStoreService,
  ],
  exports: [
    AiService,
    AiAgentService,
    ApifyMcpService,
    ApifyScrapeService,
    ConnectionNoteService,
    AiChatStoreService,
  ],
})
export class AiModule {}

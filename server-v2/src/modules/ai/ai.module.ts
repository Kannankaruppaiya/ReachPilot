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
 * AI features (Google Gemini):
 *  - AiService: single-shot personalized connection notes (campaign engine).
 *  - AiAgentService: agentic chat with tool-calling (the in-app assistant).
 *  - ApifyMcpService: bridges the hosted Apify MCP server's tools into the agent
 *    (needs the vault to decrypt the workspace's Apify token).
 *  Exported so other modules (e.g. Integrations) can reuse them.
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

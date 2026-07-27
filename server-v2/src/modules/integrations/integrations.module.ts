import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GoogleOAuthService } from './google-oauth.service';
import { GmailInboxService } from './gmail-inbox.service';
import { VaultModule } from '@/modules/vault/vault.module';
import { AiModule } from '@/modules/ai/ai.module';

@Module({
  imports: [VaultModule, AiModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, GoogleOAuthService, GmailInboxService],
  exports: [GoogleOAuthService, GmailInboxService, IntegrationsService],
})
export class IntegrationsModule {}

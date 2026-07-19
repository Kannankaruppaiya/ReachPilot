import { Module } from '@nestjs/common';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { GoogleOAuthService } from './google-oauth.service';
import { GmailInboxService } from './gmail-inbox.service';
import { VaultModule } from '@/modules/vault/vault.module';

@Module({
  imports: [VaultModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService, GoogleOAuthService, GmailInboxService],
  exports: [GoogleOAuthService, GmailInboxService, IntegrationsService],
})
export class IntegrationsModule {}

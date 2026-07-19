import { Module } from '@nestjs/common';
import { LinkedinAccountsController } from './linkedin-accounts.controller';
import { LinkedinAccountsService } from './linkedin-accounts.service';
import { EmailAccountsController } from './email-accounts.controller';
import { EmailAccountsService } from './email-accounts.service';
import { ProxiesService } from './proxies.service';
import { VaultModule } from '@/modules/vault/vault.module';
import { AuditModule } from '@/modules/audit/audit.module';
import { WorkspacesModule } from '@/modules/workspaces/workspaces.module';

@Module({
  imports: [VaultModule, AuditModule, WorkspacesModule],
  controllers: [LinkedinAccountsController, EmailAccountsController],
  providers: [LinkedinAccountsService, EmailAccountsService, ProxiesService],
  exports: [LinkedinAccountsService, EmailAccountsService, ProxiesService],
})
export class AccountsModule {}

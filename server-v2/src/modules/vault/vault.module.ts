import { Module } from '@nestjs/common';
import { KeyManagementService } from './key-management.service';
import { SecretsService } from './secrets.service';
import { AuditModule } from '@/modules/audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [KeyManagementService, SecretsService],
  exports: [KeyManagementService, SecretsService],
})
export class VaultModule {}

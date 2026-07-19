import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuditModule } from '@/modules/audit/audit.module';
import { VaultModule } from '@/modules/vault/vault.module';

@Module({
  imports: [AuditModule, VaultModule],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}

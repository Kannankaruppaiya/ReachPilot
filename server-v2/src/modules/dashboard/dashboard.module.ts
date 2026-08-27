import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { AccountsModule } from '@/modules/accounts/accounts.module';
import { EngineModule } from '@/modules/engine/engine.module';

@Module({
  imports: [AccountsModule, EngineModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

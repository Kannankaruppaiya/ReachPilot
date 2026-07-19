import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { AccountsModule } from '@/modules/accounts/accounts.module';

@Module({
  imports: [AccountsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

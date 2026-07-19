import { Module } from '@nestjs/common';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { WorkspacesModule } from '@/modules/workspaces/workspaces.module';
import { AccountsModule } from '@/modules/accounts/accounts.module';
import { LeadsModule } from '@/modules/leads/leads.module';

@Module({
  imports: [WorkspacesModule, AccountsModule, LeadsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}

import { Module } from '@nestjs/common';
import { EngineService } from './engine.service';
import { PacingService } from './pacing.service';
import { GraphExecutor } from './graph-executor';
import { ConditionEvaluator } from './condition-evaluator';
import { SchedulerService } from './scheduler.service';
import { CampaignRunnerService } from './campaign-runner.service';
import { AccountsModule } from '@/modules/accounts/accounts.module';

@Module({
  imports: [AccountsModule],
  providers: [EngineService, PacingService, GraphExecutor, ConditionEvaluator, SchedulerService, CampaignRunnerService],
  exports: [EngineService, PacingService, GraphExecutor, ConditionEvaluator, SchedulerService, CampaignRunnerService],
})
export class EngineModule {}

import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import { HttpExceptionFilter } from '@/common/http-exception.filter';
import { AuthGuard } from '@/common/auth.guard';
import { WorkspaceInterceptor } from '@/common/workspace.interceptor';
import { RateLimiterGuard } from '@/common/rate-limiter.guard';
import { HealthController } from '@/modules/health/health.controller';
import { AuthModule } from '@/modules/auth/auth.module';
import { WorkspacesModule } from '@/modules/workspaces/workspaces.module';
import { VaultModule } from '@/modules/vault/vault.module';
import { AccountsModule } from '@/modules/accounts/accounts.module';
import { OnboardingModule } from '@/modules/onboarding/onboarding.module';
import { LeadsModule } from '@/modules/leads/leads.module';
import { TemplatesModule } from '@/modules/templates/templates.module';
import { CampaignsModule } from '@/modules/campaigns/campaigns.module';
import { JobsModule } from '@/modules/jobs/jobs.module';
import { InboxModule } from '@/modules/inbox/inbox.module';
import { DashboardModule } from '@/modules/dashboard/dashboard.module';
import { WebhooksModule } from '@/modules/webhooks/webhooks.module';
import { NotificationsModule } from '@/modules/notifications/notifications.module';
import { AnalyticsModule } from '@/modules/analytics/analytics.module';
import { BillingModule } from '@/modules/billing/billing.module';
import { ApiKeysModule } from '@/modules/apikeys/apikeys.module';
import { AuditModule } from '@/modules/audit/audit.module';
import { EngineModule } from '@/modules/engine/engine.module';
import { DriversModule } from '@/modules/drivers/drivers.module';
import { IntegrationsModule } from '@/modules/integrations/integrations.module';
import { AiModule } from '@/modules/ai/ai.module';

@Module({
  imports: [
    AuthModule,
    WorkspacesModule,
    VaultModule,
    AccountsModule,
    OnboardingModule,
    LeadsModule,
    TemplatesModule,
    CampaignsModule,
    JobsModule,
    InboxModule,
    DashboardModule,
    WebhooksModule,
    NotificationsModule,
    AnalyticsModule,
    BillingModule,
    ApiKeysModule,
    AuditModule,
    EngineModule,
    DriversModule,
    IntegrationsModule,
    AiModule,
  ],
  controllers: [HealthController],
  providers: [
    Reflector,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RateLimiterGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: WorkspaceInterceptor,
    },
  ],
})
export class AppModule {}

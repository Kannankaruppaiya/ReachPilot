import { Module } from '@nestjs/common';
import { SimulatorDriver } from './simulator.driver';
import { PlaywrightLinkedInDriver } from './playwright-linkedin.driver';
import { GmailDriver } from './gmail.driver';
import { LinkedInSessionService } from './linkedin-session.service';
import { LinkedInSyncService } from './linkedin-sync.service';
import { LINKEDIN_DRIVER, EMAIL_DRIVER } from './driver.tokens';
import { getEnv } from '@/config/env';
import { VaultModule } from '@/modules/vault/vault.module';
import { IntegrationsModule } from '@/modules/integrations/integrations.module';

/**
 * Provides the automation drivers. The concrete LinkedIn/email drivers are
 * chosen at runtime by env (LINKEDIN_DRIVER / EMAIL_DRIVER), so the worker and
 * services depend only on the tokens, never a class.
 */
@Module({
  imports: [VaultModule, IntegrationsModule],
  providers: [
    SimulatorDriver,
    PlaywrightLinkedInDriver,
    GmailDriver,
    LinkedInSessionService,
    LinkedInSyncService,
    {
      provide: LINKEDIN_DRIVER,
      useFactory: (sim: SimulatorDriver, pw: PlaywrightLinkedInDriver) =>
        getEnv().LINKEDIN_DRIVER === 'playwright' ? pw : sim,
      inject: [SimulatorDriver, PlaywrightLinkedInDriver],
    },
    {
      provide: EMAIL_DRIVER,
      useFactory: (sim: SimulatorDriver, gmail: GmailDriver) =>
        getEnv().EMAIL_DRIVER === 'gmail' ? gmail : sim,
      inject: [SimulatorDriver, GmailDriver],
    },
  ],
  exports: [
    LINKEDIN_DRIVER,
    EMAIL_DRIVER,
    LinkedInSessionService,
    LinkedInSyncService,
    SimulatorDriver,
    PlaywrightLinkedInDriver,
    GmailDriver,
  ],
})
export class DriversModule {}

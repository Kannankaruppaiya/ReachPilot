import { Module } from '@nestjs/common';
import { SimulatorDriver } from './simulator.driver';
import { PlaywrightLinkedInDriver } from './playwright-linkedin.driver';
import { RemoteAgentDriver } from './remote-agent.driver';
import { GmailDriver } from './gmail.driver';
import { LinkedInSessionService } from './linkedin-session.service';
import { LinkedInSyncService } from './linkedin-sync.service';
import { EmailWarmupService } from './email-warmup.service';
import { LINKEDIN_DRIVER, EMAIL_DRIVER } from './driver.tokens';
import { getEnv } from '@/config/env';
import { VaultModule } from '@/modules/vault/vault.module';
import { IntegrationsModule } from '@/modules/integrations/integrations.module';

/** Provides the drivers behind DI tokens; LINKEDIN_DRIVER / EMAIL_DRIVER pick the class. */
@Module({
  imports: [VaultModule, IntegrationsModule],
  providers: [
    SimulatorDriver,
    PlaywrightLinkedInDriver,
    RemoteAgentDriver,
    GmailDriver,
    LinkedInSessionService,
    LinkedInSyncService,
    EmailWarmupService,
    {
      provide: LINKEDIN_DRIVER,
      // 'remote' = the user's desktop agent; 'playwright' = a browser here; else the simulator.
      useFactory: (sim: SimulatorDriver, pw: PlaywrightLinkedInDriver, remote: RemoteAgentDriver) => {
        const d = getEnv().LINKEDIN_DRIVER;
        return d === 'remote' ? remote : d === 'playwright' ? pw : sim;
      },
      inject: [SimulatorDriver, PlaywrightLinkedInDriver, RemoteAgentDriver],
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
    EmailWarmupService,
    SimulatorDriver,
    PlaywrightLinkedInDriver,
    RemoteAgentDriver,
    GmailDriver,
  ],
})
export class DriversModule {}

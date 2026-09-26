import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getEnv } from './config/env';
import { AuthService } from './modules/auth/auth.service';
import helmet from 'helmet';
import pino from 'pino';

const logger = pino({ name: 'api-bootstrap' });

// Stay up through transient DB blips (e.g. the pooler dropping a connection);
// the failed query is already reported to its caller.
process.on('unhandledRejection', (reason: any) => {
  logger.warn(`Unhandled rejection (non-fatal): ${reason?.message || reason}`);
});
process.on('uncaughtException', (err: any) => {
  logger.error(`Uncaught exception (kept alive): ${err?.message || err}`);
});

import { assertTenantIsolation } from '@/db/tenant-isolation';
import { getDb } from '@/db';

async function bootstrap() {
  const env = getEnv();
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.enableCors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  if (env.AUTH_BYPASS) {
    logger.info('AUTH_BYPASS is enabled. Provisioning dev user + workspace context...');
    const authService = app.get(AuthService);
    await authService.ensureBypassUser();
  }

  // Verify tenant isolation holds for the role we connect as (see tenant-isolation.ts).
  await assertTenantIsolation(getDb());

  await app.listen(env.PORT);
  logger.info(`ReachPilot Production Backend listening on http://localhost:${env.PORT}`);
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'API bootstrap crashed');
  process.exit(1);
});

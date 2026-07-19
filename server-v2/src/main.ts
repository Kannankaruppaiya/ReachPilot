import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { getEnv } from './config/env';
import { AuthService } from './modules/auth/auth.service';
import helmet from 'helmet';
import pino from 'pino';

const logger = pino({ name: 'api-bootstrap' });

async function bootstrap() {
  const env = getEnv();
  const app = await NestFactory.create(AppModule);

  app.use(helmet());
  app.enableCors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  });

  // Call ensureBypassUser if AUTH_BYPASS is active
  if (env.AUTH_BYPASS) {
    logger.info('AUTH_BYPASS is enabled. Provisioning dev user + workspace context...');
    const authService = app.get(AuthService);
    await authService.ensureBypassUser();
  }

  await app.listen(env.PORT);
  logger.info(`ReachPilot Production Backend listening on http://localhost:${env.PORT}`);
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'API bootstrap crashed');
  process.exit(1);
});

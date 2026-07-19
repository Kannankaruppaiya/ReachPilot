import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LINKEDIN_DRIVER } from '../src/modules/drivers/driver.tokens';

const EMAIL = process.argv[2];
const PASSWORD = process.argv[3];
const TOTP = process.argv[4]; // optional base32 seed

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule);
  const driver: any = app.get(LINKEDIN_DRIVER);
  console.log('login attempt for', EMAIL, 'totp:', !!TOTP);
  const res = await driver.login({
    email: EMAIL,
    password: PASSWORD,
    totpSecret: TOTP,
    fingerprint: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
    // no proxy → direct egress (local IP)
  });
  console.log('=== RESULT ===');
  console.log(JSON.stringify({ status: res.status, hasCookie: !!res.li_at, error: res.error }, null, 2));
  process.exit(0);
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });

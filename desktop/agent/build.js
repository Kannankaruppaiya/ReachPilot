// Bundles the real server driver (playwright-linkedin.driver.ts) into
// agent/driver.bundle.js. NestJS/env/ioredis map to local shims; playwright is
// external (the app provides it).
const esbuild = require('esbuild');
const path = require('path');

const SERVER = path.resolve(__dirname, '../../server-v2/src/modules/drivers');

esbuild.build({
  entryPoints: [path.join(SERVER, 'playwright-linkedin.driver.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  outfile: path.resolve(__dirname, 'driver.bundle.js'),
  external: ['playwright'],
  alias: {
    '@nestjs/common': path.resolve(__dirname, 'shims/nestjs-common.js'),
    '@/config/env': path.resolve(__dirname, 'shims/env.js'),
    ioredis: path.resolve(__dirname, 'shims/ioredis.js'),
  },
  tsconfigRaw: { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: false } },
  logLevel: 'info',
})
  .then(() => console.log('✓ driver.bundle.js built (real PlaywrightLinkedInDriver reused)'))
  .catch((e) => { console.error(e); process.exit(1); });

// Bundles the REAL server driver (playwright-linkedin.driver.ts) for the desktop
// agent — no code duplication. NestJS/env/ioredis are aliased to local shims;
// playwright stays external (provided by the desktop app at runtime). Output:
// agent/driver.bundle.js, requirable from the Electron main process.
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

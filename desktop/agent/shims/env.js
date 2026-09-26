// Shim for @/config/env: only the fields the driver reads. Headless follows the
// dashboard's "Show the browser window" toggle (main.js sets it per job); unset =
// headed.
function getEnv() {
  return {
    PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS === '1',
    PLAYWRIGHT_SLOWMO_MS: 0,
    REDIS_URL: 'inmemory://local',
  };
}
module.exports = { getEnv };

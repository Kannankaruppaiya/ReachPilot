// Shim for @/config/env — the driver reads only these fields. On the desktop the
// browser is headful (real Chrome on the user's machine) and Redis is in-memory.
function getEnv() {
  return {
    PLAYWRIGHT_HEADLESS: false,
    PLAYWRIGHT_SLOWMO_MS: 0,
    REDIS_URL: 'inmemory://local',
  };
}
module.exports = { getEnv };

// Shim for @/config/env — the driver reads only these fields. Redis is in-memory
// on the desktop. Headed/headless comes from the dashboard's "Show the browser
// window" toggle, which main.js mirrors into process.env before each job; unset
// = headed, the long-standing default (a visible real Chrome is the least
// bot-flagged, and the user can watch what the agent does on their account).
function getEnv() {
  return {
    PLAYWRIGHT_HEADLESS: process.env.PLAYWRIGHT_HEADLESS === '1',
    PLAYWRIGHT_SLOWMO_MS: 0,
    REDIS_URL: 'inmemory://local',
  };
}
module.exports = { getEnv };

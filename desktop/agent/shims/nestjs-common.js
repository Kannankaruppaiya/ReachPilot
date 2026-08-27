// Shim for @nestjs/common — the reused server driver only needs Injectable
// (a no-op decorator here) and Logger (mapped to console). No DI container.
function Injectable() {
  return function () {}; // no-op class decorator
}
// Nest's Logger takes (payload, message) — forward BOTH. Keeping only the first
// arg dropped the message half of every `logger.log({ data }, 'what happened')`
// in the driver, which is the half that says which branch ran.
class Logger {
  constructor(context) { this.context = context || ''; }
  log(...a) { console.log(`[${this.context}]`, ...a); }
  warn(...a) { console.warn(`[${this.context}]`, ...a); }
  error(...a) { console.error(`[${this.context}]`, ...a); }
  debug(...a) { console.debug(`[${this.context}]`, ...a); }
  verbose(...a) { console.log(`[${this.context}]`, ...a); }
}
module.exports = { Injectable, Logger };

// Shim for @nestjs/common: Injectable is a no-op, Logger maps to console.
function Injectable() {
  return function () {}; // no-op class decorator
}
// Forward both (payload, message) args; the message says which branch ran.
class Logger {
  constructor(context) { this.context = context || ''; }
  log(...a) { console.log(`[${this.context}]`, ...a); }
  warn(...a) { console.warn(`[${this.context}]`, ...a); }
  error(...a) { console.error(`[${this.context}]`, ...a); }
  debug(...a) { console.debug(`[${this.context}]`, ...a); }
  verbose(...a) { console.log(`[${this.context}]`, ...a); }
}
module.exports = { Injectable, Logger };

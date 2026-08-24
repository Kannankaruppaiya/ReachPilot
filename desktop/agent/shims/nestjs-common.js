// Shim for @nestjs/common — the reused server driver only needs Injectable
// (a no-op decorator here) and Logger (mapped to console). No DI container.
function Injectable() {
  return function () {}; // no-op class decorator
}
class Logger {
  constructor(context) { this.context = context || ''; }
  log(m) { console.log(`[${this.context}]`, m); }
  warn(m) { console.warn(`[${this.context}]`, m); }
  error(m) { console.error(`[${this.context}]`, m); }
  debug(m) { console.debug(`[${this.context}]`, m); }
  verbose(m) { console.log(`[${this.context}]`, m); }
}
module.exports = { Injectable, Logger };

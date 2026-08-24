// Minimal in-memory ioredis shim. The desktop agent is a SINGLE process running a
// SINGLE user's account, so an in-process lock correctly serializes concurrent
// browser opens (the only thing the driver uses Redis for). Supports the exact
// commands the driver calls: set (NX/PX/EX), get, del, eval (compare-and-delete).
class Redis {
  constructor() { this.store = new Map(); }

  _live(key) {
    const cur = this.store.get(key);
    if (!cur) return null;
    if (cur.exp && cur.exp < Date.now()) { this.store.delete(key); return null; }
    return cur;
  }

  async set(key, val, ...args) {
    const hasNX = args.includes('NX');
    let ttl = 0;
    const px = args.indexOf('PX'); if (px >= 0) ttl = Number(args[px + 1]);
    const ex = args.indexOf('EX'); if (ex >= 0) ttl = Number(args[ex + 1]) * 1000;
    if (hasNX && this._live(key)) return null; // NX: fail if key exists
    this.store.set(key, { val, exp: ttl ? Date.now() + ttl : 0 });
    return 'OK';
  }

  async get(key) { const c = this._live(key); return c ? c.val : null; }
  async del(key) { return this.store.delete(key) ? 1 : 0; }

  // The driver's only eval is a compare-and-delete: del key iff its value == token.
  async eval(_lua, _numKeys, key, token) {
    if ((await this.get(key)) === token) { this.store.delete(key); return 1; }
    return 0;
  }

  async quit() {}
  on() { return this; }
  disconnect() {}
}
module.exports = Redis;
module.exports.default = Redis;

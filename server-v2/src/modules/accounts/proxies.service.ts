import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';

@Injectable()
export class ProxiesService {
  /**
   * Assign a REAL, country-matched proxy to an account. The dev seed proxies
   * (provider = 'simulator') are ignored — they're fake/unroutable, and in
   * local-IP mode we want NO proxy so egress uses the machine's own IP.
   *
   * Returns null when no real proxy exists → the account gets proxy_id = null
   * (multiple nulls are allowed by the unique constraint) and the driver routes
   * directly. Wire a residential proxy provider for production/scale.
   */
  async assignProxy(country: string): Promise<{ id: string; ip: string; country: string } | null> {
    const db = getDb();
    const cc = country.toUpperCase().substring(0, 2);

    let proxy = await db
      .selectFrom('proxies')
      .selectAll()
      .where('healthy', '=', true)
      .where('provider', '!=', 'simulator')
      .where('country', '=', cc)
      .limit(1)
      .executeTakeFirst();

    if (!proxy) {
      proxy = await db
        .selectFrom('proxies')
        .selectAll()
        .where('healthy', '=', true)
        .where('provider', '!=', 'simulator')
        .limit(1)
        .executeTakeFirst();
    }

    if (!proxy) return null; // local-IP mode — no proxy assigned

    return { id: proxy.id, ip: String(proxy.ip), country: proxy.country };
  }
}

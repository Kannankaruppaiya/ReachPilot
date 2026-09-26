import { Injectable } from '@nestjs/common';
import { getDb } from '@/db';

@Injectable()
export class ProxiesService {
  /**
   * Assign a real, country-matched proxy (fake 'simulator' ones are ignored).
   * Returns null when there is none, and the account egresses directly.
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

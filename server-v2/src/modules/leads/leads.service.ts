import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { withWorkspace } from '@/db/rls';

/** Bulk-insert chunk size — one round-trip per chunk instead of per row. */
const IMPORT_CHUNK = 500;

@Injectable()
export class LeadsService {
  /**
   * List leads. Backward-compatible: with no options it returns every lead (as
   * before, so callers like Campaigns keep working). With pagination/filter/sort
   * options it returns just that page — how the Leads screen handles large sets.
   */
  async list(
    workspaceId: string,
    opts: {
      limit?: number;
      offset?: number;
      q?: string;
      status?: string;
      source?: string;
      sort?: 'recent' | 'score';
      scrapeJobId?: string;
    } = {},
  ): Promise<any[]> {
    const rows = await withWorkspace(workspaceId, async (db) => {
      let query = db.selectFrom('leads').selectAll();

      if (opts.scrapeJobId) query = query.where('scrape_job_id', '=', opts.scrapeJobId);
      if (opts.status) query = query.where('status', '=', opts.status.toLowerCase());
      if (opts.source) query = query.where('source', 'ilike', `%${opts.source}%`);
      if (opts.q) {
        const like = `%${opts.q}%`;
        query = query.where((eb) =>
          eb.or([
            eb('full_name', 'ilike', like),
            eb('company', 'ilike', like),
            eb('title', 'ilike', like),
          ]),
        );
      }

      query =
        opts.sort === 'score'
          ? query.orderBy(sql`fit_score desc nulls last`).orderBy('created_at', 'desc')
          : query.orderBy('created_at', 'desc');

      if (opts.limit && opts.limit > 0) {
        query = query.limit(Math.min(opts.limit, 200)).offset(Math.max(opts.offset || 0, 0));
      }

      return query.execute();
    });
    return rows.map((r) => this.mapToFrontend(r));
  }

  async update(workspaceId: string, id: string, data: any): Promise<any> {
    return withWorkspace(workspaceId, async (db) => {
      const existing = await db
        .selectFrom('leads')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) {
        throw new NotFoundException('Lead not found.');
      }

      const updates: Record<string, any> = {};
      if (data.status !== undefined) updates.status = data.status.toLowerCase();
      if (data.tags !== undefined) updates.tags = data.tags;
      if (data.lastActivity !== undefined) updates.last_activity = data.lastActivity;

      if (Object.keys(updates).length > 0) {
        await db.updateTable('leads').set(updates).where('id', '=', id).execute();
      }

      const updated = await db
        .selectFrom('leads')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      return this.mapToFrontend(updated);
    });
  }

  /** The stable /in/<slug> handle, lowercased — subdomain-agnostic dedup key. */
  private slugOf(url: string): string | null {
    const m = (url || '').match(/linkedin\.com\/in\/([^/?#]+)/i);
    return m ? m[1].toLowerCase() : null;
  }

  /**
   * Import scraped/CSV leads at scale. Bulk ON CONFLICT upsert (one round-trip per
   * chunk, not per row) keyed on the normalized `linkedin_slug` so in./www. forms
   * of the same profile collapse to one row; email-only rows upsert on email.
   * Race-safe (relies on the DB unique indexes, not a read-then-write check).
   */
  async importLeads(
    workspaceId: string,
    source: string,
    rows: any[],
    scrapeJobId?: string,
  ): Promise<{ count: number }> {
    return withWorkspace(workspaceId, async (db) => {
      // Normalize + in-batch dedup (a batch can contain the same profile twice).
      const bySlug = new Map<string, any>();
      const emailOnly: any[] = [];
      for (const row of rows) {
        const name = String(row.name || '').trim();
        if (!name) continue;
        const rawTarget = String(row.target || row.linkedinUrl || '').trim();
        // Add a protocol if a bare linkedin.com URL slipped in, so a lead never
        // stores/serves a relative URL (→ app-domain 404 on "Open").
        const target =
          rawTarget && !/^https?:\/\//i.test(rawTarget) && rawTarget.includes('linkedin.com')
            ? `https://${rawTarget.replace(/^\/+/, '')}`
            : rawTarget;
        const email = String(row.email || '').trim().toLowerCase();
        const isEmail = /@/.test(email);
        const slug = target.includes('linkedin.com') ? this.slugOf(target) : null;
        if (!slug && !isEmail) continue; // no dedup key → skip (unchanged behaviour)

        const data: any = {
          workspace_id: workspaceId,
          full_name: name,
          first_name: name.split(' ')[0] || '',
          title: String(row.role || row.title || '').trim(),
          company: String(row.company || '').trim(),
          location: String(row.location || '').trim(),
          linkedin_url: slug ? `https://www.linkedin.com/in/${slug}` : null,
          linkedin_slug: slug,
          email: isEmail ? email : null,
          email_verified: isEmail,
          fit_score: typeof row.fitScore === 'number' ? row.fitScore : null,
          status: 'new',
          source,
          scrape_job_id: scrapeJobId ?? null,
          tags: row.tags || [],
          last_activity: 'Imported',
        };
        if (slug) bySlug.set(slug, data);
        else emailOnly.push(data);
      }

      let affected = 0;

      // Upsert LinkedIn rows on the slug index. doUpdateSet refreshes the mutable
      // fields but preserves the user's own status/tags on an existing lead.
      const slugRows = [...bySlug.values()];
      for (let i = 0; i < slugRows.length; i += IMPORT_CHUNK) {
        const res = await db
          .insertInto('leads')
          .values(slugRows.slice(i, i + IMPORT_CHUNK))
          .onConflict((oc) =>
            oc
              .columns(['workspace_id', 'linkedin_slug'])
              .where('linkedin_slug', 'is not', null)
              .doUpdateSet((eb) => ({
                full_name: eb.ref('excluded.full_name'),
                first_name: eb.ref('excluded.first_name'),
                title: eb.ref('excluded.title'),
                company: eb.ref('excluded.company'),
                location: eb.ref('excluded.location'),
                linkedin_url: eb.ref('excluded.linkedin_url'),
                source: eb.ref('excluded.source'),
                last_activity: eb.ref('excluded.last_activity'),
                updated_at: sql`now()`,
              })),
          )
          .executeTakeFirst();
        affected += Number(res?.numInsertedOrUpdatedRows ?? 0);
      }

      // Email-only rows (e.g. CSV) upsert on the email index.
      for (let i = 0; i < emailOnly.length; i += IMPORT_CHUNK) {
        const res = await db
          .insertInto('leads')
          .values(emailOnly.slice(i, i + IMPORT_CHUNK))
          .onConflict((oc) =>
            oc
              .columns(['workspace_id', 'email'])
              .where('email', 'is not', null)
              .doUpdateSet((eb) => ({
                full_name: eb.ref('excluded.full_name'),
                title: eb.ref('excluded.title'),
                company: eb.ref('excluded.company'),
                location: eb.ref('excluded.location'),
                source: eb.ref('excluded.source'),
                last_activity: eb.ref('excluded.last_activity'),
                updated_at: sql`now()`,
              })),
          )
          .executeTakeFirst();
        affected += Number(res?.numInsertedOrUpdatedRows ?? 0);
      }

      const label = source.startsWith('google-scrape') ? 'lead scrape' : 'import';
      await db
        .insertInto('activity')
        .values({ workspace_id: workspaceId, text: `Imported ${affected} leads from ${label}`, tone: 'accent' })
        .execute();

      return { count: affected };
    });
  }

  private mapToFrontend(r: any) {
    return {
      id: r.id,
      name: r.full_name,
      firstName: r.first_name,
      title: r.title,
      company: r.company,
      location: r.location,
      linkedinUrl: r.linkedin_url || '',
      email: r.email || '',
      emailVerified: r.email_verified,
      status: r.status.charAt(0).toUpperCase() + r.status.slice(1),
      source: r.source,
      tags: r.tags || [],
      fitScore: r.fit_score ?? null,
      lastActivity: r.last_activity,
      scrapeJobId: r.scrape_job_id ?? null,
      createdAt: r.created_at,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { withWorkspace } from '@/db/rls';

export interface ScrapeJobCounts {
  raw?: number;
  valid?: number;
  imported?: number;
}

/**
 * Tracks each lead-scrape RUN so the UI can show live progress and a history of
 * past scrapes (titles, status, how many leads landed) — the same way the
 * Assistant lists past conversations. The row is created by the controller,
 * advanced by the worker, and read by the Leads screen.
 */
@Injectable()
export class ScrapeJobsService {
  async create(
    workspaceId: string,
    input: { titles: string[]; location?: string; maxResults: number },
  ): Promise<string> {
    return withWorkspace(workspaceId, async (db) => {
      const row = await db
        .insertInto('scrape_jobs')
        .values({
          workspace_id: workspaceId,
          titles: JSON.stringify(input.titles),
          location: input.location ?? null,
          max_results: input.maxResults,
          status: 'queued',
          counts: '{}',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id as string;
    });
  }

  /** Best-effort progress update from the worker — never throws to the caller. */
  async update(
    workspaceId: string,
    id: string,
    patch: { status?: string; stage?: string; counts?: ScrapeJobCounts; reason?: string | null },
  ): Promise<void> {
    if (!id) return;
    try {
      await withWorkspace(workspaceId, (db) =>
        db
          .updateTable('scrape_jobs')
          .set({
            ...(patch.status !== undefined ? { status: patch.status } : {}),
            ...(patch.stage !== undefined ? { stage: patch.stage } : {}),
            ...(patch.counts !== undefined ? { counts: JSON.stringify(patch.counts) } : {}),
            ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
            updated_at: sql`now()`,
          })
          .where('id', '=', id)
          .execute(),
      );
    } catch {
      /* progress tracking is best-effort */
    }
  }

  async list(workspaceId: string, limit = 20): Promise<any[]> {
    const rows = await withWorkspace(workspaceId, (db) =>
      db
        .selectFrom('scrape_jobs')
        .selectAll()
        .orderBy('created_at', 'desc')
        .limit(Math.min(Math.max(limit, 1), 50))
        .execute(),
    );
    return rows.map((r) => this.map(r));
  }

  async get(workspaceId: string, id: string): Promise<any | null> {
    const row = await withWorkspace(workspaceId, (db) =>
      db.selectFrom('scrape_jobs').selectAll().where('id', '=', id).executeTakeFirst(),
    );
    return row ? this.map(row) : null;
  }

  private map(r: any) {
    return {
      id: r.id,
      titles: Array.isArray(r.titles) ? r.titles : [],
      location: r.location,
      maxResults: r.max_results,
      status: r.status,
      stage: r.stage,
      counts: r.counts || {},
      reason: r.reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }
}

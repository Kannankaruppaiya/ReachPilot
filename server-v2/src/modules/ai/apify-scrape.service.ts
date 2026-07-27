import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '@/config/env';
import { withWorkspace } from '@/db/rls';
import { SecretsService } from '@/modules/vault/secrets.service';

/**
 * Runs the workspace's Apify LinkedIn profile scraper (default
 * `harvestapi/linkedin-profile-scraper`) to enrich a prospect before the AI
 * writes their connection note. Direct Apify REST (not MCP) because this runs in
 * the worker, per connect job — a synchronous actor run that returns the dataset.
 *
 * Best-effort by design: any failure (no token, actor error, timeout) returns
 * null so the caller falls back to a name/role/company note. Never throws.
 */
@Injectable()
export class ApifyScrapeService {
  private readonly logger = new Logger(ApifyScrapeService.name);

  constructor(private readonly secrets: SecretsService) {}

  /** The workspace's decrypted Apify token, or null if Apify isn't connected. */
  private async token(workspaceId: string): Promise<string | null> {
    const row = await withWorkspace(workspaceId, async (db) =>
      db
        .selectFrom('integrations')
        .select('credentials_secret_id')
        .where('provider', '=', 'apify')
        .where('active', '=', true)
        .executeTakeFirst(),
    );
    if (!row?.credentials_secret_id) return null;
    return this.secrets.decrypt(row.credentials_secret_id, { workspaceId }).catch(() => null);
  }

  /**
   * Scrape one LinkedIn profile and return a compact, model-ready summary
   * (headline, about, location, current role, skills). Null on any failure.
   */
  async scrapeLinkedInProfile(workspaceId: string, profileUrl: string): Promise<string | null> {
    const url = (profileUrl || '').trim();
    if (!/\/in\//i.test(url)) return null; // only real profile URLs

    const token = await this.token(workspaceId);
    if (!token) return null;

    const env = getEnv();
    const actorPath = env.APIFY_LINKEDIN_ACTOR.replace('/', '~'); // owner/name → owner~name
    const endpoint = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
    const input: Record<string, unknown> = {
      [env.APIFY_LINKEDIN_INPUT_KEY]: [url],
      profileScraperMode: env.APIFY_LINKEDIN_MODE,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000); // scrapes can be slow
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        this.logger.warn(`Apify scrape ${res.status} for ${url}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
        return null;
      }
      const items = (await res.json()) as any[];
      const profile = Array.isArray(items) ? items[0] : null;
      if (!profile) return null;
      return this.summarize(profile);
    } catch (e: any) {
      this.logger.warn(`Apify scrape failed for ${url}: ${String(e?.message || e)}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Reduce a scraper dataset item to a few lines the note writer can use. */
  private summarize(p: any): string | null {
    const lines: string[] = [];
    const headline = p.headline || p.occupation || p.subTitle;
    if (headline) lines.push(`Headline: ${String(headline).slice(0, 200)}`);
    if (p.location || p.locationName) lines.push(`Location: ${p.location || p.locationName}`);

    // Current role — first experience entry, across the shapes different actors use.
    const exp = Array.isArray(p.experience) ? p.experience : Array.isArray(p.positions) ? p.positions : [];
    const cur = exp[0];
    if (cur) {
      const title = cur.title || cur.position || cur.role;
      const company = cur.company || cur.companyName || cur.organisation;
      if (title || company) lines.push(`Current: ${[title, company].filter(Boolean).join(' at ')}`);
    }

    const about = p.about || p.summary;
    if (about) lines.push(`About: ${String(about).replace(/\s+/g, ' ').slice(0, 400)}`);

    const skills = Array.isArray(p.skills)
      ? p.skills.map((s: any) => (typeof s === 'string' ? s : s?.name)).filter(Boolean).slice(0, 8)
      : [];
    if (skills.length) lines.push(`Skills: ${skills.join(', ')}`);

    const text = lines.join('\n').trim();
    return text.length ? text : null;
  }
}

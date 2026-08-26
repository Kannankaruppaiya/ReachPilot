/**
 * Deciding whether we have already invited someone.
 *
 * LinkedIn names a member two ways in URLs: an obfuscated member URN
 * (`/in/ACwAADY3WCIB…`) and a readable vanity slug (`/in/john-doe`). Scraped
 * lists carry both, mixed, and the same list re-exported can differ in case,
 * protocol, country subdomain and tracking parameters. Raw string comparison
 * therefore misses duplicates that are obviously duplicates to a human.
 *
 * Pure, so the policy is testable without a database.
 */

/** One row of an uploaded list, as `createBatch` receives it. */
export interface UploadRow {
  target?: string;
  linkedinUrl?: string;
  [key: string]: unknown;
}

export interface RowSelection<T> {
  kept: T[];
  skipped: T[];
}

/**
 * Reduce a LinkedIn URL to the identity we compare on: the `/in/<slug>` segment,
 * lowercased and stripped of protocol, host, trailing slash, query, fragment and
 * any deeper path.
 *
 * Returns null for anything that is not a profile URL. Callers must treat null
 * as "unknown", never as "no match" — see `selectNewRows`.
 */
export function profileKey(url: string | null | undefined): string | null {
  const raw = (url || '').trim();
  if (!raw) return null;

  // Cut protocol and host without needing a valid absolute URL: scraped lists
  // routinely carry bare `linkedin.com/in/x`, which `new URL()` rejects.
  const withoutScheme = raw.replace(/^[a-z]+:\/\//i, '');
  const match = /(?:^|\.)linkedin\.com\/in\/([^/?#]+)/i.exec(withoutScheme);
  if (!match) return null;

  let slug = match[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Malformed escape sequence — compare the raw slug rather than giving up.
  }
  slug = slug.trim().toLowerCase();
  return slug || null;
}

/**
 * Split an upload into the rows worth queuing and the rows already contacted.
 *
 * A row is skipped when its key is in `sentKeys`, or when an earlier row in the
 * same upload had that key. A row whose URL yields no key is always KEPT:
 * silently discarding input we could not classify would hide a malformed
 * spreadsheet, whereas a kept row fails later with a reason the operator can
 * read.
 */
export function selectNewRows<T extends UploadRow>(
  rows: T[],
  sentKeys: Set<string>,
): RowSelection<T> {
  const kept: T[] = [];
  const skipped: T[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = profileKey(row.target || row.linkedinUrl);
    if (key === null) {
      kept.push(row);
      continue;
    }
    if (sentKeys.has(key) || seen.has(key)) {
      skipped.push(row);
      continue;
    }
    seen.add(key);
    kept.push(row);
  }

  return { kept, skipped };
}

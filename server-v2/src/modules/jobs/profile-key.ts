// Has this person already been invited? LinkedIn URLs name a member by vanity slug
// or obfuscated URN, with varying case, protocol, subdomain and tracking params, so
// raw string comparison misses duplicates. Pure, so the policy is unit-testable.

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
 * Reduce a LinkedIn URL to the lowercased `/in/<slug>` segment. Returns null for
 * non-profile URLs; callers treat null as "unknown", never "no match".
 */
export function profileKey(url: string | null | undefined): string | null {
  const raw = (url || '').trim();
  if (!raw) return null;

  // Strip scheme and host by hand: `new URL()` rejects bare `linkedin.com/in/x`.
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
 * `profileKey` for a bare slug (the shape `resolvedSlug` has), so a slug and its
 * full URL give the same key. `profileKey` stays strict; `selectNewRows` relies on it.
 */
export function profileKeyFromSlug(slug: string | null | undefined): string | null {
  const raw = (slug || '').trim();
  if (!raw) return null;
  // A full URL here would build a doubled URL and a wrong key; parse it directly.
  if (/linkedin\.com\/in\//i.test(raw)) return profileKey(raw);
  return profileKey(`https://www.linkedin.com/in/${raw}`);
}

/**
 * Split an upload into rows to queue and rows already contacted (in `sentKeys`
 * or earlier in the same upload). A row with no key is kept, so a malformed
 * sheet fails later with a readable reason instead of vanishing.
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

/**
 * Profile keys of everyone already sent an invite: the uploaded target and, when
 * recorded, the vanity slug LinkedIn redirected to. Keyed on the profile because
 * connect jobs carry no lead_id.
 */
export function invitedProfileKeys(
  payloads: Iterable<{ target?: string | null; resolvedSlug?: string | null } | null | undefined>,
): Set<string> {
  const keys = new Set<string>();
  for (const p of payloads) {
    if (!p) continue;
    const fromTarget = profileKey(p.target);
    if (fromTarget) keys.add(fromTarget);
    const fromSlug = profileKeyFromSlug(p.resolvedSlug);
    if (fromSlug) keys.add(fromSlug);
  }
  return keys;
}

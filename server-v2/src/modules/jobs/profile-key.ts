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
 * Same identity as `profileKey`, but for a bare vanity slug instead of a URL —
 * the shape `resolvedSlug` actually is (see `slugOf`/`vanityNameOf` in
 * `playwright-linkedin.driver.ts`: both return a bare slug like
 * `'ramcacpa'`, never a URL). `profileKey` requires a literal
 * `linkedin.com/in/` segment and returns null for anything else, so a bare
 * slug passed to it directly is silently dropped — this wraps the slug into
 * the shape `profileKey` already parses, so a bare slug and the equivalent
 * full URL land on the identical key. `profileKey` itself is left untouched:
 * its strictness on unparseable input is load-bearing for `selectNewRows`.
 */
export function profileKeyFromSlug(slug: string | null | undefined): string | null {
  const raw = (slug || '').trim();
  if (!raw) return null;
  // Defence in depth: every producer of `resolvedSlug` today returns a bare
  // slug, but if one ever stored a full URL the concatenation below would build
  // `.../in/https://www.linkedin.com/in/john-doe` and `profileKey` would take
  // `https:` as the slug. That is worse than a miss — it is a wrong key that
  // matches any other doubled URL and never matches the real person. Anything
  // already carrying a `linkedin.com/in/` segment goes straight to `profileKey`.
  if (/linkedin\.com\/in\//i.test(raw)) return profileKey(raw);
  return profileKey(`https://www.linkedin.com/in/${raw}`);
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

/**
 * Every profile we have ALREADY sent a connection request to, as comparable keys.
 *
 * 🔴 The scheduler's duplicate-invite guard used to look this up by `lead_id` —
 * and every connect job ships with `lead_id` NULL (366 of 366 measured on live
 * data), so the lookup compared `lead_id = NULL`, which SQL never reports true.
 * The guard therefore never fired once, and the same person could be invited
 * repeatedly: Dinesh M held three jobs on one target, one of which sent while a
 * later duplicate ran anyway. Key on the profile instead — that identity is
 * always present in the payload.
 *
 * Both forms are indexed: the target as uploaded (often the obfuscated member
 * URN) and, when the send recorded one, the vanity slug LinkedIn redirected to.
 * A later job carrying either form then matches.
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

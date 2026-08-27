/**
 * Uploading a list re-invites everyone on it, because the scheduler's duplicate
 * guard matches on lead_id and spreadsheet rows have none (verified against the
 * live batch of 2026-08-25: all 18 rows had lead_id null). Every duplicate
 * spends weekly invite allowance a new prospect needed, and repeatedly inviting
 * the same member is the pattern automation detection looks for.
 */
import {
  profileKey,
  profileKeyFromSlug,
  selectNewRows,
  type UploadRow,
} from '@/modules/jobs/profile-key';

describe('profileKey', () => {
  it('reduces a full profile URL to its slug', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe')).toBe('john-doe');
  });

  it('lowercases, so the same person written two ways matches', () => {
    expect(profileKey('https://www.linkedin.com/in/John-Doe')).toBe('john-doe');
  });

  it('ignores a trailing slash', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe/')).toBe('john-doe');
  });

  it('ignores query strings and fragments', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe?utm_source=x#exp')).toBe('john-doe');
  });

  it('ignores a country subdomain', () => {
    expect(profileKey('https://in.linkedin.com/in/john-doe')).toBe('john-doe');
  });

  it('accepts a bare URL with no protocol, as scraped lists carry', () => {
    expect(profileKey('linkedin.com/in/john-doe')).toBe('john-doe');
  });

  it('handles the obfuscated member URN form', () => {
    expect(profileKey('https://www.linkedin.com/in/ACwAADY3WCIBhkYYxYlv')).toBe(
      'acwaady3wcibhkyyxylv',
    );
  });

  it('decodes percent-encoding', () => {
    expect(profileKey('https://www.linkedin.com/in/jos%C3%A9-silva')).toBe('josé-silva');
  });

  it('ignores anything after the slug', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe/details/experience/')).toBe(
      'john-doe',
    );
  });

  it('returns null for a URL that is not a profile', () => {
    expect(profileKey('https://www.linkedin.com/company/acme')).toBeNull();
    expect(profileKey('https://example.com/john-doe')).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(profileKey('')).toBeNull();
    expect(profileKey(null)).toBeNull();
    expect(profileKey(undefined)).toBeNull();
  });
});

describe('profileKeyFromSlug', () => {
  // The LinkedIn driver's slugOf/vanityNameOf both return a bare slug like
  // 'ramcacpa' — never a URL — and that bare value is what gets stored as
  // payload.resolvedSlug (see playwright-linkedin.driver.ts). profileKey
  // itself requires a literal `linkedin.com/in/` segment, so feeding it a
  // bare slug directly is the exact bug this helper exists to close.
  it('THE BUG: profileKey alone returns null for a bare slug — no linkedin.com/in/ segment', () => {
    expect(profileKey('ramcacpa')).toBeNull();
  });

  it('normalises a bare vanity slug to the identical key the equivalent full URL produces', () => {
    expect(profileKeyFromSlug('ramcacpa')).toBe(profileKey('https://www.linkedin.com/in/ramcacpa'));
    expect(profileKeyFromSlug('ramcacpa')).toBe('ramcacpa');
  });

  it('lowercases and trims like profileKey does', () => {
    expect(profileKeyFromSlug('Ram-CACPA')).toBe('ram-cacpa');
    expect(profileKeyFromSlug('  ramcacpa  ')).toBe('ramcacpa');
  });

  it('returns null for empty or nullish input, same contract as profileKey', () => {
    expect(profileKeyFromSlug('')).toBeNull();
    expect(profileKeyFromSlug(null)).toBeNull();
    expect(profileKeyFromSlug(undefined)).toBeNull();
  });

  // Defence in depth. Today every producer of resolvedSlug returns a BARE slug,
  // so this cannot happen — but the helper concatenates its argument into
  // `https://www.linkedin.com/in/<slug>`, and a full URL passed in would build
  // `.../in/https://www.linkedin.com/in/john-doe`, whose first path segment is
  // `https:`. That is not a miss, it is a WRONG key that would silently match
  // any other doubled URL and never match the real person. Accept either shape.
  it('a full URL that reaches it anyway yields the same key, not the garbage `https:`', () => {
    expect(profileKeyFromSlug('https://www.linkedin.com/in/john-doe')).toBe('john-doe');
    expect(profileKeyFromSlug('https://www.linkedin.com/in/John-Doe/')).toBe('john-doe');
    expect(profileKeyFromSlug('linkedin.com/in/john-doe')).toBe('john-doe');
    expect(profileKeyFromSlug('https://in.linkedin.com/in/john-doe?utm=x')).toBe('john-doe');
  });

  it('a slug that merely CONTAINS the word linkedin is still treated as a slug', () => {
    expect(profileKeyFromSlug('linkedin-expert')).toBe('linkedin-expert');
  });
});

describe('selectNewRows', () => {
  const row = (target: string, name = ''): UploadRow => ({ target, name });

  it('keeps a profile we have never invited', () => {
    const rows = [row('https://www.linkedin.com/in/john-doe')];

    const { kept, skipped } = selectNewRows(rows, new Set(['someone-else']));

    expect(kept).toEqual(rows);
    expect(skipped).toEqual([]);
  });

  it('THE BUG: skips a profile already sent an invite', () => {
    const rows = [row('https://www.linkedin.com/in/john-doe')];

    const { kept, skipped } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual([]);
    expect(skipped).toEqual(rows);
  });

  it('matches across URL spellings of the same profile', () => {
    // The list carries a bare, capitalised, slash-suffixed URL; the sent job was
    // stored as a canonical one.
    const rows = [row('LinkedIn.com/in/John-Doe/')];

    const { kept } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual([]);
  });

  it('collapses a profile listed twice in one upload', () => {
    const rows = [
      row('https://www.linkedin.com/in/john-doe'),
      row('https://www.linkedin.com/in/John-Doe/'),
    ];

    const { kept, skipped } = selectNewRows(rows, new Set());

    expect(kept).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it('reads the linkedinUrl field when target is absent', () => {
    const rows: UploadRow[] = [{ linkedinUrl: 'https://www.linkedin.com/in/john-doe' }];

    const { kept } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual([]);
  });

  it('KEEPS a row whose URL cannot be parsed, rather than dropping it silently', () => {
    // Discarding input we could not classify would hide a malformed spreadsheet.
    // A kept row fails later with a reason the operator can read.
    const rows = [row('not a url at all')];

    const { kept, skipped } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual(rows);
    expect(skipped).toEqual([]);
  });

  it('keeps every unparseable row, never collapsing them into one', () => {
    const rows = [row(''), row('')];

    expect(selectNewRows(rows, new Set()).kept).toHaveLength(2);
  });

  it('reports every row skipped when the whole list was already contacted', () => {
    const rows = [row('https://www.linkedin.com/in/a'), row('https://www.linkedin.com/in/b')];

    const { kept, skipped } = selectNewRows(rows, new Set(['a', 'b']));

    expect(kept).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('preserves the upload order of the rows it keeps', () => {
    const rows = [
      row('https://www.linkedin.com/in/a'),
      row('https://www.linkedin.com/in/b'),
      row('https://www.linkedin.com/in/c'),
    ];

    const { kept } = selectNewRows(rows, new Set(['b']));

    expect(kept.map((r) => r.target)).toEqual([
      'https://www.linkedin.com/in/a',
      'https://www.linkedin.com/in/c',
    ]);
  });
});

/**
 * Regression: scraped leads carry LinkedIn's OBFUSCATED member-URN profile slug
 * ("/in/ACwAAC551Qg…") instead of a vanity slug. LinkedIn serves the profile but
 * canonicalises the URL to the real vanity, so the Connect anchor's `vanityName`
 * can never equal the pre-redirect URN — the target-identity guard in
 * `sendConnectRequest` then aborted every such invite with
 * `connect_target_mismatch` (observed live on batch ec752579: requested
 * /in/ACwAAC551QgBdRDGE0xFJY0tnumWHwGXroYHyBM, landed /in/ramcacpa, anchor
 * href=/preload/custom-invite/?vanityName=ramcacpa).
 *
 * Pure logic — no DB, no Redis, no browser.
 */
import { slugOf, isOpaqueSlug } from '../src/modules/drivers/playwright-linkedin.driver';

/** Mirrors the driver: requested slug, then re-resolved from the landed URL. */
function resolveTargetSlug(targetUrl: string, landedUrl: string): string {
  const requested = slugOf(targetUrl);
  let targetSlug = isOpaqueSlug(requested) ? '' : requested.toLowerCase();
  if (!targetSlug) {
    const landed = slugOf(landedUrl);
    if (landed && !isOpaqueSlug(landed)) targetSlug = landed.toLowerCase();
  }
  return targetSlug;
}

/** Mirrors the driver's guard: does the anchor's vanityName clear the target? */
function guardAborts(targetSlug: string, vanity: string): boolean {
  return !!(vanity && targetSlug && vanity !== targetSlug);
}

describe('slugOf', () => {
  it('extracts the /in/ segment', () => {
    expect(slugOf('https://www.linkedin.com/in/ramcacpa/')).toBe('ramcacpa');
    expect(slugOf('https://www.linkedin.com/in/m-a-senthil-kumar-06a2ba136')).toBe('m-a-senthil-kumar-06a2ba136');
    expect(slugOf('https://www.linkedin.com/in/ramcacpa?trk=x#foo')).toBe('ramcacpa');
  });
  it('returns empty for a non-profile url', () => {
    expect(slugOf('https://www.linkedin.com/feed/')).toBe('');
  });
});

describe('isOpaqueSlug', () => {
  it('flags the obfuscated member-URN form', () => {
    for (const s of [
      'ACwAAC551QgBdRDGE0xFJY0tnumWHwGXroYHyBM',
      'ACwAADzEbp8Bwi32rEQThCAxuRctGuGRuYpcTw0',
      'ACwAAAVjDzoBtsbUX0YtTSgySnXzmiclgucWIrQ',
      'ACwAAAddCSYBnqOu5qYOWl0dYHgg8trDBNO77gM',
    ]) expect(isOpaqueSlug(s)).toBe(true);
  });
  it('does NOT flag real vanity slugs, including ones starting with "ac"', () => {
    for (const s of [
      'ramcacpa',
      'acamahalakshmi', // real lead slug — must not be mistaken for a URN
      'm-a-senthil-kumar-06a2ba136',
      'ashok-pillai-287b5948',
      'muralipitchai',
    ]) expect(isOpaqueSlug(s)).toBe(false);
  });
});

describe('target-slug resolution (the connect_target_mismatch fix)', () => {
  it('OLD BEHAVIOUR PRESERVED: a vanity targetUrl resolves to itself', () => {
    const slug = resolveTargetSlug(
      'https://www.linkedin.com/in/m-a-senthil-kumar-06a2ba136',
      'https://www.linkedin.com/in/m-a-senthil-kumar-06a2ba136/',
    );
    expect(slug).toBe('m-a-senthil-kumar-06a2ba136');
    expect(guardAborts(slug, 'm-a-senthil-kumar-06a2ba136')).toBe(false);
  });

  it('OLD BEHAVIOUR PRESERVED: a vanity target still aborts on a DIFFERENT person', () => {
    const slug = resolveTargetSlug(
      'https://www.linkedin.com/in/m-a-senthil-kumar-06a2ba136',
      'https://www.linkedin.com/in/m-a-senthil-kumar-06a2ba136/',
    );
    // A "People also viewed" rail anchor — must still be rejected.
    expect(guardAborts(slug, 'some-other-person-999')).toBe(true);
  });

  it('FIXED: an opaque URN target adopts the canonicalised vanity and sends', () => {
    const slug = resolveTargetSlug(
      'https://www.linkedin.com/in/ACwAAC551QgBdRDGE0xFJY0tnumWHwGXroYHyBM',
      'https://www.linkedin.com/in/ramcacpa/',
    );
    expect(slug).toBe('ramcacpa');
    expect(guardAborts(slug, 'ramcacpa')).toBe(false);
  });

  it('FIXED: an opaque URN target still rejects a rail person', () => {
    const slug = resolveTargetSlug(
      'https://www.linkedin.com/in/ACwAAC551QgBdRDGE0xFJY0tnumWHwGXroYHyBM',
      'https://www.linkedin.com/in/ramcacpa/',
    );
    expect(guardAborts(slug, 'someone-else-123')).toBe(true);
  });

  it('no canonicalisation: slug is empty, so the guard stands down (namesTarget still gates)', () => {
    const slug = resolveTargetSlug(
      'https://www.linkedin.com/in/ACwAAC551QgBdRDGE0xFJY0tnumWHwGXroYHyBM',
      'https://www.linkedin.com/in/ACwAAC551QgBdRDGE0xFJY0tnumWHwGXroYHyBM',
    );
    expect(slug).toBe('');
    expect(guardAborts(slug, 'ramcacpa')).toBe(false);
  });

  it('regression: the whole failed batch resolves instead of aborting', () => {
    const batch: [string, string][] = [
      ['ACwAADzEbp8Bwi32rEQThCAxuRctGuGRuYpcTw0', 'ganesh-varma-1a2b3c'],
      ['ACwAAAVjDzoBtsbUX0YtTSgySnXzmiclgucWIrQ', 'govindarajan-k-4d5e6f'],
      ['ACwAAC551QgBdRDGE0xFJY0tnumWHwGXroYHyBM', 'ramcacpa'],
    ];
    for (const [urn, vanity] of batch) {
      const slug = resolveTargetSlug(
        `https://www.linkedin.com/in/${urn}`,
        `https://www.linkedin.com/in/${vanity}/`,
      );
      expect(slug).toBe(vanity);
      expect(guardAborts(slug, vanity)).toBe(false);
    }
  });
});

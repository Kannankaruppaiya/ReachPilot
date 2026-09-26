/**
 * Regression: on the fast confirm path (toast / Pending flip) the page stays on the
 * custom-invite URL, so `slugOf` returned '' and `resolvedSlug` was lost. The
 * driver now falls back to the URL's `vanityName`. Pure logic.
 */
import { resolvedSlugFrom, slugOf, vanityNameOf } from '../src/modules/drivers/playwright-linkedin.driver';

/** The production function, not a local copy, so removing the fallback fails these tests. */
const resolvedSlugOf = resolvedSlugFrom;

describe('vanityNameOf', () => {
  it('extracts the vanityName query param from a custom-invite URL', () => {
    expect(vanityNameOf('https://www.linkedin.com/preload/custom-invite/?vanityName=ramcacpa')).toBe('ramcacpa');
  });
  it('extracts vanityName when other query params are present around it', () => {
    expect(
      vanityNameOf('https://www.linkedin.com/preload/custom-invite/?trk=x&vanityName=ram-cacpa-123&foo=bar'),
    ).toBe('ram-cacpa-123');
  });
  it('returns empty when there is no vanityName param', () => {
    expect(vanityNameOf('https://www.linkedin.com/in/ramcacpa/')).toBe('');
    expect(vanityNameOf('https://www.linkedin.com/feed/')).toBe('');
  });
});

describe('resolvedSlugOf (the fast-path no-op fix)', () => {
  it('the SLOW path (already covered): an /in/<slug> URL resolves via slugOf', () => {
    expect(resolvedSlugOf('https://www.linkedin.com/in/ramcacpa/')).toBe('ramcacpa');
  });

  it('the FAST path (the bug): a custom-invite URL with no /in/ segment now resolves via vanityName', () => {
    const url = 'https://www.linkedin.com/preload/custom-invite/?vanityName=ramcacpa';
    // Would fail if the vanityName fallback were removed — slugOf alone returns ''.
    expect(slugOf(url)).toBe('');
    expect(resolvedSlugOf(url)).toBe('ramcacpa');
  });

  it('produces the SAME normalised shape on both paths, so profileKey sees identical input', () => {
    const viaInUrl = resolvedSlugOf('https://www.linkedin.com/in/ramcacpa/');
    const viaCustomInvite = resolvedSlugOf('https://www.linkedin.com/preload/custom-invite/?vanityName=ramcacpa');
    expect(viaInUrl).toBe(viaCustomInvite);
  });

  it('no-slug case: neither /in/ nor vanityName present returns empty', () => {
    expect(resolvedSlugOf('https://www.linkedin.com/feed/')).toBe('');
  });
});

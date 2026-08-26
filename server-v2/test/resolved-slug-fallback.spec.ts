/**
 * Regression: on the NORMAL fast path for a real top-card Connect, LinkedIn's
 * Connect control resolves as the custom-invite anchor
 * ("/preload/custom-invite/?vanityName=<slug>"). When the invite confirms
 * quickly — an "Invitation sent" toast, or the control flipping to Pending —
 * `sendConnectRequest` returns WITHOUT ever navigating back to an
 * `/in/<slug>` URL (that only happens on the slower "reload and check"
 * confirmation path). `slugOf(page.url())` requires a literal `/in/`
 * segment, so on the fast path it returns '', `resolvedSlug` is silently
 * omitted, and the feature no-ops on exactly the path it was built for.
 *
 * Fix: when the current URL carries no `/in/` segment, fall back to the
 * `vanityName` query parameter of the custom-invite URL — the vanity slug
 * LinkedIn already handed us, read from the URL the page is already on (no
 * extra navigation).
 *
 * Pure logic — no DB, no Redis, no browser.
 */
import { resolvedSlugFrom, slugOf, vanityNameOf } from '../src/modules/drivers/playwright-linkedin.driver';

/**
 * THE PRODUCTION FUNCTION — not a local reimplementation.
 *
 * An earlier version of this spec defined its own `slugOf(url) || vanityNameOf(url)`
 * helper and asserted on that, which meant deleting the fallback from the driver
 * left the whole suite green: the one line that produces a cross-form key on the
 * fast path had no test at all. `sendConnectRequest` now calls
 * `resolvedSlugFrom` at its return site, so these assertions run the real code.
 */
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

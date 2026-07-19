/**
 * Central LinkedIn selector registry + a self-healing resolver.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * LinkedIn ships hashed CSS classes, auto-generated ember IDs, A/B-tested
 * layouts and lazy-loaded content — any single selector breaks on a redesign.
 * The durable pattern (2026 best practice) is a LAYERED CASCADE: try the most
 * meaningful, most stable locator first (visible text / ARIA role), fall back to
 * progressively looser ones, and LOG which tier won so drift is visible before it
 * breaks in production.
 *
 * Instead of scattering these cascades across the 900-line driver, every element
 * the driver needs is defined ONCE here as an ordered list of candidate locators.
 * A LinkedIn redesign is then a one-file edit, not an archaeology dig through the
 * driver. `resolveFirst()` walks the list and returns the first match.
 *
 * Ordering rule (most stable → least):
 *   1. visible TEXT / accessible NAME   (getByRole … { name })   — survives class churn
 *   2. ARIA attributes                  ([aria-label=…])         — a11y is stable
 *   3. data-* / test ids                ([data-test-…])          — semi-stable
 *   4. structural / class hints         (.artdeco-…)             — last resort
 */
import type { Page, Locator } from 'playwright';

/**
 * The scopes a candidate can anchor against.
 *  - `page`  : always present — the whole document.
 *  - `card`  : the profile top-card action bar (the <main> region). Scoping here
 *              avoids matching stray "Connect"/"More" strings in posts, the
 *              "People also viewed" rail, or recent-activity cards.
 *  - `modal` : an open dialog (e.g. the send-invite modal), when one is present.
 * Candidates fall back to `page` when the tighter scope isn't available.
 */
export interface SelectorScope {
  page: Page;
  card?: Locator;
  modal?: Locator;
}

export type Candidate = (s: SelectorScope) => Locator;

/**
 * The connect control's accessible name. LinkedIn labels it "Invite <Name> to
 * connect" (aria-label) while rendering the visible word "Connect". Match the
 * invite phrase as a SUBSTRING (the name/trailing text varies) and "Connect"
 * anchored (so it never catches "Connected" / "Reconnect").
 */
export const CONNECT_NAME = /invite .* to connect|^connect$/i;

// Both Page and Locator expose getByRole/locator with identical signatures, so a
// candidate can anchor against either; the union keeps the fallback-to-page ergonomic.
const scoped = (s: SelectorScope): Page | Locator => s.card ?? s.page;
const modalScoped = (s: SelectorScope): Page | Locator => s.modal ?? s.page;

/**
 * The registry. Each key is an ordered candidate cascade for ONE logical element.
 * Add/adjust selectors here — never inline them back into the driver.
 */
export const SELECTORS = {
  /** The "Connect" button on the profile top card (direct, not via More menu). */
  connectButton: [
    (s) => scoped(s).getByRole('button', { name: CONNECT_NAME }),
    (s) => s.page.getByRole('button', { name: CONNECT_NAME }),
    (s) => scoped(s).locator('button[aria-label*="to connect" i]'),
  ] as Candidate[],

  /** The overflow ("More" / "More actions") button that can hide Connect. */
  moreButton: [
    (s) => scoped(s).getByRole('button', { name: /^More actions$/i }),
    (s) => scoped(s).getByRole('button', { name: /^More$/i }),
    (s) => s.page.getByRole('button', { name: /^More actions$/i }),
  ] as Candidate[],

  /** The Connect item inside the opened overflow dropdown. LinkedIn A/B-tests the
   *  item's element: role=menuitem, role=button, or — very commonly — a plain
   *  <a href="/preload/custom-invite/…"> anchor (role=link). The anchor tiers are
   *  what the deep-link goto path in the driver relies on resolving. */
  connectMenuItem: [
    (s) => s.page.getByRole('menuitem', { name: CONNECT_NAME }),
    (s) => s.page.getByRole('button', { name: CONNECT_NAME }),
    (s) => s.page.getByRole('link', { name: CONNECT_NAME }),
    (s) => s.page.locator('a[href*="custom-invite"]'),
    // Any interactive dropdown item whose visible text is exactly "Connect".
    (s) =>
      s.page
        .locator(
          '[role="menu"] a, [role="menu"] [role], .artdeco-dropdown__content a, .artdeco-dropdown__content [role], .artdeco-dropdown__content li > div',
        )
        .filter({ hasText: /^\s*Connect\s*$/ }),
  ] as Candidate[],

  /** The opened overflow dropdown container (used to verify the menu is open). */
  dropdownContent: [
    (s) => s.page.locator('.artdeco-dropdown__content--is-open'),
    (s) => s.page.getByRole('menu'),
    (s) => s.page.locator('.artdeco-dropdown__content'),
  ] as Candidate[],

  /** "Pending" — an invite is already outstanding to this profile. */
  pendingButton: [
    (s) => scoped(s).getByRole('button', { name: /^Pending$/i }),
    (s) => s.page.getByRole('button', { name: /^Pending$/i }),
  ] as Candidate[],

  /** "Message" — present when already connected / an Open Profile. */
  messageButton: [
    (s) => scoped(s).getByRole('button', { name: /^Message$/i }),
    (s) => s.page.getByRole('button', { name: /^Message$/i }),
  ] as Candidate[],

  /** The confirm/send button inside the send-invite modal. */
  sendInvite: [
    (s) => modalScoped(s).locator('button[aria-label="Send invitation" i]'),
    (s) => modalScoped(s).locator('.artdeco-modal__actionbar button.artdeco-button--primary'),
    (s) => modalScoped(s).getByRole('button', { name: /^Send( invitation)?$/i }),
  ] as Candidate[],

  /** "Add a note" button that reveals the personalization textarea. */
  addNote: [
    (s) => modalScoped(s).getByRole('button', { name: /Add a note/i }),
  ] as Candidate[],

  /** The note textarea inside the send-invite modal. */
  noteBox: [
    (s) => modalScoped(s).locator('textarea[name="message"]'),
    (s) => modalScoped(s).locator('textarea#custom-message'),
    (s) => modalScoped(s).locator('textarea'),
    (s) => modalScoped(s).locator('div[role="textbox"]'),
  ] as Candidate[],

  /** The message composer textbox (DM overlay). */
  messageBox: [
    (s) => s.page.locator('div[role="textbox"]'),
    (s) => s.page.locator('.msg-form__contenteditable'),
  ] as Candidate[],

  /** Send button in the messaging composer. */
  messageSend: [
    (s) => s.page.getByRole('button', { name: /^Send$/ }),
    (s) => s.page.locator('.msg-form__send-button'),
  ] as Candidate[],
} satisfies Record<string, Candidate[]>;

export type SelectorKey = keyof typeof SELECTORS;

/** Minimal logger shape so this module needn't import Nest's Logger. */
export interface DriftLogger {
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * Walk a candidate cascade and return the first locator that actually matches an
 * element on the page (count > 0). Returns null if none match.
 *
 * When a fallback tier wins (tier > 0), it logs a drift warning: the primary
 * selector stopped matching, which usually means LinkedIn shipped a redesign.
 * Piping these warnings to alerting turns "automation silently broke" into "we
 * were told the day the DOM changed".
 */
export async function resolveFirst(
  scope: SelectorScope,
  candidates: Candidate[],
  name: string,
  logger?: DriftLogger,
): Promise<Locator | null> {
  for (let tier = 0; tier < candidates.length; tier++) {
    // CRITICAL: only match VISIBLE elements. LinkedIn ships hidden duplicate
    // controls (a real "Connect" button plus off-screen copies); a bare
    // `.first()` can resolve to a hidden clone, and clicking that either no-ops
    // or — via a force-click fallback — lands at a stale coordinate somewhere
    // else on the page. Filtering to visible picks the button the user sees.
    const loc = candidates[tier](scope).filter({ visible: true }).first();
    const hit = await loc.count().catch(() => 0);
    if (hit > 0) {
      if (tier > 0) {
        logger?.warn(
          { selector: name, tier, of: candidates.length },
          `LinkedIn selector "${name}" healed to fallback tier ${tier} — primary may be stale`,
        );
      }
      return loc;
    }
  }
  return null;
}

/**
 * LinkedIn selector registry. Each element the driver needs is an ordered
 * cascade, most stable first: accessible name → ARIA attributes → data-test ids →
 * class hints. `resolveFirst()` returns the first match and logs when a fallback
 * tier wins, so a LinkedIn redesign shows up in logs and is a one-file fix.
 */
import type { Page, Locator } from 'playwright';

/**
 * Where a candidate can anchor: `page`, `card` (the profile top card, which
 * avoids matching rails and posts) or `modal` (an open dialog). Falls back to `page`.
 */
export interface SelectorScope {
  page: Page;
  card?: Locator;
  modal?: Locator;
  /**
   * The open "More" dropdown. Menu items resolve only inside it, never page-wide
   * (the rails have their own Connect anchors).
   */
  menu?: Locator;
}

export type Candidate = (s: SelectorScope) => Locator;

/**
 * Connect's accessible name: "Invite <Name> to connect" as a substring, or exactly
 * "Connect" (never "Connected" / "Reconnect").
 */
export const CONNECT_NAME = /invite .* to connect|^connect$/i;

const scoped = (s: SelectorScope): Page | Locator => s.card ?? s.page;
const modalScoped = (s: SelectorScope): Page | Locator => s.modal ?? s.page;
// Menu items resolve only inside the open dropdown; deliberately no page fallback.
const menuScoped = (s: SelectorScope): Page | Locator => s.menu ?? s.page;

/** Candidate cascades per element. Add selectors here, never inline in the driver. */
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
    // Page-wide `^More$` too, for when the card scope resolves wrong.
    (s) => s.page.getByRole('button', { name: /^More$/i }),
  ] as Candidate[],

  /**
   * The Connect item in the open dropdown: a menuitem, button, or (commonly) a
   * custom-invite <a>, which the driver's deep-link path relies on.
   */
  connectMenuItem: [
    (s) => menuScoped(s).getByRole('menuitem', { name: CONNECT_NAME }),
    (s) => menuScoped(s).getByRole('button', { name: CONNECT_NAME }),
    (s) => menuScoped(s).getByRole('link', { name: CONNECT_NAME }),
    (s) => menuScoped(s).locator('a[href*="custom-invite"]'),
    // Any interactive dropdown item whose visible text is exactly "Connect".
    (s) =>
      menuScoped(s)
        .locator(
          'a, [role="menuitem"], [role="button"], li > div',
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
 * Return the first candidate that matches a visible element, or null. Logs a
 * drift warning when a fallback tier wins (LinkedIn likely changed the DOM).
 */
export async function resolveFirst(
  scope: SelectorScope,
  candidates: Candidate[],
  name: string,
  logger?: DriftLogger,
): Promise<Locator | null> {
  for (let tier = 0; tier < candidates.length; tier++) {
    // Visible only: LinkedIn ships hidden duplicate controls, and clicking one no-ops
    // or misfires.
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

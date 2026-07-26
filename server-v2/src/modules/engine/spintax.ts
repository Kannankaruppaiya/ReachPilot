/**
 * Spintax renderer — `{Hi|Hey|Hello}` picks one option per render, so every
 * recipient gets a slightly different message and a campaign's sends stop
 * sharing one identical spam-filter fingerprint (Gmail compares message
 * fingerprints across a sender's mail; duplicate bodies read as bulk).
 *
 * - Nested groups are supported: innermost groups resolve first.
 * - `{{variable}}` placeholders are untouched — a group only spins when it
 *   contains a `|` at its own brace level, so run spin() AFTER variable
 *   filling and the two syntaxes never collide.
 * - An empty option (`{a|}`) is allowed and yields an empty string.
 */
export function spin(text: string, rand: () => number = Math.random): string {
  let out = String(text ?? '');
  // Innermost-first: no nested braces inside the group, at least one pipe.
  const group = /\{([^{}]*\|[^{}]*)\}/g;
  let prev: string;
  do {
    prev = out;
    out = out.replace(group, (_, inner: string) => {
      const options = inner.split('|');
      return options[Math.floor(rand() * options.length)] ?? '';
    });
  } while (out !== prev);
  return out;
}

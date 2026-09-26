/**
 * Spintax: `{Hi|Hey|Hello}` picks one option per render so bodies differ (duplicate
 * bodies read as bulk). Nested groups resolve innermost first; `{{variable}}` is
 * untouched (a group spins only with a `|` at its own level), so spin after filling
 * variables. `{a|}` can yield ''.
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

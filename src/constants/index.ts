// App-wide constants. Named values instead of magic numbers scattered through
// the code (see coding-standards: no unexplained literals).

// ── Auth token storage keys (localStorage) ───────────────────────────
export const ACCESS_TOKEN_KEY = "rp_access"
export const REFRESH_TOKEN_KEY = "rp_refresh"

// ── Polling / timing ──────────────────────────────────────────────────
/** App shell re-fetches live account + notifications on this cadence. */
export const SHELL_POLL_INTERVAL_MS = 60_000
/** Auto-dismiss delay for toast notifications. */
export const TOAST_DURATION_MS = 4_000
/** Duration of the count-up animation on stat cards. */
export const COUNT_UP_DURATION_MS = 800

// ── Shared input styling ──────────────────────────────────────────────
export const inputCls =
  "w-full rounded-md border border-line bg-card px-3 py-2.5 text-sm placeholder:text-sub focus:border-accent"

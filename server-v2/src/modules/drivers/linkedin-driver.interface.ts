/**
 * LinkedIn automation driver contract.
 *
 * Two implementations exist:
 *  - SimulatorDriver          — fake, used in dev/tests (no real LinkedIn contact)
 *  - PlaywrightLinkedInDriver  — real headless-browser automation
 *
 * The worker selects one at runtime via the LINKEDIN_DRIVER env var and the
 * LINKEDIN_DRIVER DI token (see drivers.module.ts).
 */
import type { StoredCookie } from './linkedin-session-store';

export type { StoredCookie };

/** Every action resolves to exactly ONE known outcome — never an unclassified crash. */
export type LinkedInOutcome =
  | 'sent' // action performed successfully
  | 'failed' // generic/transient failure — safe to retry
  | 'already_connected' // 1st-degree already — skip, advance
  | 'pending' // invite already outstanding — skip, advance
  | 'no_connect_button' // no Connect available (only Follow/Message) — skip
  | 'limit_reached' // LinkedIn weekly/daily limit hit — pause account
  | 'checkpoint' // CAPTCHA / security challenge — STOP, pause account
  | 'profile_gone' // 404 / deactivated — mark lead dead
  | 'blocked' // we've been blocked by the target — skip
  | 'network_error' // the page never loaded — nothing was clicked, defer and re-drive
  | 'session_expired'; // LinkedIn signed this account out — halt the account, keep the leads

export interface ProxyConfig {
  /** host:port or http://host:port — the egress the browser routes through. */
  server: string;
  username?: string;
  password?: string;
  /** Human-readable dedicated IP (for display/logging). */
  ip?: string;
}

export interface LinkedInFingerprint {
  userAgent?: string;
  locale?: string; // e.g. 'en-IN' — must match proxy geo
  timezoneId?: string; // e.g. 'Asia/Kolkata' — must match proxy geo
  viewport?: { width: number; height: number };
}

/** Everything a driver needs to act AS an account (built per job by LinkedInSessionService). */
export interface LinkedInActionContext {
  accountId?: string;
  workspaceId?: string;
  /** The li_at session cookie — the "logged-in" state. Kept for the desktop
   *  agent wire and for accounts stored before `cookies` existed. */
  li_at?: string;
  /** The FULL captured jar. `li_at` alone cannot hold a LinkedIn session (it
   *  redirect-loops without JSESSIONID/bcookie/liap), so this is what actually
   *  restores one on a fresh profile. See `linkedin-session-store.ts`. */
  cookies?: StoredCookie[];
  proxy?: ProxyConfig;
  fingerprint?: LinkedInFingerprint;
}

export interface LinkedInActionResult {
  status: LinkedInOutcome;
  externalId?: string;
  error?: string;
  /** Public egress IP the desktop agent ran this action from (ipify echo). */
  reportedIp?: string;
  /**
   * The vanity slug LinkedIn actually served, when the requested URL was an
   * obfuscated member URN. Captured free at send time — resolving it later would
   * mean loading one profile per row, which is exactly the traffic shape that
   * gets an account challenged. Lets a future upload recognise this member under
   * either URL form.
   */
  resolvedSlug?: string;
}

/** Everything needed to log in ONCE and capture the session cookie. */
export interface LinkedInLoginContext {
  accountId?: string;
  workspaceId?: string;
  email: string;
  password: string;
  /** base32 TOTP seed — lets the driver answer 2FA challenges itself. */
  totpSecret?: string;
  proxy?: ProxyConfig;
  fingerprint?: LinkedInFingerprint;
}

export interface LinkedInLoginResult {
  status: 'connected' | 'checkpoint' | 'failed';
  /** Captured session cookie on success. Caller encrypts + stores it. */
  li_at?: string;
  /** The whole jar captured alongside `li_at` — what the caller should actually
   *  persist, so a fresh profile can be restored rather than redirect-looping. */
  cookies?: StoredCookie[];
  fingerprint?: LinkedInFingerprint;
  error?: string;
  /** Public egress IP the desktop agent logged in from (ipify echo). */
  reportedIp?: string;
}

/** One connection whose invite was accepted since we last synced. */
export interface AcceptedConnection {
  /** The lead's profile URL (how we match back to our `leads` row). */
  profileUrl: string;
}

/** One inbound reply detected in the account's messaging. */
export interface InboundReply {
  /** The sender's profile URL, when resolvable. */
  profileUrl?: string;
  /** The sender's display name (fallback match when the URL isn't available). */
  fromName?: string;
  /** The message text. */
  text: string;
  /** LinkedIn's own id for the message, for idempotency. */
  externalId?: string;
}

/** Result of a per-account sync pass (acceptance + reply detection). */
export interface LinkedInSyncResult {
  /** True if a security checkpoint blocked the sync — caller should pause the account. */
  checkpoint?: boolean;
  /** Invites accepted since the last sync. */
  accepted: AcceptedConnection[];
  /** New inbound replies since the last sync. */
  replies: InboundReply[];
  /** Non-fatal error string if the sync partially failed. */
  error?: string;
}

/** Outcomes that mean "advance the sequence, don't count as a failure or a send". */
export const SKIP_OUTCOMES: LinkedInOutcome[] = ['already_connected', 'pending'];
/** Outcomes that must pause the whole account, not just fail the one job. */
/**
 * Outcomes that must pause the whole account, not just fail the one job.
 *
 * 🔴 `session_expired` belongs here and NOT in TERMINAL_FAIL_OUTCOMES. A signed-out
 * account fails EVERY job it is handed, so classifying it per-lead burns the whole
 * queue over one dead cookie. Observed live on narmatha@rjpinfotek.ooo: the vault
 * held a legacy bare `li_at` (no JSESSIONID/bcookie/liap), LinkedIn had already
 * invalidated it, and 15 consecutive invites died as `ERR_TOO_MANY_REDIRECTS` —
 * a raw Playwright string in `last_error`, no notification, and the account stuck
 * at status='connecting' with nothing telling the user to reconnect.
 */
export const ACCOUNT_HALT_OUTCOMES: LinkedInOutcome[] = [
  'checkpoint',
  'limit_reached',
  'session_expired',
];
/** Terminal per-lead failures — mark failed but do NOT retry.
 *  `network_error` is deliberately NOT here: it means we never got a usable page,
 *  so nothing was clicked and nothing was sent. Treating a bad connection as a
 *  terminal verdict about the LEAD is how a slow link permanently burned live
 *  prospects — the worker defers it instead (see DEFER_OUTCOMES). */
export const TERMINAL_FAIL_OUTCOMES: LinkedInOutcome[] = [
  'no_connect_button',
  'profile_gone',
  'blocked',
];
/** Outcomes that mean "the executor couldn't run, not that the lead is bad" —
 *  reschedule with a backoff; never fail the job, never burn a BullMQ attempt. */
export const DEFER_OUTCOMES: LinkedInOutcome[] = ['network_error'];

/**
 * How many times one job may be deferred as `network_error` before we stop.
 *
 * 🔴 A defer means "try again later" — it must never mean "try again forever".
 * Observed live: a lead URL that LinkedIn no longer serves a profile for (its
 * page renders as plain "LinkedIn", no name, no action bar — a 404 in every way
 * that matters) is INDISTINGUISHABLE, from the driver's side, from a page that
 * was merely too slow. The driver rightly refuses to call that a verdict about
 * the lead and returns `network_error`; the worker rightly defers it. With no
 * bound, the pair loops: the same dead link is re-queued and re-opened every
 * ~10 minutes, day and night, holding a queue slot and a real browser tab.
 *
 * So the retry is generous but FINITE. Five attempts across roughly an hour is
 * far past any transient-network window, and what remains is a URL that will
 * never load — which the user must be told about, not silently retried at.
 *
 * ⚠️ This bounds ONLY `network_error`. `agent_unavailable` / `agent_result_pending`
 * mean the user's laptop was closed, and deferring those for days IS correct —
 * capping them would fail a whole legitimate backlog over a weekend.
 */
export const MAX_NETWORK_DEFERS = 5;

/** Has this job used up its network-retry budget? (`attempts` counts defers.) */
export function networkDeferExhausted(attempts?: number | null): boolean {
  return (attempts ?? 0) + 1 >= MAX_NETWORK_DEFERS;
}

/**
 * Does this evidence say LinkedIn has signed the account out?
 *
 * Takes a landed URL and/or an error string, because the same fact arrives in
 * two shapes and BOTH must be caught:
 *
 *   1. `ERR_TOO_MANY_REDIRECTS`. A stale `li_at` with no JSESSIONID/bcookie/liap
 *      makes LinkedIn bounce /in/<slug> -> /authwall -> /login -> back, until
 *      Chrome gives up at 20 hops. `page.goto` THROWS, so no landed URL exists.
 *   2. A clean load that simply landed on /login or /authwall.
 *
 * Deliberately NOT matched: /checkpoint/, /challenge/, captcha. Those mean
 * LinkedIn wants the human to verify a session it still considers real — a
 * different remedy, so they stay with the `checkpoint` outcome.
 *
 * 🔴 This lives HERE, not in the Playwright driver, for a deployment reason that
 * is the whole point of the fix. The driver is esbuild-bundled into each user's
 * desktop app, so a change there reaches customers only when they download and
 * reinstall a new build — which is not a thing we can ask users to do per bug.
 * The desktop agent ALREADY reports the raw `page.goto: net::ERR_TOO_MANY_
 * REDIRECTS ...` string back over the wire, so the SERVER can classify it from
 * what every existing app version already sends. Keeping the predicate in this
 * playwright-free module lets the worker import it (importing the driver would
 * drag Playwright into the API/worker process and crash it on boot — observed).
 * Result: the fix ships with an ordinary server restart, and the driver-side
 * copy below is an optimisation for future builds, not a prerequisite.
 */
/**
 * Did LinkedIn answer this navigation by saying the profile does not exist?
 *
 * 🔴 OBSERVED LIVE on `/in/darwin-ponraj-77939020`: LinkedIn does NOT serve a
 * dead profile in place. It REDIRECTS to `linkedin.com/404/`, and that page is a
 * bare illustration + "This page doesn't exist" — with no `<main>` and no `<h1>`.
 * So the navigation's rendered-body probe finds nothing, reports `body never
 * rendered`, and hands back a NULL response — which means every downstream check
 * that would have recognised the dead link (the `resp.status() === 404` test, the
 * "this page doesn't exist" text scan) is skipped, and a permanently dead URL is
 * classified as a slow network and re-driven forever.
 *
 * The landed URL is the reliable signal, exactly as it is for {@link isSignedOutNav}:
 * `/404/` is LinkedIn's own verdict, delivered before any rendering matters.
 *
 * Anchored to the PATH so a member whose vanity slug merely contains "404"
 * (`/in/john-404`) can never be mistaken for a dead profile.
 */
export function isProfileGoneNav(landedUrl: string): boolean {
  return /^https?:\/\/[^/]*linkedin\.com\/404(?:[/?#]|$)/i.test(landedUrl);
}

export function isSignedOutNav(landedUrl: string, thrownError: string): boolean {
  if (/ERR_TOO_MANY_REDIRECTS/i.test(thrownError)) return true;
  return /linkedin\.com\/(?:authwall|login|uas\/login|signup)/i.test(landedUrl);
}

/**
 * Is this failure safe to put back in the queue?
 *
 * "Safe" has exactly one meaning here: the evidence PROVES no invite left the
 * account. Re-driving a job that already sent one would fire a second invite at
 * a real person and spend a second pacing slot, so the test is an ALLOWLIST of
 * failures that happened at or before navigation — never a denylist, because a
 * denylist silently admits every new driver error code someone adds later.
 *
 * Admitted:
 *   - the signed-out redirect loop / sign-in wall (the account was logged out)
 *   - any `page.goto` failure (the profile never loaded, so nothing was clicked)
 *   - the outcome codes that mean the executor never ran
 *
 * Refused, and deliberately so:
 *   - `no_connect_button`, `profile_gone`, `blocked`, `email_required` — these
 *     are real readings OF THE LEAD. Re-driving them just fails again.
 *   - `invite_dialog_never_opened`, `send_button_not_found`, `locator.click`
 *     timeouts, `invite_not_confirmed` — the flow was already inside the invite
 *     composer. Whether an invite went out is AMBIGUOUS, and the safe reading of
 *     an ambiguous send is "it sent".
 */
export function isRequeueableFailure(lastError?: string | null): boolean {
  const err = (lastError || '').trim();
  if (!err) return false;
  if (isSignedOutNav('', err)) return true;
  // A navigation that never completed proves the page was never interacted with.
  if (/(?:^|\s)page\.goto:/.test(err)) return true;
  return ['session_expired', 'network_error', 'agent_unavailable'].includes(err);
}

/**
 * Human text for the codes a driver returns in `error` (or the bare outcome when
 * it has none). `last_error` keeps the machine code — the dashboard and the
 * scheduler match on it — but the NOTIFICATION the user reads must be a sentence.
 * A raw enum reaching the UI ("skipped: email required", "skipped: no connect
 * button") tells the user nothing about what LinkedIn actually refused, or what
 * to do about it. Unmapped codes fall back to the de-underscored code so a new
 * driver signal degrades to today's behaviour instead of throwing.
 */
const FAILURE_TEXT: Record<string, string> = {
  // Verified live: the invite composer replaces the note field with
  // <input type="email" name="email"> when the member restricts invites to
  // people who know their email address. Nothing was sent.
  email_required:
    "LinkedIn will only let you invite this person if you know their email address (their privacy setting), so the invite was not sent — connect manually or reach them another way",
  follow_only_profile: 'this profile offers only Follow — LinkedIn gives no way to invite it',
  connect_target_mismatch: "LinkedIn's Connect control pointed at a different person, so nothing was sent",
  invite_dialog_never_opened: 'the LinkedIn invite window never opened',
  send_button_not_found: 'the invite window opened but showed no Send button',
  no_connect_button: 'LinkedIn shows no Connect option on this profile',
  profile_gone: 'this LinkedIn profile no longer exists',
  profile_not_found: "LinkedIn returned a 'page not found' for this link — the profile was deleted or the URL is wrong",
  // Retried MAX_NETWORK_DEFERS times over ~an hour and never got a page. Almost
  // always a dead/wrong URL rather than a network problem, so say both.
  profile_unreachable:
    'this LinkedIn link never opened after several tries — check that the profile URL is still valid',
  blocked: 'this member blocks contact from your account',
  note_cap: "your LinkedIn account's personalized-note quota is used up for this month",
  session_expired:
    'LinkedIn signed this account out, so nothing could be sent — reconnect the account in Settings and the queued outreach will resume on its own',
};

/** Turn a driver error code / outcome into the sentence shown to the user. */
export function failureText(code?: string | null): string {
  if (!code) return 'unknown error';
  return FAILURE_TEXT[code] ?? code.replace(/_/g, ' ');
}

export interface LinkedInDriver {
  /** Perform a connection request; optionally with a personalized note. */
  sendConnectRequest(
    targetUrl: string,
    message: string,
    ctx?: LinkedInActionContext,
  ): Promise<LinkedInActionResult>;

  /** Send a direct message to an existing connection. */
  sendMessage(
    targetUrl: string,
    message: string,
    ctx?: LinkedInActionContext,
  ): Promise<LinkedInActionResult>;

  /** Open the profile (a "profile view" — LinkedIn surfaces it to the lead). */
  visitProfile(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult>;

  /** Follow the profile without connecting. */
  follow(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult>;

  /** Send an InMail (works on Open Profiles / with InMail credits). */
  sendInMail(
    targetUrl: string,
    subject: string,
    message: string,
    ctx?: LinkedInActionContext,
  ): Promise<LinkedInActionResult>;

  /** Like the lead's most recent post (a soft-touch warm-up action). */
  likeRecentPost(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult>;

  /** Endorse the lead's top skill(s). */
  endorseSkill(targetUrl: string, ctx?: LinkedInActionContext): Promise<LinkedInActionResult>;

  /**
   * Read the account's network + messaging to detect newly accepted invites and
   * inbound replies since the last pass. Read-only; drives lead-state updates.
   */
  syncAccount(ctx?: LinkedInActionContext): Promise<LinkedInSyncResult>;

  /**
   * Withdraw outstanding sent invitations older than `olderThanDays`.
   * Stale pending invites hurt the account's acceptance ratio, so LinkedIn
   * best-practice is to periodically retract them.
   */
  withdrawStaleInvites(
    olderThanDays: number,
    ctx?: LinkedInActionContext,
  ): Promise<{ withdrawn: number; checkpoint?: boolean; error?: string }>;

  /** Log in once and capture the session cookie. */
  login(ctx: LinkedInLoginContext): Promise<LinkedInLoginResult>;
}

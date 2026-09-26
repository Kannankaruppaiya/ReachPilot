/**
 * LinkedIn driver contract. Implementations: SimulatorDriver (dev/tests),
 * PlaywrightLinkedInDriver (real browser), RemoteAgentDriver (desktop agent).
 * Chosen by LINKEDIN_DRIVER (see drivers.module.ts).
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
  /** The li_at cookie; kept for the agent wire and accounts stored before `cookies`. */
  li_at?: string;
  /** The full cookie jar; `li_at` alone can't restore a session (see linkedin-session-store.ts). */
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
   * The vanity slug LinkedIn served when the requested URL was a member URN.
   * Captured at send time so later uploads match either URL form.
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
  /** The whole jar captured with `li_at`; persist this one. */
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
/**
 * Outcomes that pause the whole account, not just fail the job. `session_expired`
 * belongs here, not in TERMINAL_FAIL_OUTCOMES: a signed-out account fails every
 * job, so failing per lead burns the whole queue.
 */
export const ACCOUNT_HALT_OUTCOMES: LinkedInOutcome[] = [
  'checkpoint',
  'limit_reached',
  'session_expired',
];
/**
 * Terminal per-lead failures: mark failed, no retry. `network_error` must never be
 * added: nothing was clicked, so the worker defers it (DEFER_OUTCOMES).
 */
export const TERMINAL_FAIL_OUTCOMES: LinkedInOutcome[] = [
  'no_connect_button',
  'profile_gone',
  'blocked',
];
/** The executor couldn't run; the lead isn't bad. Reschedule, never fail or burn an attempt. */
export const DEFER_OUTCOMES: LinkedInOutcome[] = ['network_error'];

/**
 * How many `network_error` defers a job gets (~1 hour) before failing: a dead URL
 * looks exactly like a slow page. Bounds only `network_error`; agent-offline
 * defers stay unbounded (a laptop closed over a weekend is normal).
 */
export const MAX_NETWORK_DEFERS = 5;

/** Has this job used up its network-retry budget? (`attempts` counts defers.) */
export function networkDeferExhausted(attempts?: number | null): boolean {
  return (attempts ?? 0) + 1 >= MAX_NETWORK_DEFERS;
}

/**
 * Did LinkedIn answer with its /404/ page? A dead profile redirects there (no
 * <main> or <h1>), so the landed URL is the signal. Anchored to the path so a
 * slug containing "404" never matches.
 */
export function isProfileGoneNav(landedUrl: string): boolean {
  return /^https?:\/\/[^/]*linkedin\.com\/404(?:[/?#]|$)/i.test(landedUrl);
}

/**
 * Has LinkedIn signed the account out? Seen as ERR_TOO_MANY_REDIRECTS (a stale
 * cookie redirect-loops) or a landing on /login or /authwall; checkpoints are a
 * separate outcome. Lives here, not in the driver, so the server can classify what
 * existing desktop builds report without a reinstall.
 */
export function isSignedOutNav(landedUrl: string, thrownError: string): boolean {
  if (/ERR_TOO_MANY_REDIRECTS/i.test(thrownError)) return true;
  return /linkedin\.com\/(?:authwall|login|uas\/login|signup)/i.test(landedUrl);
}

/**
 * Is this failure safe to re-queue? Only when the evidence proves no invite left:
 * sign-out, a failed `page.goto`, or the executor never running. An allowlist, so
 * new error codes default to "not safe"; failures inside the invite composer are
 * ambiguous and count as sent.
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
 * User-facing text for driver error codes; `last_error` keeps the machine code.
 * Unmapped codes fall back to the de-underscored code.
 */
const FAILURE_TEXT: Record<string, string> = {
  // The composer shows an email input when the member limits invites. Nothing was sent.
  email_required:
    "LinkedIn will only let you invite this person if you know their email address (their privacy setting), so the invite was not sent — connect manually or reach them another way",
  follow_only_profile: 'this profile offers only Follow — LinkedIn gives no way to invite it',
  connect_target_mismatch: "LinkedIn's Connect control pointed at a different person, so nothing was sent",
  invite_dialog_never_opened: 'the LinkedIn invite window never opened',
  send_button_not_found: 'the invite window opened but showed no Send button',
  no_connect_button: 'LinkedIn shows no Connect option on this profile',
  profile_gone: 'this LinkedIn profile no longer exists',
  profile_not_found: "LinkedIn returned a 'page not found' for this link — the profile was deleted or the URL is wrong",
  // Never loaded after MAX_NETWORK_DEFERS tries: usually a dead or wrong URL.
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

  /** Withdraw invites older than `olderThanDays`; stale invites hurt acceptance rate. */
  withdrawStaleInvites(
    olderThanDays: number,
    ctx?: LinkedInActionContext,
  ): Promise<{ withdrawn: number; checkpoint?: boolean; error?: string }>;

  /** Log in once and capture the session cookie. */
  login(ctx: LinkedInLoginContext): Promise<LinkedInLoginResult>;
}

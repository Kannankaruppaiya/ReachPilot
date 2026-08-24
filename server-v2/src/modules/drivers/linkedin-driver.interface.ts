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
  | 'blocked'; // we've been blocked by the target — skip

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
  /** The li_at session cookie — the "logged-in" state. */
  li_at?: string;
  proxy?: ProxyConfig;
  fingerprint?: LinkedInFingerprint;
}

export interface LinkedInActionResult {
  status: LinkedInOutcome;
  externalId?: string;
  error?: string;
  /** Public egress IP the desktop agent ran this action from (ipify echo). */
  reportedIp?: string;
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
export const ACCOUNT_HALT_OUTCOMES: LinkedInOutcome[] = ['checkpoint', 'limit_reached'];
/** Terminal per-lead failures — mark failed but do NOT retry. */
export const TERMINAL_FAIL_OUTCOMES: LinkedInOutcome[] = [
  'no_connect_button',
  'profile_gone',
  'blocked',
];

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

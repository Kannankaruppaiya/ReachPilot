/**
 * The session-cookie policy, unit-tested without a browser.
 *
 * These three rules were all learned from one live incident (2026-08-26), where a
 * LinkedIn account was signed out server-side and the automation made it strictly
 * worse instead of noticing:
 *
 *  1. The driver injected the DB's copy of `li_at` over the persistent profile's
 *     own cookie on EVERY action. Observed live: the profile's cookie and the DB
 *     cookie were different (sha efb01d35f59f vs 21c3b1be62ac), and the injection
 *     replaced the profile's with the stale one — so a user who signed in by hand
 *     had their good session destroyed by the very next job.
 *  2. Only `li_at` was ever stored. A LinkedIn session is a SET of cookies
 *     (JSESSIONID, bcookie, bscookie, liap, lidc …); `li_at` alone could not even
 *     load /feed/ (ERR_TOO_MANY_REDIRECTS), so the stored "session" was never
 *     restorable on its own.
 *  3. The login flow typed a TOTP code into ANY pin field it found, without
 *     checking whether LinkedIn had asked for the authenticator code or for one
 *     emailed/SMSed to the member. A wrong code is a failed login attempt, which
 *     is precisely the signal that gets an account challenged harder.
 */
import {
  parseStoredSession,
  serializeSession,
  cookiesToInject,
  classifyPinChallenge,
  LI_AT_DOMAIN,
  type StoredCookie,
} from '@/modules/drivers/linkedin-session-store';

/** A realistic jar, shaped exactly like `context.cookies()` returns. */
const liveJar: StoredCookie[] = [
  { name: 'li_at', value: 'LIVE_LI_AT', domain: '.www.linkedin.com', path: '/' },
  { name: 'JSESSIONID', value: '"ajax:123"', domain: '.www.linkedin.com', path: '/' },
  { name: 'bcookie', value: 'v=2&abc', domain: '.linkedin.com', path: '/' },
  { name: 'liap', value: 'true', domain: '.linkedin.com', path: '/' },
];

describe('stored session — the whole jar, not just li_at', () => {
  it('round-trips every cookie, not only li_at', () => {
    const restored = parseStoredSession(serializeSession(liveJar));

    expect(restored.map((c) => c.name).sort()).toEqual(
      ['JSESSIONID', 'bcookie', 'li_at', 'liap'],
    );
  });

  it('preserves each cookie\'s own domain instead of flattening them', () => {
    const restored = parseStoredSession(serializeSession(liveJar));

    expect(restored.find((c) => c.name === 'li_at')?.domain).toBe('.www.linkedin.com');
    expect(restored.find((c) => c.name === 'bcookie')?.domain).toBe('.linkedin.com');
  });

  it('BACK-COMPAT: reads an account stored under the old bare-li_at format', () => {
    // Every account connected before this change has a plain cookie string in
    // the vault. Those must keep working — a migration that signs everyone out
    // would be a worse outage than the bug being fixed.
    const restored = parseStoredSession('OLD_FORMAT_LI_AT');

    expect(restored).toEqual([
      { name: 'li_at', value: 'OLD_FORMAT_LI_AT', domain: LI_AT_DOMAIN, path: '/' },
    ]);
  });

  it('restores a legacy cookie on the domain LinkedIn actually sets it on', () => {
    expect(LI_AT_DOMAIN).toBe('.www.linkedin.com');
  });

  it('treats an unusable stored value as no session at all', () => {
    expect(parseStoredSession('')).toEqual([]);
    expect(parseStoredSession(undefined)).toEqual([]);
    expect(parseStoredSession('[]')).toEqual([]);
  });
});

describe('cookie injection — the persistent profile owns the session', () => {
  it('THE BUG: never overwrites a profile that is already signed in', () => {
    // The profile has a live li_at; the vault holds an older one. Injecting the
    // vault copy here is what destroyed a hand-made login on the next job.
    const stored: StoredCookie[] = [
      { name: 'li_at', value: 'STALE_FROM_DB', domain: LI_AT_DOMAIN, path: '/' },
    ];

    expect(cookiesToInject(liveJar, stored)).toEqual([]);
  });

  it('seeds a fresh profile from the stored jar', () => {
    // First run on a new machine (or after %TEMP% was cleared): the profile has
    // no LinkedIn session, so the stored one is all we have.
    expect(cookiesToInject([], liveJar)).toEqual(liveJar);
  });

  it('seeds a profile that has other LinkedIn cookies but no li_at', () => {
    const noSession = liveJar.filter((c) => c.name !== 'li_at');

    expect(cookiesToInject(noSession, liveJar)).toEqual(liveJar);
  });

  it('injects nothing when there is nothing stored', () => {
    expect(cookiesToInject([], [])).toEqual([]);
  });

  it('ignores a profile li_at that is present but empty', () => {
    const blank: StoredCookie[] = [
      { name: 'li_at', value: '', domain: LI_AT_DOMAIN, path: '/' },
    ];

    expect(cookiesToInject(blank, liveJar)).toEqual(liveJar);
  });
});

describe('PIN challenge — answer only the challenge we can actually answer', () => {
  it('recognises the authenticator-app challenge, which we CAN answer', () => {
    expect(
      classifyPinChallenge('Enter the 6-digit code from your authenticator app'),
    ).toBe('totp');
    expect(
      classifyPinChallenge('Please enter the verification code generated by your authenticator app'),
    ).toBe('totp');
  });

  it('recognises an emailed code, which no stored seed can generate', () => {
    expect(
      classifyPinChallenge("We've sent a verification code to j***@gmail.com"),
    ).toBe('email');
    expect(classifyPinChallenge('Enter the code we sent to your email')).toBe('email');
  });

  it('recognises an SMS code, which no stored seed can generate', () => {
    expect(
      classifyPinChallenge('We sent a code to your phone number ending in 42'),
    ).toBe('sms');
  });

  it('does not guess when the challenge text is unfamiliar', () => {
    // LinkedIn rewords these pages often. An unrecognised wording must not be
    // assumed to be the authenticator — typing a TOTP code into an email
    // challenge is a FAILED login attempt, the exact signal that gets an
    // account challenged harder.
    expect(classifyPinChallenge('Quick security check')).toBe('unknown');
    expect(classifyPinChallenge('')).toBe('unknown');
  });

  it('reads an email challenge even when the page also names the app', () => {
    // The email page often links "use your authenticator app instead". The code
    // being ASKED for is still the emailed one.
    expect(
      classifyPinChallenge(
        "We've sent a verification code to your email. Use your authenticator app instead",
      ),
    ).toBe('email');
  });
});

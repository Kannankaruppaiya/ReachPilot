/**
 * Regression: the duplicate-invite guard never fired. It looked leads up by
 * `lead_id`, which is NULL on every connect job. The guard now keys on the
 * profile in the payload: both the uploaded target (often a URN) and the vanity
 * slug LinkedIn resolved it to. Pure logic.
 */
import { invitedProfileKeys, profileKey } from '../src/modules/jobs/profile-key';

const URN = 'https://www.linkedin.com/in/ACwAAATA-DYBK79gAZjoB4DKDJxKedpINUqNMLM';
const VANITY = 'https://www.linkedin.com/in/dinesh-m-84686222/';

describe('duplicate-invite guard keys', () => {
  it('catches the exact repeat that got through (same URN, three jobs)', () => {
    const invited = invitedProfileKeys([{ target: URN }]);
    expect(invited.has(profileKey(URN)!)).toBe(true);
  });

  it('a lead_id-keyed guard could never have matched', () => {
    // The old comparison: SQL `lead_id = NULL` is never true.
    const jobLeadId: string | null = null;
    const sentLeadId: string | null = null;
    // eslint-disable-next-line eqeqeq
    expect(jobLeadId === sentLeadId && jobLeadId !== null).toBe(false);
  });

  it('matches a later job that carries the vanity slug of a URN-addressed send', () => {
    // A re-upload of the same person as a readable URL must still match.
    const invited = invitedProfileKeys([{ target: URN, resolvedSlug: 'dinesh-m-84686222' }]);
    expect(invited.has(profileKey(VANITY)!)).toBe(true);
    expect(invited.has(profileKey(URN)!)).toBe(true);
  });

  it('normalises host, protocol, case and trailing slash', () => {
    const invited = invitedProfileKeys([{ target: 'http://IN.linkedin.com/in/Dinesh-M-84686222' }]);
    expect(invited.has(profileKey('https://www.linkedin.com/in/dinesh-m-84686222/?trk=x')!)).toBe(true);
  });

  it('never lets one profile stand in for another', () => {
    const invited = invitedProfileKeys([{ target: VANITY }]);
    expect(invited.has(profileKey('https://www.linkedin.com/in/ganesh-sankararaman-425ba926/')!)).toBe(false);
  });

  it('ignores payloads with no usable profile rather than inventing a key', () => {
    // A null key must mean "unknown", never "matches everything".
    const invited = invitedProfileKeys([{}, null, undefined, { target: '' }, { target: 'not a url' }]);
    expect(invited.size).toBe(0);
  });
});

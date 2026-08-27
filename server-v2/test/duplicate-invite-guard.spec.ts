/**
 * Regression: the duplicate-invite guard had never fired, for any job.
 *
 * OBSERVED LIVE (2026-08-27). Dinesh M held three connect jobs on ONE target:
 *
 *   10:01  failed   no_connect_button
 *   14:08  sent                        <-- invite delivered, he ACCEPTED it
 *   14:42  failed   no_connect_button  <-- ran anyway, against a lead already won
 *
 * The scheduler is supposed to cancel a second `connect_request` to someone we
 * already invited. It looked the lead up by id:
 *
 *   .where('lead_id', '=', job.lead_id!)
 *
 * ...nested inside `if (job.lead_id)`. Every connect job carries `lead_id` NULL —
 * measured on live data, 366 of 366 — so the enclosing block was skipped and the
 * guard never ran once. Silently: no error, no log, just no protection. Duplicate
 * invites annoy prospects and burn the weekly invite quota.
 *
 * The identity that IS always present is the profile itself, in the payload. It
 * arrives in two forms — the obfuscated member URN a scrape produced, and the
 * vanity slug LinkedIn redirected a send to — so both are indexed.
 *
 * Pure logic — no DB, no Redis, no browser.
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
    // What the shipped code compared, reproduced: SQL `lead_id = NULL` is never
    // true, so no amount of history would have produced a hit.
    const jobLeadId: string | null = null;
    const sentLeadId: string | null = null;
    // eslint-disable-next-line eqeqeq
    expect(jobLeadId === sentLeadId && jobLeadId !== null).toBe(false);
  });

  it('matches a later job that carries the vanity slug of a URN-addressed send', () => {
    // The send resolved the URN to a vanity and recorded it; a re-upload of the
    // same person as a readable URL must still be recognised as already invited.
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

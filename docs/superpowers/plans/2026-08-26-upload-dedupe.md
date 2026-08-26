# Upload Dedupe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a lead list is uploaded, silently drop the rows whose LinkedIn profile has already been sent a connection request, and queue only the rest.

**Architecture:** Two pure functions carry all the logic — `profileKey(url)` reduces any LinkedIn URL to a comparable `/in/<slug>` identity, and `selectNewRows(rows, sentKeys)` partitions an upload into kept and skipped. `createBatch` builds the key set from the workspace's already-sent jobs and calls them before inserting anything. Separately, a successful connect records the vanity slug LinkedIn actually landed on, so a member invited under an obfuscated URN is still recognised when a later list carries their readable URL.

**Tech Stack:** TypeScript, NestJS, Kysely (Postgres), Jest, React (Vite).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-26-upload-dedupe-design.md`.
- Match only `connect_request` jobs with `status = 'sent'`. Never queued, never failed.
- No new database columns. The application DB role has no DDL rights (see CLAUDE.md); `resolvedSlug` goes inside the existing `jobs.payload` JSON.
- No extra LinkedIn page loads. Nothing in this feature may navigate to a profile.
- A row whose URL yields a `null` key is KEPT, never skipped.
- Every tenant-table read/write goes through `withWorkspace(workspaceId, …)` — raw `getDb()` is RLS-blocked (see CLAUDE.md).
- Tests run with `npx jest` from `server-v2/`. Two suites (`rls-isolation`, `vault`) fail unless a local Postgres is running on `127.0.0.1:55432`; that is pre-existing and unrelated.
- Run from `server-v2/` unless a step says otherwise.

## File Structure

| File | Responsibility |
|---|---|
| `server-v2/src/modules/jobs/profile-key.ts` (create) | `profileKey` and `selectNewRows` — the whole matching policy, pure |
| `server-v2/test/upload-dedupe.spec.ts` (create) | Unit tests for both |
| `server-v2/src/modules/jobs/jobs.service.ts` (modify) | `createBatch` builds the sent-key set and filters rows; returns `skipped` |
| `server-v2/src/modules/drivers/linkedin-driver.interface.ts` (modify) | `resolvedSlug` on `LinkedInActionResult` |
| `server-v2/src/modules/drivers/playwright-linkedin.driver.ts` (modify) | Return `resolvedSlug` on a successful connect |
| `server-v2/src/worker.ts` (modify) | Merge `resolvedSlug` into the job's stored payload |
| `src/lib/api/index.ts` (modify) | `skipped` in the response type |
| `src/screens/AutoSend.tsx` (modify) | Report the skipped count |

---

### Task 1: The matching policy

**Files:**
- Create: `server-v2/src/modules/jobs/profile-key.ts`
- Test: `server-v2/test/upload-dedupe.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `profileKey(url: string | null | undefined): string | null`
  - `interface UploadRow { target?: string; linkedinUrl?: string; [k: string]: unknown }`
  - `interface RowSelection<T> { kept: T[]; skipped: T[] }`
  - `selectNewRows<T extends UploadRow>(rows: T[], sentKeys: Set<string>): RowSelection<T>`

- [ ] **Step 1: Write the failing test**

Create `server-v2/test/upload-dedupe.spec.ts`:

```typescript
/**
 * Uploading a list re-invites everyone on it, because the scheduler's duplicate
 * guard matches on lead_id and spreadsheet rows have none (verified against the
 * live batch of 2026-08-25: all 18 rows had lead_id null). Every duplicate
 * spends weekly invite allowance a new prospect needed, and repeatedly inviting
 * the same member is the pattern automation detection looks for.
 */
import {
  profileKey,
  selectNewRows,
  type UploadRow,
} from '@/modules/jobs/profile-key';

describe('profileKey', () => {
  it('reduces a full profile URL to its slug', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe')).toBe('john-doe');
  });

  it('lowercases, so the same person written two ways matches', () => {
    expect(profileKey('https://www.linkedin.com/in/John-Doe')).toBe('john-doe');
  });

  it('ignores a trailing slash', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe/')).toBe('john-doe');
  });

  it('ignores query strings and fragments', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe?utm_source=x#exp')).toBe('john-doe');
  });

  it('ignores a country subdomain', () => {
    expect(profileKey('https://in.linkedin.com/in/john-doe')).toBe('john-doe');
  });

  it('accepts a bare URL with no protocol, as scraped lists carry', () => {
    expect(profileKey('linkedin.com/in/john-doe')).toBe('john-doe');
  });

  it('handles the obfuscated member URN form', () => {
    expect(profileKey('https://www.linkedin.com/in/ACwAADY3WCIBhkYYxYlv')).toBe(
      'acwaady3wcibhkyyxylv',
    );
  });

  it('decodes percent-encoding', () => {
    expect(profileKey('https://www.linkedin.com/in/jos%C3%A9-silva')).toBe('josé-silva');
  });

  it('ignores anything after the slug', () => {
    expect(profileKey('https://www.linkedin.com/in/john-doe/details/experience/')).toBe(
      'john-doe',
    );
  });

  it('returns null for a URL that is not a profile', () => {
    expect(profileKey('https://www.linkedin.com/company/acme')).toBeNull();
    expect(profileKey('https://example.com/john-doe')).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(profileKey('')).toBeNull();
    expect(profileKey(null)).toBeNull();
    expect(profileKey(undefined)).toBeNull();
  });
});

describe('selectNewRows', () => {
  const row = (target: string, name = ''): UploadRow => ({ target, name });

  it('keeps a profile we have never invited', () => {
    const rows = [row('https://www.linkedin.com/in/john-doe')];

    const { kept, skipped } = selectNewRows(rows, new Set(['someone-else']));

    expect(kept).toEqual(rows);
    expect(skipped).toEqual([]);
  });

  it('THE BUG: skips a profile already sent an invite', () => {
    const rows = [row('https://www.linkedin.com/in/john-doe')];

    const { kept, skipped } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual([]);
    expect(skipped).toEqual(rows);
  });

  it('matches across URL spellings of the same profile', () => {
    // The list carries a bare, capitalised, slash-suffixed URL; the sent job was
    // stored as a canonical one.
    const rows = [row('LinkedIn.com/in/John-Doe/')];

    const { kept } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual([]);
  });

  it('collapses a profile listed twice in one upload', () => {
    const rows = [
      row('https://www.linkedin.com/in/john-doe'),
      row('https://www.linkedin.com/in/John-Doe/'),
    ];

    const { kept, skipped } = selectNewRows(rows, new Set());

    expect(kept).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });

  it('reads the linkedinUrl field when target is absent', () => {
    const rows: UploadRow[] = [{ linkedinUrl: 'https://www.linkedin.com/in/john-doe' }];

    const { kept } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual([]);
  });

  it('KEEPS a row whose URL cannot be parsed, rather than dropping it silently', () => {
    // Discarding input we could not classify would hide a malformed spreadsheet.
    // A kept row fails later with a reason the operator can read.
    const rows = [row('not a url at all')];

    const { kept, skipped } = selectNewRows(rows, new Set(['john-doe']));

    expect(kept).toEqual(rows);
    expect(skipped).toEqual([]);
  });

  it('keeps every unparseable row, never collapsing them into one', () => {
    const rows = [row(''), row('')];

    expect(selectNewRows(rows, new Set()).kept).toHaveLength(2);
  });

  it('reports every row skipped when the whole list was already contacted', () => {
    const rows = [row('https://www.linkedin.com/in/a'), row('https://www.linkedin.com/in/b')];

    const { kept, skipped } = selectNewRows(rows, new Set(['a', 'b']));

    expect(kept).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('preserves the upload order of the rows it keeps', () => {
    const rows = [
      row('https://www.linkedin.com/in/a'),
      row('https://www.linkedin.com/in/b'),
      row('https://www.linkedin.com/in/c'),
    ];

    const { kept } = selectNewRows(rows, new Set(['b']));

    expect(kept.map((r) => r.target)).toEqual([
      'https://www.linkedin.com/in/a',
      'https://www.linkedin.com/in/c',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest test/upload-dedupe.spec.ts`
Expected: FAIL — `Cannot find module '@/modules/jobs/profile-key'`.

- [ ] **Step 3: Write the implementation**

Create `server-v2/src/modules/jobs/profile-key.ts`:

```typescript
/**
 * Deciding whether we have already invited someone.
 *
 * LinkedIn names a member two ways in URLs: an obfuscated member URN
 * (`/in/ACwAADY3WCIB…`) and a readable vanity slug (`/in/john-doe`). Scraped
 * lists carry both, mixed, and the same list re-exported can differ in case,
 * protocol, country subdomain and tracking parameters. Raw string comparison
 * therefore misses duplicates that are obviously duplicates to a human.
 *
 * Pure, so the policy is testable without a database.
 */

/** One row of an uploaded list, as `createBatch` receives it. */
export interface UploadRow {
  target?: string;
  linkedinUrl?: string;
  [key: string]: unknown;
}

export interface RowSelection<T> {
  kept: T[];
  skipped: T[];
}

/**
 * Reduce a LinkedIn URL to the identity we compare on: the `/in/<slug>` segment,
 * lowercased and stripped of protocol, host, trailing slash, query, fragment and
 * any deeper path.
 *
 * Returns null for anything that is not a profile URL. Callers must treat null
 * as "unknown", never as "no match" — see `selectNewRows`.
 */
export function profileKey(url: string | null | undefined): string | null {
  const raw = (url || '').trim();
  if (!raw) return null;

  // Cut protocol and host without needing a valid absolute URL: scraped lists
  // routinely carry bare `linkedin.com/in/x`, which `new URL()` rejects.
  const withoutScheme = raw.replace(/^[a-z]+:\/\//i, '');
  const match = /(?:^|\.)linkedin\.com\/in\/([^/?#]+)/i.exec(withoutScheme);
  if (!match) return null;

  let slug = match[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Malformed escape sequence — compare the raw slug rather than giving up.
  }
  slug = slug.trim().toLowerCase();
  return slug || null;
}

/**
 * Split an upload into the rows worth queuing and the rows already contacted.
 *
 * A row is skipped when its key is in `sentKeys`, or when an earlier row in the
 * same upload had that key. A row whose URL yields no key is always KEPT:
 * silently discarding input we could not classify would hide a malformed
 * spreadsheet, whereas a kept row fails later with a reason the operator can
 * read.
 */
export function selectNewRows<T extends UploadRow>(
  rows: T[],
  sentKeys: Set<string>,
): RowSelection<T> {
  const kept: T[] = [];
  const skipped: T[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const key = profileKey(row.target || row.linkedinUrl);
    if (key === null) {
      kept.push(row);
      continue;
    }
    if (sentKeys.has(key) || seen.has(key)) {
      skipped.push(row);
      continue;
    }
    seen.add(key);
    kept.push(row);
  }

  return { kept, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest test/upload-dedupe.spec.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add server-v2/src/modules/jobs/profile-key.ts server-v2/test/upload-dedupe.spec.ts
git commit -m "feat(jobs): match uploaded profiles against ones already invited"
```

---

### Task 2: Filter the upload in createBatch

**Files:**
- Modify: `server-v2/src/modules/jobs/jobs.service.ts` — the `createBatch` method

**Interfaces:**
- Consumes: `profileKey`, `selectNewRows` from Task 1.
- Produces: `createBatch` returns `{ batchId: string; total: number; today: number; queuedDays: number; skipped: number }`.

- [ ] **Step 1: Add the import**

At the top of `server-v2/src/modules/jobs/jobs.service.ts`, after the existing `computeWarmup` import:

```typescript
import { profileKey, selectNewRows } from './profile-key';
```

- [ ] **Step 2: Widen the return type**

In the `createBatch` signature, change the return type to include `skipped`:

```typescript
  ): Promise<{ batchId: string; total: number; today: number; queuedDays: number; skipped: number }> {
```

- [ ] **Step 3: Filter the rows before the transaction**

`createBatch` currently begins with a channel check, an empty-rows check, then `const batchId = crypto.randomUUID();`. Insert the dedupe between the empty-rows check and `batchId`, so the whole-list-skipped case returns before a batch id is minted:

```typescript
    // Drop profiles this workspace has already sent a connection request to.
    // Re-inviting someone spends weekly invite allowance a new prospect needed,
    // and repeat invites to the same member are what automation detection looks
    // for. Only SENT jobs count: a queued one has not happened yet, and a failed
    // one is usually a bad network window rather than a verdict about the person.
    let skipped = 0;
    if (kind === 'linkedin') {
      const sentJobs = await withWorkspace(workspaceId, (db) =>
        db
          .selectFrom('jobs')
          .select('payload')
          .where('workspace_id', '=', workspaceId)
          .where('action', '=', 'connect_request')
          .where('status', '=', 'sent')
          .execute(),
      );

      const sentKeys = new Set<string>();
      for (const j of sentJobs) {
        const p: any =
          typeof j.payload === 'string'
            ? (() => {
                try {
                  return JSON.parse(j.payload);
                } catch {
                  return {};
                }
              })()
            : j.payload || {};
        // Both the URL we were given and the vanity slug LinkedIn actually
        // landed on, so a member invited under an obfuscated URN is recognised
        // when a later list carries their readable URL (see Task 4).
        for (const candidate of [p.target, p.resolvedSlug]) {
          const key = profileKey(candidate);
          if (key) sentKeys.add(key);
        }
      }

      const selection = selectNewRows(rows, sentKeys);
      skipped = selection.skipped.length;
      rows = selection.kept;

      if (rows.length === 0) {
        // Uploading a list of people you have already contacted is a normal
        // outcome, not an error — do not fall through to the empty-input throw.
        return { batchId: '', total: 0, today: 0, queuedDays: 0, skipped };
      }
    }
```

- [ ] **Step 4: Make the `rows` parameter reassignable**

The block above reassigns `rows`. In the `createBatch` parameter list, that parameter is declared `rows: any[]`; TypeScript allows reassigning a parameter, so no change is needed unless the file's lint config forbids it. Run the linter to check:

Run: `npm run lint`
Expected: no new errors. If `no-param-reassign` fires, introduce `let candidateRows = rows;` immediately above the dedupe block, use `candidateRows` in the block and in the insert loop instead of `rows`.

- [ ] **Step 5: Return the count**

At the end of the `withWorkspace` callback, the code builds `return { batchId, total: totalCount, today: todayCount, queuedDays };`. Add the count, which the closure captures from the enclosing scope:

```typescript
      return { batchId, total: totalCount, today: todayCount, queuedDays, skipped };
```

- [ ] **Step 6: Report the count in the activity line**

In the same callback, the activity insert reads
`text: \`Queued ${totalCount} ${kind === 'linkedin' ? 'connection requests' : 'emails'} (${todayCount} today)\`,`. Replace it with:

```typescript
          text:
            `Queued ${totalCount} ${kind === 'linkedin' ? 'connection requests' : 'emails'} (${todayCount} today)` +
            (skipped ? ` · skipped ${skipped} already contacted` : ''),
```

- [ ] **Step 7: Typecheck and run the whole suite**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npx jest`
Expected: every suite passes except `rls-isolation` and `vault`, which need a local Postgres.

- [ ] **Step 8: Commit**

```bash
git add server-v2/src/modules/jobs/jobs.service.ts
git commit -m "feat(jobs): skip already-invited profiles when a list is uploaded"
```

---

### Task 3: Show the count in the app

**Files:**
- Modify: `src/lib/api/index.ts:189`
- Modify: `src/screens/AutoSend.tsx:237-240`

**Interfaces:**
- Consumes: the `skipped` field from Task 2.
- Produces: nothing other tasks use.

- [ ] **Step 1: Widen the client response type**

In `src/lib/api/index.ts`, the send-create call declares its response inline. Add `skipped`:

```typescript
  }) => req<{ batchId: string; total: number; today: number; queuedDays: number; skipped: number }>("/api/send/create", payload),
```

- [ ] **Step 2: Report it in the toast**

In `src/screens/AutoSend.tsx`, replace the existing `toast(...)` call that starts with `` `Queued ${res.total} ` `` with:

```typescript
      toast(
        res.total === 0
          ? `Everyone on that list has already been contacted — nothing queued (${res.skipped} skipped)`
          : `Queued ${res.total} ${mode === "linkedin" ? "connection requests" : "emails"} — ${res.today} today` +
              (res.skipped ? ` · ${res.skipped} already contacted, skipped` : "") +
              (res.queuedDays > 1 ? ` · rest scheduled over ${res.queuedDays} days (9:00 AM)` : ""),
      )
```

- [ ] **Step 3: Guard the empty batch**

The line after the toast is `batchId = res.batchId`. When every row was skipped, `batchId` is `''` and there is no batch to follow. Immediately after the toast, add:

```typescript
      if (res.total === 0) {
        setRunning(false)
        return
      }
```

- [ ] **Step 4: Typecheck the frontend**

Run (from the repo root): `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api/index.ts src/screens/AutoSend.tsx
git commit -m "feat(ui): report how many uploaded profiles were already contacted"
```

---

### Task 4: Learn the real slug from a successful connect

**Files:**
- Modify: `server-v2/src/modules/drivers/linkedin-driver.interface.ts` — `LinkedInActionResult`
- Modify: `server-v2/src/modules/drivers/playwright-linkedin.driver.ts` — the success return of `sendConnectRequest`
- Modify: `server-v2/src/worker.ts` — the branch that marks a job `sent`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LinkedInActionResult.resolvedSlug?: string`, and `jobs.payload.resolvedSlug` for jobs sent from now on — which Task 2's key set already reads.

- [ ] **Step 1: Add the field to the result type**

In `server-v2/src/modules/drivers/linkedin-driver.interface.ts`, inside `LinkedInActionResult`, after `reportedIp`:

```typescript
  /**
   * The vanity slug LinkedIn actually served, when the requested URL was an
   * obfuscated member URN. Captured free at send time — resolving it later would
   * mean loading one profile per row, which is exactly the traffic shape that
   * gets an account challenged. Lets a future upload recognise this member under
   * either URL form.
   */
  resolvedSlug?: string;
```

- [ ] **Step 2: Return it from the driver**

In `server-v2/src/modules/drivers/playwright-linkedin.driver.ts`, `slugOf` is exported at line 37 and `sendConnectRequest`'s success return is at lines 1180-1181:

```typescript
      const externalId = 'li_inv_' + Date.now().toString(36);
      return { status: 'sent', externalId };
```

Replace those two lines with:

```typescript
      const landedSlug = slugOf(page.url());
      const externalId = 'li_inv_' + Date.now().toString(36);
      return {
        status: 'sent',
        externalId,
        ...(landedSlug ? { resolvedSlug: landedSlug } : {}),
      };
```

Read the slug fresh at the return rather than reusing the `landedSlug` local computed earlier in the method — that one sits inside a conditional branch and is not in scope here.

- [ ] **Step 3: Persist it in the worker**

In `server-v2/src/worker.ts`, the LinkedIn handler marks the job sent with an update that sets `status: 'sent'` and `sent_at`. Immediately before that update, build the payload to store:

```typescript
        // Record the slug LinkedIn served so a later upload recognises this
        // member under either URL form. Merged into payload because the app DB
        // role has no DDL rights — a new column is not available to us.
        const storedPayload = res.resolvedSlug
          ? JSON.stringify({ ...payload, resolvedSlug: res.resolvedSlug })
          : null;
```

Then add `...(storedPayload ? { payload: storedPayload } : {})` to the `.set({ … })` object of that same update, so the write stays a single statement and the "commit sent before ancillary writes" invariant is preserved.

- [ ] **Step 4: Typecheck and run the suite**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no output.

Run: `npx jest`
Expected: every suite passes except `rls-isolation` and `vault`.

- [ ] **Step 5: Commit**

```bash
git add server-v2/src/modules/drivers/linkedin-driver.interface.ts server-v2/src/modules/drivers/playwright-linkedin.driver.ts server-v2/src/worker.ts
git commit -m "feat(linkedin): record the vanity slug a sent invite resolved to"
```

---

### Task 5: Ship it

**Files:** none modified.

**Interfaces:** none.

- [ ] **Step 1: Rebuild the desktop app**

Task 4 changes `playwright-linkedin.driver.ts`, which the desktop app bundles. Per `DEPLOYMENT.md`, a driver change ships ONLY by rebuilding and reinstalling the desktop app — copying to the servers changes nothing at runtime.

Close the ReachPilot app, then run from the repo root:

```bash
cd desktop && npm run dist
```

- [ ] **Step 2: Verify the bundle carries the change**

```bash
grep -c resolvedSlug desktop/dist/win-unpacked/resources/app.asar
```

Expected: non-zero. If it is zero, the bundle is stale — re-run `npm run build:agent` and check again before installing.

- [ ] **Step 3: Install and verify the installed app**

Install `desktop/dist/ReachPilot Setup 0.1.0.exe`, then:

```bash
grep -c resolvedSlug "$LOCALAPPDATA/Programs/ReachPilot/resources/app.asar"
```

Expected: non-zero. A zero here means the installer did not replace the app — this exact check caught an installed bundle sitting two days behind its source on 2026-08-26.

- [ ] **Step 4: Deploy the server side**

`jobs.service.ts` and `profile-key.ts` are API code; `worker.ts` and the driver interface are shared. Copy to both VMs and restart, per `DEPLOYMENT.md` Runbook A. One `scp` per command:

```bash
scp -i ~/.ssh/oci_reachpilot.key server-v2/src/modules/jobs/profile-key.ts ubuntu@129.225.104.114:/opt/ReachPilot/server-v2/src/modules/jobs/profile-key.ts
```

Repeat for `server-v2/src/modules/jobs/jobs.service.ts`, `server-v2/src/modules/drivers/linkedin-driver.interface.ts` and `server-v2/src/worker.ts`, to `129.225.104.114` (api) and `129.225.68.89` (worker). Then:

```bash
ssh -i ~/.ssh/oci_reachpilot.key ubuntu@129.225.104.114 "pm2 restart rp-api --update-env"
```

```bash
ssh -i ~/.ssh/oci_reachpilot.key ubuntu@129.225.68.89 "pm2 restart rp-worker --update-env"
```

- [ ] **Step 5: Confirm the API is serving**

```bash
curl -s https://api.reachpilot.dpdns.org/api/health
```

Expected: `{"status":"ok",…}`.

- [ ] **Step 6: Verify against the real data**

Upload a list that contains at least one profile already invited from this workspace. The toast must report a non-zero skipped count, and the queued total must be the list size minus that count. Then check the activity line records the same numbers.

- [ ] **Step 7: Deploy the frontend**

`src/` is served from Vercel. Push the branch and let the Vercel deployment run; the desktop app loads the hosted dashboard, so the toast change only appears after that deploy.

---

## Notes for the implementer

- **Do not** add a database column for `resolvedSlug`. The app DB role cannot run DDL; the payload JSON is the only option available.
- **Do not** resolve URNs by visiting profiles anywhere in this feature. A hundred-row list would mean a hundred page loads that no prospect ever sees — slow, and the traffic shape that gets accounts challenged.
- The 159 invites already sent carry no `resolvedSlug`. They match only on the URL form they were sent with. This is an accepted limit recorded in the spec, not a gap to close.
- Uploading while a previous batch is still queued can still queue a duplicate, because only SENT jobs are matched. Clearing the queue before uploading avoids it. This was a deliberate decision, also recorded in the spec.

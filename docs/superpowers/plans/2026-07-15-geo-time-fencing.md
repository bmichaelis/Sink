# Geo/Time Fencing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a link refuse to work outside an allowed country or outside a daily active-hours window.

**Architecture:** Two independent optional fields (`allowedCountries`, `activeHours`) on `LinkSchema`. A pure resolver, `evaluateFence(link, country, nowMs)`, returns `'geo' | 'hours' | null`. The redirect middleware calls it as a **gate** immediately above the hit-limit check — and therefore above the hit-count increment, so a blocked visitor never burns a hit.

**Tech Stack:** Nuxt 4, Nitro on Cloudflare Workers, Zod, TanStack Form, shadcn-vue, Tailwind v4, `@nuxtjs/i18n`, Vitest (`@cloudflare/vitest-pool-workers`).

**Spec:** `docs/superpowers/specs/2026-07-15-geo-time-fencing-design.md` — read its "Decisions made without you" table; those decisions are binding for this plan.

## Global Constraints

- **The vitest suite DOES run here, but only with the `ai` binding removed.** Workers AI has no local emulation, so wrangler opens a *remote* proxy session that our scoped token cannot authenticate, and then **every binding (including KV) is `undefined`** and all tests fail with confusing errors. To run tests:
  ```bash
  cp wrangler.jsonc /tmp/wrangler-backup.jsonc
  python3 - <<'PY'
  p='wrangler.jsonc'; s=open(p).read()
  old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
  assert old in s, "AI block not found"
  open(p,'w').write(s.replace(old,''))
  PY
  printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
  pnpm vitest run tests/redirect.spec.ts
  git checkout wrangler.jsonc && rm -f .env    # ALWAYS restore
  ```
  **`wrangler.jsonc` and `.env` must NEVER be committed.** Restore before every commit; `git status` must be clean of them.
- **Expected suite baseline:** `tests/api/stats.spec.ts` and `tests/api/logs.spec.ts` fail (22 tests) without Analytics Engine credentials. That is pre-existing on `master` and NOT your problem. Every other file must pass.
- **Never build or run dev with `CI=true`.** `nuxt.config.ts` uses `preset: !import.meta.env.CI ? 'cloudflare-module' : undefined`; `CI=true` silently produces a broken non-Worker bundle. `CI=true` IS fine for `pnpm types:check`.
- Work only in the worktree `/home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing` on branch `worktree-12-geo-time-fencing`. **Never commit to `master`**; never `cd` to `/home/ubuntu/repos/Sink`.
- Code style: 2-space indent, single quotes, **no semicolons**, trailing commas. Run `pnpm lint:fix` before every commit.
- All code comments and docs in English.
- `LinkSchema` must stay a flat `z.object` — consumers read `LinkSchema.shape`. **No top-level `.refine()`.** (A refinement on a *nested leaf* field is fine and is used deliberately for `tz`.)
- Redirect tests assert **302**, not 301 — `wrangler.jsonc` pins `NUXT_REDIRECT_STATUS_CODE: "302"` and the vitest pool reads that config.
- Conventional Commits with `(#12)` in the subject. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- **Binding semantics:** allowlist = only listed countries pass; **unknown country blocks (fail-closed)**. Active-hours window is **start-inclusive, end-exclusive**; `start > end` wraps midnight; **`start === end` means always active**. Both fences return **403**.

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/utils/timezone.ts` | **New.** `isValidTimezone` — moved from `server/utils/time.ts` so `shared/` schemas can use it |
| `server/utils/time.ts` | Import `isValidTimezone` from shared; keep exporting `getSafeTimezone` |
| `shared/schemas/link.ts` | `allowedCountries` + `activeHours` fields |
| `shared/types/link.ts` | Form-shape overrides for both fields |
| `server/utils/link-processing.ts` | Both fields in `editableOptionalLinkFields` |
| `layers/dashboard/app/components/dashboard/links/editor/Form.vue` | Map both fields ⇄ API shape |
| `server/utils/fencing.ts` | **New.** Pure `evaluateFence` — the whole feature's logic |
| `server/middleware/1.redirect.ts` | The gate + parameterized `renderExpiredPage` + `renderFencedPage` |
| `tests/unit/fencing.spec.ts` | **New.** Pure unit tests for `evaluateFence` |
| `tests/redirect.spec.ts` | Integration tests incl. the hit-preservation regression |
| `.../editor/Advanced.vue` | Two accordion sections |
| `.../links/Link.vue` | ShieldBan badge |
| `i18n/locales/*.json` (10) | Copy |

---

## Task 1: Schema, shared timezone util, and form wiring

Deliverable: both fields persist through create → query → edit → clear, and an invalid timezone is rejected with 400.

**Files:**
- Create: `shared/utils/timezone.ts`
- Modify: `server/utils/time.ts:15-23`
- Modify: `shared/schemas/link.ts` (after line 62)
- Modify: `shared/types/link.ts:18-28`
- Modify: `server/utils/link-processing.ts:16`
- Modify: `layers/dashboard/app/components/dashboard/links/editor/Form.vue` (lines 64 and 104 areas)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isValidTimezone(tz: string): boolean` from `#shared/utils/timezone`
  - `Link['allowedCountries']` — `string[] | undefined`
  - `Link['activeHours']` — `{ start: string, end: string, tz: string } | undefined`
  - `LinkFormData['allowedCountries']` — `string[]` (always an array)
  - `LinkFormData['activeHours']` — `{ start: string, end: string, tz: string }` (always an object; empty strings mean "unset")

- [ ] **Step 1: Move `isValidTimezone` into shared**

Create `shared/utils/timezone.ts`:

```ts
// Lives in shared/ because both the Zod schema (shared/) and the stats
// endpoints (server/) validate timezones, and shared/ cannot import server/.
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  }
  catch {
    return false
  }
}
```

Then in `server/utils/time.ts`, replace the whole `isValidTimezone` function (lines 15-23) with an import at the top of the file and keep `getSafeTimezone` delegating to it. The file must end up as:

```ts
import type { H3Event } from 'h3'
import { isValidTimezone } from '#shared/utils/timezone'

export function getExpiration(event: H3Event, expiration: number | undefined) {
  const { previewMode } = useRuntimeConfig(event).public
  if (previewMode) {
    const { previewTTL } = useAppConfig()
    const previewExpiration = Math.floor(Date.now() / 1000) + previewTTL
    if (!expiration || expiration > previewExpiration)
      expiration = Math.floor(Date.now() / 1000) + previewTTL
  }

  return expiration
}

export function getSafeTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'Etc/UTC'
}
```

`getSafeTimezone` is used by `server/api/stats/heatmap.get.ts:17` and `server/api/stats/views.get.ts:24` — do not change its signature or behavior.

- [ ] **Step 2: Add both fields to `LinkSchema`**

In `shared/schemas/link.ts`, add this import at the top alongside the existing imports:

```ts
import { isValidTimezone } from '#shared/utils/timezone'
```

Then find the `schedule` field (lines 59-62):

```ts
  schedule: z.array(z.object({
    until: z.number().int().safe(),
    url: z.string().trim().url().max(2048),
  })).max(10).optional(),
```

Insert immediately **after** it:

```ts
  // Access fences. Both are gates: they decide whether the link works at all,
  // not where it points. An allowlist means "only these" — an unknown country
  // is therefore blocked, not admitted.
  allowedCountries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(50).optional(),
  // Daily window, start-inclusive and end-exclusive. start > end wraps
  // midnight; start === end means always active.
  activeHours: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    tz: z.string().trim().min(1).max(64).refine(isValidTimezone, 'Invalid IANA timezone'),
  }).optional(),
```

The `.refine()` is on a nested leaf, so `LinkSchema` itself stays a flat `z.object` and `LinkSchema.shape` is unaffected.

- [ ] **Step 3: Override both fields in the form field type**

In `shared/types/link.ts`, replace lines 18-28 entirely:

```ts
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'schedule' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes' | 'batchId' | 'batchSeq' | 'batchMode' | 'claimedAt'> & {
  expiration: DateValue | undefined
  geo: { country: string, url: string }[]
  // A row being typed has a URL but not yet a time, so `until` is nullable here
  // even though the schema requires it.
  schedule: { until: number | undefined, url: string }[]
  maxHits: number | undefined
  viewExpireSeconds: number | undefined
  notifyCooldownMinutes: number | undefined
}
```

with:

```ts
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'schedule' | 'allowedCountries' | 'activeHours' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes' | 'batchId' | 'batchSeq' | 'batchMode' | 'claimedAt'> & {
  expiration: DateValue | undefined
  geo: { country: string, url: string }[]
  // A row being typed has a URL but not yet a time, so `until` is nullable here
  // even though the schema requires it.
  schedule: { until: number | undefined, url: string }[]
  // Always an array in the form; empty means "no restriction".
  allowedCountries: string[]
  // Always an object in the form. Empty strings mean "unset" — a half-filled
  // window (start typed, end not) must not fail schema validation mid-edit.
  activeHours: { start: string, end: string, tz: string }
  maxHits: number | undefined
  viewExpireSeconds: number | undefined
  notifyCooldownMinutes: number | undefined
}
```

Both names must appear in the `Omit` list **and** the intersection; omitting either from `Omit` produces `never` for that field.

- [ ] **Step 4: Make both fields editable and clearable**

In `server/utils/link-processing.ts`, find line 16 (`'schedule',`) inside `editableOptionalLinkFields` and insert immediately after it:

```ts
  'allowedCountries',
  'activeHours',
```

- [ ] **Step 5: Seed the form defaults**

In `layers/dashboard/app/components/dashboard/links/editor/Form.vue`, find line 64:

```ts
    schedule: (props.link.schedule ?? []).map(s => ({ until: s.until as number | undefined, url: s.url })),
```

Add immediately **after** it (inside `defaultValues`):

```ts
    allowedCountries: props.link.allowedCountries ? [...props.link.allowedCountries] : [],
    activeHours: props.link.activeHours
      ? { ...props.link.activeHours }
      : { start: '', end: '', tz: '' },
```

- [ ] **Step 6: Map the form values back to the API shape on submit**

In the same file's `onSubmit`, find this line:

```ts
        schedule: scheduleEntries.length > 0 ? scheduleEntries : undefined,
```

Add immediately **after** it:

```ts
        allowedCountries: value.allowedCountries.filter(c => c.trim()).length > 0
          ? value.allowedCountries.filter(c => c.trim()).map(c => c.trim().toUpperCase())
          : undefined,
        // Only send a window when it is complete; a half-filled one is still
        // being typed and must not 400 the whole save.
        activeHours: (value.activeHours.start && value.activeHours.end && value.activeHours.tz)
          ? { start: value.activeHours.start, end: value.activeHours.end, tz: value.activeHours.tz.trim() }
          : undefined,
```

Sending `undefined` is what makes clearing work — `cleanupOptionalLinkFields` treats an absent value as a delete.

- [ ] **Step 7: Typecheck**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
```

Expected: **no output** (zero errors outside the pre-existing `Search.vue` set).

- [ ] **Step 8: Round-trip both fields through the real API**

Set up the test environment (see Global Constraints for why):

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
cp wrangler.jsonc /tmp/wrangler-backup.jsonc
python3 - <<'PY'
p='wrangler.jsonc'; s=open(p).read()
old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
assert old in s, "AI block not found"
open(p,'w').write(s.replace(old,''))
PY
printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
pnpm dev > /tmp/fence-dev.log 2>&1 &
sleep 45
grep -E "Local:|Unable to find an available port" /tmp/fence-dev.log
```

**Read the port off that banner** — if 7465 is taken, nuxt silently uses 3000 and curling the wrong port produces misleading errors. Set `PORT` accordingly, then:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
PORT=<the port from the banner>
curl -s -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"fence-rt","allowedCountries":["us","CA"],"activeHours":{"start":"09:00","end":"17:00","tz":"America/Denver"}}' \
  | python3 -m json.tool
```

Expected: 201-shaped JSON whose `link.allowedCountries` is `["US","CA"]` (**note: lowercase `us` came back uppercased** — proving the schema transform) and whose `link.activeHours` round-trips intact.

Read it back (**note `/api/link/query` returns the link UNWRAPPED — no `{link:...}` envelope**):

```bash
curl -s -H 'Authorization: Bearer SinkCool' "http://localhost:$PORT/api/link/query?slug=fence-rt" | python3 -m json.tool
```

Expected: both fields present with the same values.

Invalid timezone must be rejected:

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"fence-badtz","activeHours":{"start":"09:00","end":"17:00","tz":"Mars/Olympus"}}'
```

Expected: `400`.

Bad country code and bad time format must be rejected:

```bash
for body in \
  '{"url":"https://example.com","slug":"fence-badc","allowedCountries":["USA"]}' \
  '{"url":"https://example.com","slug":"fence-badt","activeHours":{"start":"9am","end":"17:00","tz":"UTC"}}' ; do
  curl -s -o /dev/null -w "HTTP %{http_code}\n" -X POST "http://localhost:$PORT/api/link/create" \
    -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' -d "$body"
done
```

Expected: `400` twice.

Clearing must work:

```bash
curl -s -X PUT "http://localhost:$PORT/api/link/edit" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"fence-rt"}' | python3 -m json.tool
curl -s -H 'Authorization: Bearer SinkCool' "http://localhost:$PORT/api/link/query?slug=fence-rt" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('allowedCountries present:', 'allowedCountries' in d);print('activeHours present:', 'activeHours' in d)"
```

Expected: both `False`.

- [ ] **Step 9: Restore config, lint, and commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
pkill -f '[n]uxt dev'
git checkout wrangler.jsonc && rm -f .env
git status --short   # must NOT list wrangler.jsonc or .env
pnpm lint:fix
git add shared/utils/timezone.ts server/utils/time.ts shared/schemas/link.ts shared/types/link.ts server/utils/link-processing.ts layers/dashboard/app/components/dashboard/links/editor/Form.vue
git commit -m "feat: add geo/time fencing fields to link schema and form (#12)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Note the `[n]` bracket in `pkill -f '[n]uxt dev'` — a plain `pkill -f 'nuxt dev'` matches the shell running it and kills itself.

---

## Task 2: The fence resolver and the gate

The feature itself. Deliverable: a blocked visitor gets 403 and does **not** burn a hit.

**Files:**
- Create: `server/utils/fencing.ts`
- Create: `tests/unit/fencing.spec.ts`
- Modify: `server/middleware/1.redirect.ts` (the `renderExpiredPage` definition at :13, a new `renderFencedPage`, and the gate above the hit-limit check at :324)
- Modify: `tests/redirect.spec.ts`

**Interfaces:**
- Consumes: `Link['allowedCountries']` (`string[] | undefined`) and `Link['activeHours']` (`{ start, end, tz } | undefined`) from Task 1.
- Produces: `evaluateFence(link: FenceableLink, country: string | undefined, nowMs: number): FenceReason | null` where `type FenceReason = 'geo' | 'hours'`, auto-imported into server code.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/fencing.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { evaluateFence } from '../../server/utils/fencing'

// A fixed instant: 2026-07-15T18:30:00Z == 12:30 in America/Denver (UTC-6 in July).
const NOON_MST = Date.UTC(2026, 6, 15, 18, 30)

describe('evaluateFence', () => {
  it('returns null when the link has no fence', () => {
    expect(evaluateFence({}, 'US', NOON_MST)).toBe(null)
  })

  it('returns null when the country is allowed', () => {
    expect(evaluateFence({ allowedCountries: ['US', 'CA'] }, 'US', NOON_MST)).toBe(null)
  })

  it('matches the country case-insensitively', () => {
    expect(evaluateFence({ allowedCountries: ['US'] }, 'us', NOON_MST)).toBe(null)
  })

  it('blocks a country outside the allowlist', () => {
    expect(evaluateFence({ allowedCountries: ['US'] }, 'DE', NOON_MST)).toBe('geo')
  })

  it('blocks an unknown country when an allowlist is set (fail-closed)', () => {
    expect(evaluateFence({ allowedCountries: ['US'] }, undefined, NOON_MST)).toBe('geo')
  })

  it('ignores an empty allowlist', () => {
    expect(evaluateFence({ allowedCountries: [] }, undefined, NOON_MST)).toBe(null)
  })

  it('returns null inside the active window', () => {
    expect(evaluateFence({ activeHours: { start: '09:00', end: '17:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('blocks outside the active window', () => {
    expect(evaluateFence({ activeHours: { start: '13:00', end: '17:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('treats start as inclusive', () => {
    // 12:30 MST exactly at start
    expect(evaluateFence({ activeHours: { start: '12:30', end: '17:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('treats end as exclusive', () => {
    // 12:30 MST exactly at end
    expect(evaluateFence({ activeHours: { start: '09:00', end: '12:30', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('handles an overnight window that is currently closed', () => {
    // 22:00 -> 06:00 does not include 12:30
    expect(evaluateFence({ activeHours: { start: '22:00', end: '06:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('handles an overnight window that is currently open', () => {
    // 06:00 -> 01:00 wraps midnight and includes 12:30
    expect(evaluateFence({ activeHours: { start: '06:00', end: '01:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('treats start === end as always active', () => {
    expect(evaluateFence({ activeHours: { start: '09:00', end: '09:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('respects the timezone (same instant, different zone)', () => {
    // 18:30 UTC is inside 17:00-19:00 UTC but outside it in Denver (12:30)
    expect(evaluateFence({ activeHours: { start: '17:00', end: '19:00', tz: 'Etc/UTC' } }, 'US', NOON_MST)).toBe(null)
    expect(evaluateFence({ activeHours: { start: '17:00', end: '19:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('reads midnight as 00:00, not 24:00', () => {
    // 2026-01-01T07:00Z == 00:00 America/Denver (UTC-7 in January).
    const midnightMST = Date.UTC(2026, 0, 1, 7, 0)
    // A 00:00-08:00 window must include midnight itself.
    expect(evaluateFence({ activeHours: { start: '00:00', end: '08:00', tz: 'America/Denver' } }, 'US', midnightMST)).toBe(null)
  })

  it('checks geo before hours when both would block', () => {
    expect(evaluateFence(
      { allowedCountries: ['US'], activeHours: { start: '13:00', end: '17:00', tz: 'America/Denver' } },
      'DE',
      NOON_MST,
    )).toBe('geo')
  })

  it('does not throw on an invalid timezone', () => {
    expect(() => evaluateFence({ activeHours: { start: '09:00', end: '17:00', tz: 'Mars/Olympus' } }, 'US', NOON_MST)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Set up the test env first (see Global Constraints):

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
cp wrangler.jsonc /tmp/wrangler-backup.jsonc
python3 - <<'PY'
p='wrangler.jsonc'; s=open(p).read()
old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
assert old in s, "AI block not found"
open(p,'w').write(s.replace(old,''))
PY
printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
pnpm vitest run tests/unit/fencing.spec.ts 2>&1 | tail -15
```

Expected: FAIL — cannot resolve `server/utils/fencing`.

- [ ] **Step 3: Write the resolver**

Create `server/utils/fencing.ts`:

```ts
// Structural rather than importing `Link`, mirroring server/utils/schedule.ts:
// it keeps this module trivially unit-testable, and TypeScript still checks a
// real Link against it at the call site.
interface FenceableLink {
  allowedCountries?: string[]
  activeHours?: { start: string, end: string, tz: string }
}

export type FenceReason = 'geo' | 'hours'

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(':')
  return Number(h) * 60 + Number(m)
}

// Minutes since midnight in `tz` for the given instant. `hourCycle: 'h23'`
// rather than `hour12: false`: the latter has historically reported midnight
// as "24" under some ICU builds, which would invert every overnight window.
function minutesInZone(nowMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(nowMs))
  const hour = Number(parts.find(p => p.type === 'hour')?.value)
  const minute = Number(parts.find(p => p.type === 'minute')?.value)
  return hour * 60 + minute
}

// Does this visitor get through the link's access fences at all? Returns the
// reason they were turned away, or null if they pass. Runs in the redirect hot
// path and must never throw.
export function evaluateFence(link: FenceableLink, country: string | undefined, nowMs: number): FenceReason | null {
  const allowed = link.allowedCountries
  if (allowed?.length) {
    // An allowlist means "only these", so a country we cannot determine is
    // turned away rather than admitted.
    if (!country || !allowed.includes(country.toUpperCase()))
      return 'geo'
  }

  const hours = link.activeHours
  if (hours) {
    const start = hhmmToMinutes(hours.start)
    const end = hhmmToMinutes(hours.end)
    // A zero-width window is meaningless; treat it as always active so a typo
    // cannot silently kill a link.
    if (start !== end) {
      let current: number
      try {
        current = minutesInZone(nowMs, hours.tz)
      }
      catch {
        // Validation rejects bad zones at the API boundary; if one somehow
        // reaches here, fall back to UTC rather than throwing mid-redirect.
        current = minutesInZone(nowMs, 'Etc/UTC')
      }
      const active = start < end
        ? current >= start && current < end
        : current >= start || current < end // wraps midnight
      if (!active)
        return 'hours'
    }
  }

  return null
}
```

- [ ] **Step 4: Run the unit test and watch it pass**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
pnpm vitest run tests/unit/fencing.spec.ts 2>&1 | tail -8
```

Expected: all tests pass. **If `reads midnight as 00:00, not 24:00` fails, the Workers ICU build has the `24:00` quirk** — report it rather than deleting the test; the fix is to normalize `hour % 24` in `minutesInZone`.

- [ ] **Step 5: Parameterize `renderExpiredPage` and add `renderFencedPage`**

In `server/middleware/1.redirect.ts`, change the signature on line 13 from:

```ts
function renderExpiredPage(): string {
```

to:

```ts
function renderExpiredPage(title = 'Link Expired', message = 'This link has reached its limit and is no longer available.'): string {
```

Inside that same function's template, replace the hardcoded heading and paragraph:

```html
    <h1>Link Expired</h1>
    <p>This link has reached its limit and is no longer available.</p>
```

with:

```html
    <h1>${title}</h1>
    <p>${message}</p>
```

Also change the `<title>` line in that template from `<title>Link Expired</title>` to `<title>${title}</title>`.

The defaults keep both existing call sites (lines ~326 and ~349) rendering byte-for-byte what they render today — do not modify those call sites.

Immediately after the `renderExpiredPage` function's closing brace, add:

```ts
// Visitor-facing block pages are English-only, matching renderExpiredPage.
function renderFencedPage(reason: FenceReason): string {
  return reason === 'geo'
    ? renderExpiredPage('Not Available Here', 'This link isn\'t available in your region.')
    : renderExpiredPage('Outside Active Hours', 'This link is only active during certain hours. Please try again later.')
}
```

- [ ] **Step 6: Add the gate**

In the same file, find the hit-limit check (around line 324):

```ts
      // --- Hit limit + self-destruct handling (applies to redirect and text links) ---
      if (link.maxHits !== undefined && (link.hitCount || 0) >= link.maxHits) {
        setResponseStatus(event, 410)
        return sendNoStoreHtml(renderExpiredPage())
      }
```

Insert immediately **BEFORE** that comment line:

```ts
      // --- Access fences (applies to redirect and text links) ---
      // Must stay above the hit-limit gate, and therefore above the hit-count
      // increment below it: a blocked visitor must not burn a hit, and should
      // not learn whether the link is expired.
      const fenceReason = evaluateFence(link, event.context.cloudflare?.request?.cf?.country, Date.now())
      if (fenceReason) {
        setResponseStatus(event, 403)
        return sendNoStoreHtml(renderFencedPage(fenceReason))
      }

```

`evaluateFence` and `FenceReason` need no import — `server/utils/` is auto-imported. Change nothing else.

- [ ] **Step 7: Add integration tests**

In `tests/redirect.spec.ts`, add these to the existing `describe('/')` block. The file already defines `type CfRequestInit = RequestInit & { cf?: { country?: string } }` and a `createdSlugs` array with an `afterAll` cleanup — reuse both, exactly as the existing geo test does.

```ts
  it('redirects normally from an allowed country', async () => {
    const slug = `fence-allow-${crypto.randomUUID()}`
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/allowed',
      slug,
      allowedCountries: ['US'],
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const options: CfRequestInit = { redirect: 'manual', cf: { country: 'US' } }
    const response = await fetch(`/${slug}`, options as RequestInit)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/allowed')
  })

  it('blocks with 403 from a country outside the allowlist', async () => {
    const slug = `fence-block-${crypto.randomUUID()}`
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/allowed',
      slug,
      allowedCountries: ['US'],
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const options: CfRequestInit = { redirect: 'manual', cf: { country: 'DE' } }
    const response = await fetch(`/${slug}`, options as RequestInit)

    expect(response.status).toBe(403)
    expect(response.headers.get('Location')).toBe(null)
  })

  it('blocks with 403 outside the active-hours window', async () => {
    const slug = `fence-hours-${crypto.randomUUID()}`
    // Build a window in UTC that deliberately excludes "now", so the test is
    // deterministic rather than dependent on the wall clock.
    const nowHour = new Date().getUTCHours()
    const start = `${String((nowHour + 2) % 24).padStart(2, '0')}:00`
    const end = `${String((nowHour + 4) % 24).padStart(2, '0')}:00`

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/shop',
      slug,
      activeHours: { start, end, tz: 'Etc/UTC' },
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })

    expect(response.status).toBe(403)
  })

  it('redirects inside the active-hours window', async () => {
    const slug = `fence-open-${crypto.randomUUID()}`
    // A window that spans the whole day in UTC always includes "now".
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/shop',
      slug,
      activeHours: { start: '00:00', end: '23:59', tz: 'Etc/UTC' },
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/shop')
  })

  it('does not burn a hit when a visitor is fenced out', async () => {
    const slug = `fence-hit-${crypto.randomUUID()}`
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/voucher',
      slug,
      maxHits: 1,
      allowedCountries: ['US'],
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const blocked: CfRequestInit = { redirect: 'manual', cf: { country: 'DE' } }
    const blockedResponse = await fetch(`/${slug}`, blocked as RequestInit)
    expect(blockedResponse.status).toBe(403)

    // The blocked scan must not have consumed the single available hit.
    const queryResponse = await fetchWithAuth(`/api/link/query?slug=${slug}`)
    const link = await queryResponse.json() as { hitCount?: number }
    expect(link.hitCount ?? 0).toBe(0)

    // ...and the link still works for someone who is allowed through.
    const allowed: CfRequestInit = { redirect: 'manual', cf: { country: 'US' } }
    const allowedResponse = await fetch(`/${slug}`, allowed as RequestInit)
    expect(allowedResponse.status).toBe(302)
    expect(allowedResponse.headers.get('Location')).toBe('https://example.com/voucher')
  })
```

The last test imports `fetchWithAuth`. Check `tests/redirect.spec.ts`'s existing import line from `'./utils'` and **add `fetchWithAuth` to it** if it is not already there.

- [ ] **Step 8: Run the redirect suite**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
pnpm vitest run tests/redirect.spec.ts tests/unit/fencing.spec.ts 2>&1 | tail -10
```

Expected: **all pass**, including the pre-existing device/geo/schedule tests (proving the gate is inert for unfenced links).

- [ ] **Step 9: Restore config, gates, and commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
git checkout wrangler.jsonc && rm -f .env
git status --short   # must NOT list wrangler.jsonc or .env
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
pnpm lint:fix
git add server/utils/fencing.ts tests/unit/fencing.spec.ts server/middleware/1.redirect.ts tests/redirect.spec.ts
git commit -m "feat: gate redirects on geo and active-hours fences (#12)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Typecheck expected: no output.

---

## Task 3: Editor UI, card badge, and copy

Deliverable: both fences are editable in the dashboard and visible on the card.

**Files:**
- Modify: `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue`
- Modify: `layers/dashboard/app/components/dashboard/links/Link.vue` (lucide import on line 4; badge after the schedule badge that starts at line 355)
- Modify: all 10 files in `i18n/locales/`

**Interfaces:**
- Consumes: `LinkFormData['allowedCountries']` (`string[]`) and `LinkFormData['activeHours']` (`{ start, end, tz }`) from Task 1; `Link['allowedCountries']`, `Link['activeHours']`.
- Produces: no new exports.

- [ ] **Step 1: Add the English copy**

In `i18n/locales/en-US.json`, find `"add_schedule_entry"` inside `links.form` and add immediately after it:

```json
      "geo_restrictions": "Geo Restrictions",
      "geo_restrictions_description": "Only visitors in these countries can open the link. Leave empty for no restriction.",
      "add_allowed_country": "Add Country",
      "active_hours": "Active Hours",
      "active_hours_description": "The link only works during this daily window. Leave empty to always work.",
      "active_hours_start": "Start",
      "active_hours_end": "End",
      "active_hours_tz": "Timezone",
```

Then find `"scheduled_destinations"` inside `links` (a sibling of `notifications_on`) and add after it:

```json
    "access_restricted": "Access restricted"
```

Mind the JSON commas.

- [ ] **Step 2: Add the same keys to the other 9 locales**

Key names are identical everywhere; only values are translated. Insert in the same structural positions as `en-US.json`.

| Locale | `geo_restrictions` | `geo_restrictions_description` | `add_allowed_country` | `active_hours` | `active_hours_description` | `active_hours_start` | `active_hours_end` | `active_hours_tz` | `access_restricted` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| de-DE | Geo-Beschränkungen | Nur Besucher in diesen Ländern können den Link öffnen. Leer lassen für keine Beschränkung. | Land hinzufügen | Aktive Zeiten | Der Link funktioniert nur in diesem täglichen Zeitfenster. Leer lassen, damit er immer funktioniert. | Start | Ende | Zeitzone | Zugriff beschränkt |
| fr-FR | Restrictions géographiques | Seuls les visiteurs de ces pays peuvent ouvrir le lien. Laisser vide pour aucune restriction. | Ajouter un pays | Heures d'activité | Le lien ne fonctionne que pendant cette plage horaire quotidienne. Laisser vide pour qu'il fonctionne toujours. | Début | Fin | Fuseau horaire | Accès restreint |
| id-ID | Pembatasan Geo | Hanya pengunjung di negara ini yang dapat membuka tautan. Kosongkan untuk tanpa pembatasan. | Tambah Negara | Jam Aktif | Tautan hanya berfungsi dalam rentang waktu harian ini. Kosongkan agar selalu berfungsi. | Mulai | Selesai | Zona Waktu | Akses dibatasi |
| it-IT | Restrizioni geografiche | Solo i visitatori di questi paesi possono aprire il link. Lascia vuoto per nessuna restrizione. | Aggiungi paese | Orario attivo | Il link funziona solo in questa fascia oraria giornaliera. Lascia vuoto per farlo funzionare sempre. | Inizio | Fine | Fuso orario | Accesso limitato |
| pt-BR | Restrições geográficas | Apenas visitantes nestes países podem abrir o link. Deixe vazio para nenhuma restrição. | Adicionar país | Horário ativo | O link só funciona nesta janela diária. Deixe vazio para funcionar sempre. | Início | Fim | Fuso horário | Acesso restrito |
| pt-PT | Restrições geográficas | Apenas visitantes nestes países podem abrir a ligação. Deixe vazio para nenhuma restrição. | Adicionar país | Horário ativo | A ligação só funciona nesta janela diária. Deixe vazio para funcionar sempre. | Início | Fim | Fuso horário | Acesso restrito |
| vi-VN | Giới hạn khu vực | Chỉ khách truy cập ở các quốc gia này mới mở được liên kết. Để trống nếu không giới hạn. | Thêm quốc gia | Giờ hoạt động | Liên kết chỉ hoạt động trong khung giờ hằng ngày này. Để trống để luôn hoạt động. | Bắt đầu | Kết thúc | Múi giờ | Truy cập bị giới hạn |
| zh-CN | 地区限制 | 仅这些国家/地区的访问者可以打开链接。留空则不限制。 | 添加国家/地区 | 活动时段 | 链接仅在该每日时段内有效。留空则始终有效。 | 开始 | 结束 | 时区 | 访问受限 |
| zh-TW | 地區限制 | 僅這些國家/地區的訪客可以開啟連結。留空則不限制。 | 新增國家/地區 | 活動時段 | 連結僅在該每日時段內有效。留空則一律有效。 | 開始 | 結束 | 時區 | 存取受限 |

Validate all 10 parse and none were missed:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
for f in i18n/locales/*.json; do python3 -m json.tool "$f" > /dev/null && echo "ok $f"; done
grep -L "add_allowed_country" i18n/locales/*.json
grep -L "access_restricted" i18n/locales/*.json
```

Expected: `ok` ×10, and **no output** from either `grep -L`.

- [ ] **Step 3: Add the row helper to `Advanced.vue`**

In `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue`, find `removeScheduleEntry` and add immediately after it:

```ts
function removeAllowedCountry(countries: string[], index: number | string) {
  const targetIndex = Number(index)
  return countries.filter((_, countryIndex) => countryIndex !== targetIndex)
}

function updateAllowedCountry(countries: string[], index: number | string, value: string) {
  const targetIndex = Number(index)
  return countries.map((country, countryIndex) => countryIndex === targetIndex ? value.toUpperCase() : country)
}
```

- [ ] **Step 4: Auto-open both sections when set**

In the same file, inside `defaultOpenItems`, find `items.push('schedule')` and its enclosing `if` block, then add immediately after that block:

```ts
  const countriesVal = props.form.getFieldValue('allowedCountries')
  if (Array.isArray(countriesVal) && countriesVal.length > 0) {
    items.push('geo_restrictions')
  }
  const hoursVal = props.form.getFieldValue('activeHours') as { start?: string, end?: string } | undefined
  if (hoursVal?.start && hoursVal?.end) {
    items.push('active_hours')
  }
```

- [ ] **Step 5: Add the Geo Restrictions section**

In the same file's `<template>`, find the `<AccordionItem value="schedule">` block (starts at line 378) and its closing `</AccordionItem>`. Insert this **immediately after** that closing tag:

```vue
    <AccordionItem value="geo_restrictions">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.geo_restrictions') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="allowedCountries">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.geo_restrictions_description') }}
              </FieldDescription>
              <div
                v-for="(item, i) in field.state.value" :key="i" class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field class="flex-1">
                  <DashboardLinksEditorCountrySelect
                    :model-value="item"
                    :placeholder="$t('links.form.select_country')"
                    :search-placeholder="$t('links.form.search_country')"
                    :empty-text="$t('links.form.no_country_found')"
                    @update:model-value="field.handleChange(updateAllowedCountry(field.state.value, i, $event))"
                  />
                </Field>
                <Button type="button" variant="ghost" size="icon" @click="field.handleChange(removeAllowedCountry(field.state.value, i))">
                  <Trash2 class="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" @click="field.handleChange([...field.state.value, ''])">
                <Plus class="mr-2 h-4 w-4" /> {{ $t('links.form.add_allowed_country') }}
              </Button>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="active_hours">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.active_hours') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="activeHours">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.active_hours_description') }}
              </FieldDescription>
              <div
                class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field class="w-full sm:w-32">
                  <FieldLabel class="text-xs">
                    {{ $t('links.form.active_hours_start') }}
                  </FieldLabel>
                  <Input
                    type="time"
                    :model-value="field.state.value.start"
                    :aria-label="$t('links.form.active_hours_start')"
                    @input="field.handleChange({ ...field.state.value, start: ($event.target as HTMLInputElement).value, tz: field.state.value.tz || getTimeZone() })"
                  />
                </Field>
                <Field class="w-full sm:w-32">
                  <FieldLabel class="text-xs">
                    {{ $t('links.form.active_hours_end') }}
                  </FieldLabel>
                  <Input
                    type="time"
                    :model-value="field.state.value.end"
                    :aria-label="$t('links.form.active_hours_end')"
                    @input="field.handleChange({ ...field.state.value, end: ($event.target as HTMLInputElement).value, tz: field.state.value.tz || getTimeZone() })"
                  />
                </Field>
                <Field class="flex-1">
                  <FieldLabel class="text-xs">
                    {{ $t('links.form.active_hours_tz') }}
                  </FieldLabel>
                  <Input
                    :model-value="field.state.value.tz"
                    placeholder="America/Denver"
                    :aria-label="$t('links.form.active_hours_tz')"
                    @input="field.handleChange({ ...field.state.value, tz: ($event.target as HTMLInputElement).value })"
                  />
                </Field>
              </div>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>
```

Notes:
- `select_country`, `search_country`, and `no_country_found` are **existing** keys used by the geo-routing section — reuse them, do not add new ones.
- The start/end handlers default `tz` to the viewer's own zone via `getTimeZone()` (already exported from `app/utils/time.ts` and auto-imported), so a user who sets a window never has to think about the timezone field. If `FieldLabel` does not resolve as an auto-imported shadcn component, check how the rest of the file labels fields and follow that; if there is no such component, replace `<FieldLabel class="text-xs">…</FieldLabel>` with `<span class="text-xs text-muted-foreground">…</span>`.
- `Plus` and `Trash2` are already imported in this file. Add no imports.

- [ ] **Step 6: Add the ShieldBan badge to the link card**

In `layers/dashboard/app/components/dashboard/links/Link.vue`, add `ShieldBan` to the lucide import on line 4, keeping the list alphabetical (it goes after `ShieldAlert`).

Then find the schedule badge block that begins at line 355 with `<template v-if="link.schedule?.length">` and insert immediately after that block's closing `</template>`:

```vue
            <template v-if="link.allowedCountries?.length || link.activeHours">
              <Separator orientation="vertical" />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span
                      class="
                        inline-flex items-center leading-5 whitespace-nowrap
                      "
                    >
                      <ShieldBan aria-hidden="true" class="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{{ $t('links.access_restricted') }}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </template>
```

- [ ] **Step 7: Gates and commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
pnpm lint:fix
git status --short   # must NOT list wrangler.jsonc or .env
git add layers/dashboard/app/components/dashboard/links/editor/Advanced.vue layers/dashboard/app/components/dashboard/links/Link.vue i18n/locales
git commit -m "feat: add geo/time fencing editor sections and card badge (#12)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Typecheck expected: no output. `lint:fix` will reformat the Tailwind class strings — keep its output.

---

## Task 4: Verify the branch and open the PR

**Files:** none modified, plus `~/.cache/claude-pr/worktree-12-geo-time-fencing.md`.

- [ ] **Step 1: Full test suite**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
cp wrangler.jsonc /tmp/wrangler-backup.jsonc
python3 - <<'PY'
p='wrangler.jsonc'; s=open(p).read()
old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
assert old in s, "AI block not found"
open(p,'w').write(s.replace(old,''))
PY
printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
pnpm vitest run 2>&1 | tail -8
git checkout wrangler.jsonc && rm -f .env
```

Expected: only `tests/api/stats.spec.ts` and `tests/api/logs.spec.ts` fail (22 tests — the pre-existing Analytics Engine baseline). Everything else passes.

- [ ] **Step 2: Build with the preset guard**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
unset CI
pnpm build > /tmp/fence-build.log 2>&1; echo "BUILD EXIT: $?"
grep -o '"preset": *"[^"]*"' .output/nitro.json
```

Expected: `BUILD EXIT: 0` and `"preset": "cloudflare-module"`. Never pipe the build through anything that swallows its exit code.

- [ ] **Step 3: Final gates and branch state**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
pnpm lint
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
git status --short
git diff master..HEAD --stat -- wrangler.jsonc
git log --oneline master..HEAD
```

Expected: lint exit 0; no typecheck output; **`git status` clean**; **`wrangler.jsonc` diff EMPTY** (if it is not, `git checkout master -- wrangler.jsonc` and amend); commits only on this branch, nothing on `master`.

- [ ] **Step 4: Push and open the PR**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/12-geo-time-fencing
git push -u origin worktree-12-geo-time-fencing
```

Write the PR body to `~/.cache/claude-pr/worktree-12-geo-time-fencing.md` (line 1 = title, line 2 = blank, line 3+ = body). It must cover: what the two fences do; that the gate sits above the hit-count increment so a blocked visitor never burns a hit (with the test that proves it); the **"Decisions made without you"** table from the spec, verbatim, since the owner has not reviewed them; and the test evidence. End the body with `Closes #12`, then the standard footer.

```bash
F=~/.cache/claude-pr/worktree-12-geo-time-fencing.md
gh pr create --base master --head worktree-12-geo-time-fencing \
  --title "$(head -n 1 "$F")" --body "$(tail -n +3 "$F")"
```

**Do NOT merge.** The owner reviews in the morning.

---

## Self-Review

**Spec coverage:** semantics (allowlist fail-closed, window inclusivity, wrap, `start===end`) → Task 2 Steps 1/3; placement above the hit increment → Task 2 Step 6 + the Step 7 hit-preservation test; 403 → Task 2 Steps 5/6; `renderExpiredPage` parameterization → Task 2 Step 5; schema + tz refine → Task 1 Step 2; `isValidTimezone` move → Task 1 Step 1; editable/clearable → Task 1 Steps 4/6; form shape → Task 1 Step 3; editor → Task 3 Steps 3-5; badge → Task 3 Step 6; i18n ×10 → Task 3 Steps 1-2; unit tests → Task 2 Step 1; integration + regression → Task 2 Step 7; gates → Task 4. No gaps.

**Placeholder scan:** none — every code block is complete, every locale value is spelled out, every command has an expected result.

**Type consistency:** `evaluateFence(link, country, nowMs)` and `FenceReason` are named identically in Task 2 Steps 1/3/6 and in `renderFencedPage`. `LinkFormData['allowedCountries']` (`string[]`) and `['activeHours']` (`{start,end,tz}`) are defined in Task 1 Step 3, seeded in Step 5, consumed by Step 6's submit and by Task 3's helpers and template. `isValidTimezone` is named identically in Task 1 Steps 1-2. Consistent.

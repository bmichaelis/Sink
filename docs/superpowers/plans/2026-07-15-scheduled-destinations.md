# Scheduled Destinations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a link point at different URLs over time, so a printed QR code can follow an event's lifecycle without being reprinted.

**Architecture:** A new optional `schedule` field on `LinkSchema` holds `{ until, url }` entries. A pure resolver, `resolveScheduledUrl(link, nowUnix)`, picks the earliest entry whose `until` is still in the future, falling back to `link.url` once all have passed. The redirect middleware calls it in place of `link.url!` — a one-line change at the existing target-resolution point, leaving geo/device/cloaking behavior untouched.

**Tech Stack:** Nuxt 4, Nitro on Cloudflare Workers, Zod, TanStack Form, shadcn-vue, Tailwind v4, `@nuxtjs/i18n`.

**Spec:** `docs/superpowers/specs/2026-07-15-scheduled-destinations-design.md`

## Global Constraints

- **Running the dev server in this environment requires two workarounds** (discovered during Task 1; neither is a code problem):
  1. **Temporarily remove the `ai` binding from `wrangler.jsonc`.** Workers AI has no local emulation, so wrangler always opens a *remote* proxy session for it, which calls the Cloudflare `/memberships` API. Our scoped deploy token cannot, so **every binding — including KV — comes back `undefined` and all API routes return 500**. Deleting the `"ai": { ... },` block makes the proxy initialize locally ("Using cloudflare-dev emulation in development mode"). **This edit is verification-only and must NEVER be committed** — restore with `git checkout wrangler.jsonc` before any commit.
  2. **Check which port it actually bound.** If 7465 is held by a zombie from an earlier run, nuxt silently falls back to **port 3000** and prints `Unable to find an available port`. Curling the wrong port hits the dead server and produces misleading 500s. Kill stragglers with `pkill -f '[n]uxt dev'` — note the `[n]` bracket, since a plain `pkill -f 'nuxt dev'` matches the shell running it and kills itself. Read the actual URL from the startup banner before curling.
- **`/api/link/query` returns the link object unwrapped** (no `{ link: ... }` envelope), while `/api/link/create` and `/api/link/edit` return `{ link, shortLink }`. Extract accordingly — a wrong path yields a silent `None` that looks like a missing field.
- **Never build or run dev with `CI=true`.** `nuxt.config.ts` sets `preset: !import.meta.env.CI ? 'cloudflare-module' : undefined` — `CI=true` silently produces a non-Worker node-server bundle. (`CI=true` IS fine for `pnpm install` and `pnpm types:check`.)
- Work only in the worktree `/home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations` on branch `worktree-10-scheduled-destinations`. **Never commit to `master`** and never `cd` to `/home/ubuntu/repos/Sink`.
- Code style: 2-space indent, single quotes, **no semicolons**, trailing commas. Run `pnpm lint:fix` before every commit.
- All documentation and code comments in English.
- `LinkSchema` must stay a flat `z.object` — consumers read `LinkSchema.shape`. No top-level `.refine()`.
- Conventional Commits, with `(#10)` in the subject.
- Every commit ends with these two trailers:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- Semantics, exactly: entries apply **until** their `until` instant. Sorted ascending, the first entry with `until > nowUnix` wins. All passed (or none) → `link.url`.

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/schemas/link.ts` | Add `schedule` to `LinkSchema` (validation + type source) |
| `shared/types/link.ts` | Override `schedule` in `LinkFormFields` to the form shape |
| `server/utils/link-processing.ts` | List `schedule` in `editableOptionalLinkFields` so it can be edited/cleared |
| `layers/dashboard/app/components/dashboard/links/editor/Form.vue` | Map schedule ⇄ API shape (defaults + submit) |
| `server/utils/schedule.ts` | **New.** Pure `resolveScheduledUrl` — the entire feature's logic |
| `server/middleware/1.redirect.ts` | One-line call into the resolver |
| `app/utils/time.ts` | Two helpers for `datetime-local` ⇄ unix |
| `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue` | "Scheduled destinations" accordion with repeating rows |
| `layers/dashboard/app/components/dashboard/links/Link.vue` | Clock badge on the card |
| `i18n/locales/*.json` (10 files) | New copy keys |

---

## Task 1: Schema, types, and form wiring

Makes `schedule` a real, persistable field. No behavior yet — the redirect path still ignores it. Deliverable: a link with a `schedule` survives create → query → edit → clear.

**Files:**
- Modify: `shared/schemas/link.ts:56`
- Modify: `shared/types/link.ts:18-24`
- Modify: `server/utils/link-processing.ts:4-21`
- Modify: `layers/dashboard/app/components/dashboard/links/editor/Form.vue:63` and `:66-97`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `LinkSchema.shape.schedule` — `z.array(z.object({ until: z.number().int().safe(), url: z.string().trim().url().max(2048) })).max(10).optional()`
  - `Link['schedule']` — `{ until: number, url: string }[] | undefined`
  - `LinkFormData['schedule']` — `{ until: number | undefined, url: string }[]` (**not** optional; always an array in the form)

- [ ] **Step 1: Add `schedule` to `LinkSchema`**

In `shared/schemas/link.ts`, find line 56:

```ts
  geo: GeoSchema.optional(),
```

Insert immediately **after** it:

```ts
  // Time-based destinations: each entry supplies the URL *until* its `until`
  // instant. Once every entry has passed, `url` (the final destination) is used.
  schedule: z.array(z.object({
    until: z.number().int().safe(),
    url: z.string().trim().url().max(2048),
  })).max(10).optional(),
```

- [ ] **Step 2: Override `schedule` in the form field type**

In `shared/types/link.ts`, replace lines 18-24 entirely:

```ts
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes' | 'batchId' | 'batchSeq' | 'batchMode' | 'claimedAt'> & {
  expiration: DateValue | undefined
  geo: { country: string, url: string }[]
  maxHits: number | undefined
  viewExpireSeconds: number | undefined
  notifyCooldownMinutes: number | undefined
}
```

with:

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

Note `'schedule'` was added to the `Omit` list — this is required, otherwise the intersection produces `never` for the field.

- [ ] **Step 3: Make `schedule` editable and clearable**

In `server/utils/link-processing.ts`, find line 15 (`'geo',`) inside `editableOptionalLinkFields` and insert a new line immediately after it:

```ts
  'schedule',
```

The array must end up as:

```ts
const editableOptionalLinkFields = [
  'comment',
  'title',
  'description',
  'image',
  'apple',
  'google',
  'cloaking',
  'redirectWithQuery',
  'expiration',
  'unsafe',
  'geo',
  'schedule',
  'content',
  'maxHits',
  'viewExpireSeconds',
  'notifyUrl',
  'notifyCooldownMinutes',
] as const satisfies readonly (keyof Link)[]
```

- [ ] **Step 4: Seed the form default**

In `layers/dashboard/app/components/dashboard/links/editor/Form.vue`, find line 63:

```ts
    geo: props.link.geo ? Object.entries(props.link.geo).map(([country, url]) => ({ country, url })) : [],
```

Add immediately **after** it (still inside the `defaultValues` object, before the closing `} satisfies LinkFormData,`):

```ts
    schedule: (props.link.schedule ?? []).map(s => ({ until: s.until as number | undefined, url: s.url })),
```

The `as number | undefined` widens the element type to match `LinkFormData['schedule']`; without it `satisfies LinkFormData` still passes but the field's inferred type narrows to `number` and Step 5's filter becomes a type error.

- [ ] **Step 5: Map the form rows back to the API shape on submit**

In the same file, inside `onSubmit`, find the `geo` reduction that opens the handler:

```ts
      const geoRecord: Record<string, string> = {}
      value.geo?.forEach((g) => {
        const country = g.country.trim().toUpperCase()
        const url = g.url.trim()
        if (country && url) {
          geoRecord[country] = url
        }
      })
```

Insert immediately **after** that block:

```ts
      // Drop half-filled rows (a time with no URL, or vice versa) rather than
      // failing validation on something the user is still editing.
      const scheduleEntries = (value.schedule ?? [])
        .filter((s): s is { until: number, url: string } => typeof s.until === 'number' && s.url.trim() !== '')
        .map(s => ({ until: s.until, url: s.url.trim() }))
```

Then find this line in the `linkData` object:

```ts
        geo: Object.keys(geoRecord).length > 0 ? geoRecord : undefined,
```

and add immediately **after** it:

```ts
        schedule: scheduleEntries.length > 0 ? scheduleEntries : undefined,
```

`undefined` is what makes clearing every row actually clear the stored field — `cleanupOptionalLinkFields` treats an absent value as a delete.

- [ ] **Step 6: Typecheck**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
CI=true pnpm types:check 2>&1 | tail -25
```

Expected: no errors mentioning `schedule`, `Form.vue`, `link-processing.ts`, or `shared/types/link.ts`.

**Known pre-existing failures — ignore only these**, they are unrelated to this task and exist on `master`: errors in `layers/dashboard/app/components/dashboard/links/Search.vue`. Any *other* error is yours; fix it.

- [ ] **Step 7: Round-trip the field through the real API**

Create the dev env file (gitignored; `.env` does not exist in a fresh worktree):

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
cat > .env <<'EOF'
NUXT_SITE_TOKEN=SinkCool
NUXT_REDIRECT_STATUS_CODE=302
NUXT_PUBLIC_SLUG_DEFAULT_LENGTH=5
NUXT_LINK_CACHE_TTL=60
EOF
```

Start the dev server in the background (**no `CI=true`**) and wait for it to listen:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
pnpm dev > /tmp/sink-10-dev.log 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:7465/dashboard && break; sleep 2; done
```

Create a link carrying a schedule, then read it back:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
FUTURE=$(( $(date +%s) + 86400 ))
curl -s -X POST http://localhost:7465/api/link/create \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://example.com/photos\",\"slug\":\"sched-rt\",\"schedule\":[{\"until\":$FUTURE,\"url\":\"https://example.com/rsvp\"}]}" \
  | python3 -m json.tool
curl -s -H 'Authorization: Bearer SinkCool' \
  'http://localhost:7465/api/link/query?slug=sched-rt' | python3 -m json.tool
```

Expected: the create returns 201-shaped JSON whose `link.schedule` is `[{"until": <FUTURE>, "url": "https://example.com/rsvp"}]`, and the query returns the same `schedule` array. If `schedule` is missing from the query response, Step 3 was not applied correctly.

Now prove clearing works — edit the same link with no `schedule`:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
curl -s -X PUT http://localhost:7465/api/link/edit \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/photos","slug":"sched-rt"}' | python3 -m json.tool
```

Expected: the returned `link` has **no** `schedule` key.

Also confirm the cap rejects oversized input:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
ENTRIES=$(python3 -c "import json;print(json.dumps([{'until':2000000000+i,'url':'https://example.com/%d'%i} for i in range(11)]))")
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:7465/api/link/create \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://example.com\",\"slug\":\"sched-cap\",\"schedule\":$ENTRIES}"
```

Expected: `400` (11 entries exceeds `.max(10)`).

Leave the dev server running — Task 2 reuses it. If you must stop it: `pkill -f 'nuxt dev'`.

- [ ] **Step 8: Lint and commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
pnpm lint:fix
git add shared/schemas/link.ts shared/types/link.ts server/utils/link-processing.ts layers/dashboard/app/components/dashboard/links/editor/Form.vue
git commit -m "feat: add schedule field to link schema and editor form (#10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Do **not** `git add .` — `.env` is gitignored but stray logs are not.

---

## Task 2: The resolver and the redirect

The actual feature. Deliverable: a scan lands on the scheduled URL before the cutoff and on `link.url` after.

**Files:**
- Create: `server/utils/schedule.ts`
- Modify: `server/middleware/1.redirect.ts:366`
- Test (throwaway, not committed): `/tmp/sink-10-schedule.test.ts`

**Interfaces:**
- Consumes: `Link['schedule']` from Task 1 — `{ until: number, url: string }[] | undefined`.
- Produces: `resolveScheduledUrl(link: ScheduledLink, nowUnix: number): string`, auto-imported into server code (everything in `server/utils/` is).

- [ ] **Step 1: Write the failing test**

Write `/tmp/sink-10-schedule.test.ts`:

```ts
import assert from 'node:assert/strict'
import { resolveScheduledUrl } from '/home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations/server/utils/schedule.ts'

const NOW = 1_000_000
const BASE = 'https://example.com/photos'
const A = 'https://example.com/teaser'
const B = 'https://example.com/rsvp'

// No schedule at all -> the link's own url.
assert.equal(resolveScheduledUrl({ url: BASE }, NOW), BASE)

// Empty schedule -> the link's own url.
assert.equal(resolveScheduledUrl({ url: BASE, schedule: [] }, NOW), BASE)

// Single entry, cutoff still in the future -> the scheduled url.
assert.equal(resolveScheduledUrl({ url: BASE, schedule: [{ until: NOW + 10, url: B }] }, NOW), B)

// Single entry, cutoff already passed -> falls through to the link's url.
assert.equal(resolveScheduledUrl({ url: BASE, schedule: [{ until: NOW - 10, url: B }] }, NOW), BASE)

// Two phases, now sits between them -> the *later* entry wins, because the
// earlier one has already stopped applying.
assert.equal(
  resolveScheduledUrl({ url: BASE, schedule: [{ until: NOW - 10, url: A }, { until: NOW + 10, url: B }] }, NOW),
  B,
)

// Two phases, both still ahead -> the earliest one applies.
assert.equal(
  resolveScheduledUrl({ url: BASE, schedule: [{ until: NOW + 10, url: A }, { until: NOW + 20, url: B }] }, NOW),
  A,
)

// Every cutoff passed -> the link's url.
assert.equal(
  resolveScheduledUrl({ url: BASE, schedule: [{ until: NOW - 20, url: A }, { until: NOW - 10, url: B }] }, NOW),
  BASE,
)

// Unsorted input resolves identically to sorted input.
assert.equal(
  resolveScheduledUrl({ url: BASE, schedule: [{ until: NOW + 20, url: B }, { until: NOW + 10, url: A }] }, NOW),
  A,
)

// Exactly at the cutoff, the entry has stopped applying (`until` is exclusive).
assert.equal(resolveScheduledUrl({ url: BASE, schedule: [{ until: NOW, url: B }] }, NOW), BASE)

// Resolving must not mutate the caller's array.
const original = [{ until: NOW + 20, url: B }, { until: NOW + 10, url: A }]
resolveScheduledUrl({ url: BASE, schedule: original }, NOW)
assert.equal(original[0]!.url, B, 'input array was reordered in place')

// Defensive: a link with no url must not throw.
assert.equal(resolveScheduledUrl({}, NOW), '')

console.log('all schedule tests passed')
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
npx --yes tsx /tmp/sink-10-schedule.test.ts
```

Expected: FAIL — cannot resolve `server/utils/schedule.ts` (the file does not exist yet).

- [ ] **Step 3: Write the resolver**

Create `server/utils/schedule.ts`:

```ts
// Structural, rather than importing `Link` from '#shared/schemas/link': it keeps
// this module importable by a plain tsx runner (no Nuxt alias resolution), and
// TypeScript still checks a real Link against it at the call site.
interface ScheduledLink {
  url?: string
  schedule?: { until: number, url: string }[]
}

// Which destination does this link point at right now? Each entry supplies the
// URL *until* its `until` instant, so the earliest cutoff still in the future
// wins. Once every cutoff has passed, `link.url` is the final destination.
//
// Total by construction: any missing, empty, or exhausted schedule degrades to
// `link.url`. This runs in the redirect hot path and must never throw.
export function resolveScheduledUrl(link: ScheduledLink, nowUnix: number): string {
  const schedule = link.schedule
  if (!schedule?.length)
    return link.url ?? ''

  // Copy before sorting — the caller's link object is shared with the rest of
  // the request (analytics, notifications) and must not be reordered.
  const current = [...schedule]
    .sort((a, b) => a.until - b.until)
    .find(entry => entry.until > nowUnix)

  return current?.url ?? link.url ?? ''
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
npx --yes tsx /tmp/sink-10-schedule.test.ts
```

Expected: `all schedule tests passed`, exit 0.

- [ ] **Step 5: Wire it into the redirect**

In `server/middleware/1.redirect.ts`, find line 366:

```ts
      let targetUrl = link.url!
```

Replace it with:

```ts
      let targetUrl = resolveScheduledUrl(link, now)
```

`now` (unix seconds) is already declared at line 329 and in scope here. `resolveScheduledUrl` needs no import — `server/utils/` is auto-imported. Change **nothing else**: the geo override on the next lines, `buildTarget`, the device override, and the cloaking branch all keep operating on `targetUrl` as before.

- [ ] **Step 6: Prove the redirect honors the schedule**

The dev server should already be running on **port 3000** (see Global Constraints for why it is 3000 and not 7465, and for the `wrangler.jsonc` AI-binding workaround it needs). Confirm with `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/dashboard` → `307`. If it is not running, follow the Global Constraints workarounds, then `pnpm dev` and read the port off the banner.

`PORT` below is set to 3000 to match. **Do not commit `wrangler.jsonc`** — Step 7 adds only the two source files by name.

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
PORT=3000
FUTURE=$(( $(date +%s) + 86400 ))
PAST=$(( $(date +%s) - 86400 ))

# A: cutoff in the future -> should serve the scheduled URL
curl -s -o /dev/null -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://example.com/photos\",\"slug\":\"sched-future\",\"schedule\":[{\"until\":$FUTURE,\"url\":\"https://example.com/rsvp\"}]}"

# B: only cutoff already passed -> should serve the base URL
curl -s -o /dev/null -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d "{\"url\":\"https://example.com/photos\",\"slug\":\"sched-past\",\"schedule\":[{\"until\":$PAST,\"url\":\"https://example.com/rsvp\"}]}"

# C: no schedule at all -> regression, must still serve the base URL
curl -s -o /dev/null -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/photos","slug":"sched-none"}'

for s in sched-future sched-past sched-none; do
  printf '%-14s %s\n' "$s" "$(curl -s -o /dev/null -D - "http://localhost:$PORT/$s" | grep -i '^location:')"
done
```

Expected, exactly:

```
sched-future   location: https://example.com/rsvp
sched-past     location: https://example.com/photos
sched-none     location: https://example.com/photos
```

`sched-future` is the feature. `sched-past` proves the fallback. `sched-none` proves the middleware change is inert for every existing link. If `sched-future` shows `/photos`, the resolver is not being called — re-check line 366.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
CI=true pnpm types:check 2>&1 | tail -25
pnpm lint:fix
git add server/utils/schedule.ts server/middleware/1.redirect.ts
git commit -m "feat: resolve link destination from schedule at redirect time (#10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Typecheck expected: no new errors (pre-existing `Search.vue` errors excepted, as in Task 1).

---

## Task 3: Editor UI, card badge, and copy

Deliverable: a user can add, edit, and remove schedule rows in the dashboard, and spot a scheduled link on its card.

**Files:**
- Modify: `app/utils/time.ts`
- Modify: `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue`
- Modify: `layers/dashboard/app/components/dashboard/links/Link.vue:4` and `:355`
- Modify: all 10 files in `i18n/locales/`
- Test (throwaway, not committed): `/tmp/sink-10-time.test.ts`

**Interfaces:**
- Consumes: `LinkFormData['schedule']` (`{ until: number | undefined, url: string }[]`) from Task 1; `Link['schedule']` from Task 1.
- Produces: `unix2datetimeLocal(unix: number): string` and `datetimeLocal2unix(value: string): number | undefined` in `app/utils/time.ts`, auto-imported into app and dashboard-layer code.

- [ ] **Step 1: Write the failing test for the time helpers**

Write `/tmp/sink-10-time.test.ts`:

```ts
import assert from 'node:assert/strict'
import { datetimeLocal2unix, unix2datetimeLocal } from '/home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations/app/utils/time.ts'

// Round-trip: a local wall-clock string survives the trip in both directions.
const unix = datetimeLocal2unix('2026-07-18T18:00')
assert.equal(typeof unix, 'number')
assert.equal(unix2datetimeLocal(unix!), '2026-07-18T18:00')

// The string is interpreted as *local* time, so it must match a local Date.
assert.equal(unix, Math.floor(new Date(2026, 6, 18, 18, 0, 0).getTime() / 1000))

// Zero-padding: single-digit month/day/hour/minute must still be 2 digits.
const padded = datetimeLocal2unix('2026-01-02T03:04')
assert.equal(unix2datetimeLocal(padded!), '2026-01-02T03:04')

// Empty and invalid input yield undefined rather than NaN.
assert.equal(datetimeLocal2unix(''), undefined)
assert.equal(datetimeLocal2unix('not-a-date'), undefined)

console.log('all time tests passed')
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
npx --yes tsx /tmp/sink-10-time.test.ts
```

Expected: FAIL — `datetimeLocal2unix` / `unix2datetimeLocal` are not exported from `app/utils/time.ts`.

- [ ] **Step 3: Add the two time helpers**

Append to `app/utils/time.ts`:

```ts
// `<input type="datetime-local">` speaks 'YYYY-MM-DDTHH:mm' in the viewer's own
// wall-clock time, while a schedule entry stores an absolute instant. These two
// convert between them, so a schedule always renders in the reader's timezone
// and needs no timezone field of its own.
export function unix2datetimeLocal(unix: number): string {
  const d = new Date(unix * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function datetimeLocal2unix(value: string): number | undefined {
  if (!value)
    return undefined
  // `new Date('2026-07-18T18:00')` (no zone suffix) parses as local time.
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000)
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
npx --yes tsx /tmp/sink-10-time.test.ts
```

Expected: `all time tests passed`, exit 0.

If tsx cannot resolve an existing import inside `time.ts` (it imports from `@internationalized/date`), that is fine — the package is a real dependency and resolves from the worktree's `node_modules`.

- [ ] **Step 5: Add the English copy**

In `i18n/locales/en-US.json`, find line 256:

```json
      "add_geo_route": "Add Geo Redirect",
```

Add immediately after it, inside the same `links.form` object:

```json
      "schedule": "Scheduled Destinations",
      "schedule_description": "Send visitors to a different URL until a given time. After the last entry passes, the link's main URL is used.",
      "schedule_until": "Until",
      "schedule_url": "Destination URL",
      "add_schedule_entry": "Add Scheduled Destination",
```

Then find line 327 in the same file:

```json
    "notifications_on": "Notifications on"
```

Add a `scheduled_destinations` key as a sibling (inside `links`, not `links.form`). Mind the JSON commas — if `notifications_on` is the last key in its object, it needs a trailing comma once you add another after it:

```json
    "notifications_on": "Notifications on",
    "scheduled_destinations": "Scheduled destinations"
```

- [ ] **Step 6: Add the same keys to the other 9 locales**

For each of `de-DE`, `fr-FR`, `id-ID`, `it-IT`, `pt-BR`, `pt-PT`, `vi-VN`, `zh-CN`, `zh-TW`, insert the five `links.form` keys after that file's `add_geo_route` key, and `scheduled_destinations` next to that file's `notifications_on` key. Key names are identical across locales — only values are translated.

| Locale | `schedule` | `schedule_description` | `schedule_until` | `schedule_url` | `add_schedule_entry` | `scheduled_destinations` |
| --- | --- | --- | --- | --- | --- | --- |
| de-DE | Geplante Ziele | Besucher bis zu einem bestimmten Zeitpunkt an eine andere URL senden. Nach dem letzten Eintrag wird die Haupt-URL des Links verwendet. | Bis | Ziel-URL | Geplantes Ziel hinzufügen | Geplante Ziele |
| fr-FR | Destinations planifiées | Envoyer les visiteurs vers une autre URL jusqu'à une heure donnée. Après la dernière entrée, l'URL principale du lien est utilisée. | Jusqu'à | URL de destination | Ajouter une destination planifiée | Destinations planifiées |
| id-ID | Tujuan Terjadwal | Arahkan pengunjung ke URL lain hingga waktu tertentu. Setelah entri terakhir berlalu, URL utama tautan yang digunakan. | Hingga | URL Tujuan | Tambah Tujuan Terjadwal | Tujuan terjadwal |
| it-IT | Destinazioni programmate | Invia i visitatori a un URL diverso fino a un orario stabilito. Dopo l'ultima voce viene usato l'URL principale del link. | Fino a | URL di destinazione | Aggiungi destinazione programmata | Destinazioni programmate |
| pt-BR | Destinos agendados | Envie visitantes para outra URL até um horário definido. Após a última entrada, a URL principal do link é usada. | Até | URL de destino | Adicionar destino agendado | Destinos agendados |
| pt-PT | Destinos agendados | Envie visitantes para outro URL até uma hora definida. Após a última entrada, é usado o URL principal da ligação. | Até | URL de destino | Adicionar destino agendado | Destinos agendados |
| vi-VN | Đích đến theo lịch | Đưa khách truy cập đến một URL khác cho đến thời điểm đã định. Sau mục cuối cùng, URL chính của liên kết sẽ được dùng. | Cho đến | URL đích | Thêm đích đến theo lịch | Đích đến theo lịch |
| zh-CN | 定时目标地址 | 在指定时间之前将访问者引导至其他网址。最后一条记录过期后，将使用链接的主网址。 | 截止时间 | 目标网址 | 添加定时目标 | 定时目标已设置 |
| zh-TW | 定時目標網址 | 在指定時間之前將訪客導向其他網址。最後一筆記錄過期後，將使用連結的主要網址。 | 截止時間 | 目標網址 | 新增定時目標 | 定時目標已設定 |

Validate every file parses:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
for f in i18n/locales/*.json; do python3 -m json.tool "$f" > /dev/null && echo "ok $f"; done
```

Expected: `ok` for all 10. A `json.tool` error means a missing or stray comma.

Confirm no locale was missed:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
grep -L "add_schedule_entry" i18n/locales/*.json
grep -L "scheduled_destinations" i18n/locales/*.json
```

Expected: no output from either (every file contains both keys).

- [ ] **Step 7: Add the row helpers to `Advanced.vue`**

In `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue`, find `removeGeoRoute` (around line 34-38):

```ts
function removeGeoRoute(routes: GeoRoute[], index: number | string) {
  const targetIndex = Number(index)
  return routes.filter((_, routeIndex) => routeIndex !== targetIndex)
}
```

Add immediately after it:

```ts
type ScheduleEntry = LinkFormData['schedule'][number]

function updateScheduleEntry(entries: ScheduleEntry[], index: number | string, value: Partial<ScheduleEntry>) {
  const targetIndex = Number(index)
  return entries.map((entry, entryIndex) => entryIndex === targetIndex ? { ...entry, ...value } : entry)
}

function removeScheduleEntry(entries: ScheduleEntry[], index: number | string) {
  const targetIndex = Number(index)
  return entries.filter((_, entryIndex) => entryIndex !== targetIndex)
}
```

`Plus` and `Trash2` are already imported at line 7; `unix2datetimeLocal` and `datetimeLocal2unix` are auto-imported from `app/utils/`. Add no imports.

- [ ] **Step 8: Auto-open the section when a schedule exists**

In the same file, inside the `defaultOpenItems` computed, find:

```ts
  const geoVal = props.form.getFieldValue('geo')
  if (Array.isArray(geoVal) && geoVal.length > 0) {
    items.push('geo')
  }
```

Add immediately after it:

```ts
  const scheduleVal = props.form.getFieldValue('schedule')
  if (Array.isArray(scheduleVal) && scheduleVal.length > 0) {
    items.push('schedule')
  }
```

- [ ] **Step 9: Add the accordion section**

In the same file's `<template>`, find the closing of the geo `AccordionItem` — line 358 is its `</FieldGroup>`, followed by `</AccordionContent>` and `</AccordionItem>`. Insert this **complete new block immediately after that `</AccordionItem>`**:

```vue
    <AccordionItem value="schedule">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.schedule') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="schedule">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.schedule_description') }}
              </FieldDescription>
              <div
                v-for="(item, i) in field.state.value" :key="i" class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field
                  class="
                    w-full
                    sm:w-56
                  "
                >
                  <Input
                    type="datetime-local"
                    :model-value="item.until === undefined ? '' : unix2datetimeLocal(item.until)"
                    :aria-label="$t('links.form.schedule_until')"
                    @input="field.handleChange(updateScheduleEntry(field.state.value, i, { until: datetimeLocal2unix(($event.target as HTMLInputElement).value) }))"
                  />
                </Field>
                <Field class="flex-1">
                  <Input
                    :model-value="item.url"
                    placeholder="https://..."
                    autocomplete="url"
                    :aria-label="$t('links.form.schedule_url')"
                    @input="field.handleChange(updateScheduleEntry(field.state.value, i, { url: ($event.target as HTMLInputElement).value }))"
                  />
                </Field>
                <Button type="button" variant="ghost" size="icon" @click="field.handleChange(removeScheduleEntry(field.state.value, i))">
                  <Trash2 class="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" @click="field.handleChange([...field.state.value, { until: undefined, url: '' }])">
                <Plus class="mr-2 h-4 w-4" /> {{ $t('links.form.add_schedule_entry') }}
              </Button>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>
```

`aria-label` is static English elsewhere in this repo, but these are `$t()` because the visible geo rows use translated labels and these inputs have no visible label of their own — a hardcoded English label would be the only untranslated string in a translated form. If `FieldDescription` is not already used in this file, check that it resolves (it is a shadcn-vue auto-imported component from `app/components/ui/field/`); if the build reports it as unknown, replace that element with `<p class="text-xs text-muted-foreground">{{ $t('links.form.schedule_description') }}</p>`.

- [ ] **Step 10: Add the Clock badge to the link card**

In `layers/dashboard/app/components/dashboard/links/Link.vue`, replace the lucide import on line 4:

```ts
import { Bell, CalendarPlus2, Copy, CopyCheck, Eraser, Eye, FileText, Flame, Gauge, Hourglass, Link as LinkIcon, MousePointerClick, QrCode, RotateCcw, ShieldAlert, SquareChevronDown, SquarePen, Timer, Users } from 'lucide-vue-next'
```

with (adds `Clock`, alphabetical):

```ts
import { Bell, CalendarPlus2, Clock, Copy, CopyCheck, Eraser, Eye, FileText, Flame, Gauge, Hourglass, Link as LinkIcon, MousePointerClick, QrCode, RotateCcw, ShieldAlert, SquareChevronDown, SquarePen, Timer, Users } from 'lucide-vue-next'
```

Then find the end of the `link.notifyUrl` badge block (line 355, the `</template>` that closes `<template v-if="link.notifyUrl">`) and insert immediately after it:

```vue
            <template v-if="link.schedule?.length">
              <Separator orientation="vertical" />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span
                      class="
                        inline-flex items-center leading-5 whitespace-nowrap
                      "
                    >
                      <Clock aria-hidden="true" class="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{{ $t('links.scheduled_destinations') }}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </template>
```

The card shows `link.url`, which is *not* where a scheduled link currently points — this badge is what tells the reader to look closer.

- [ ] **Step 11: Typecheck and lint**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
CI=true pnpm types:check 2>&1 | tail -25
pnpm lint:fix
```

Expected: no new errors (pre-existing `Search.vue` errors excepted). `lint:fix` will reformat the Tailwind class strings above — that is expected; keep its output.

If lint fails with "Cannot find module `.nuxt/eslint.config.mjs`", run `pnpm postinstall` first.

- [ ] **Step 12: Commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
git add app/utils/time.ts layers/dashboard/app/components/dashboard/links/editor/Advanced.vue layers/dashboard/app/components/dashboard/links/Link.vue i18n/locales
git commit -m "feat: add scheduled destinations editor and card badge (#10)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

## Task 4: Verify end to end and open the PR

Deliverable: a green branch and a PR that closes #10.

**Files:** none modified (verification only), plus `~/.cache/claude-pr/worktree-10-scheduled-destinations.md`.

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: the pull request.

- [ ] **Step 1: Browser walkthrough**

Start the dev server if it isn't running (**no `CI=true`**):

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
pnpm dev > /tmp/sink-10-dev.log 2>&1 &
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:7465/dashboard && break; sleep 2; done
```

In the browser, at `http://localhost:7465/dashboard` (log in with site token `SinkCool`):

1. Create a link, open **Advanced** → **Scheduled Destinations**.
2. Click **Add Scheduled Destination** twice; fill row 1 with a time ~1 hour out and `https://example.com/rsvp`, row 2 with a time ~2 days out and `https://example.com/live`. Set the link's main URL to `https://example.com/photos`. Save.
3. Reopen the link's editor. **Expect:** the section is already expanded and both rows show the times you entered, in your local timezone, in the order saved.
4. **Expect:** a clock icon on the link's card; hover shows "Scheduled destinations".
5. Delete row 1 with the trash button, save, reopen. **Expect:** only row 2 remains.
6. Delete the last row, save, reopen. **Expect:** the section is empty and the clock badge is gone from the card.

Screenshot the expanded editor section and the card badge.

- [ ] **Step 2: Confirm the live redirect follows the schedule**

Using the link from Step 1 (main URL `https://example.com/photos`, first cutoff ~1 hour out):

```bash
curl -s -o /dev/null -D - "http://localhost:7465/<the-slug-you-created>" | grep -i '^location:'
```

Expected: `location: https://example.com/rsvp` — the first phase, not the main URL. This is the whole feature working through the real UI-saved data, not synthetic API JSON.

- [ ] **Step 3: Build**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
pkill -f 'nuxt dev'
pnpm build 2>&1 | tail -30
```

**Never pipe the build through anything that swallows its exit code** — a piped `| tail` has previously masked a failure and shipped a stale bundle. Check the status explicitly:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
pnpm build > /tmp/sink-10-build.log 2>&1; echo "build exit: $?"
tail -20 /tmp/sink-10-build.log
```

Expected: `build exit: 0`.

Then confirm the output really is a Worker bundle, not a node-server one:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
grep -c "cloudflare" .output/server/index.mjs > /dev/null && ls .output/server/index.mjs && echo "worker bundle present"
```

Expected: `.output/server/index.mjs` exists. If the build instead produced a node-server preset, `CI` leaked into the environment — unset it and rebuild.

- [ ] **Step 4: Final lint and typecheck**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
pnpm lint
CI=true pnpm types:check 2>&1 | tail -25
```

Expected: lint clean; typecheck shows only the pre-existing `Search.vue` errors.

- [ ] **Step 5: Confirm the branch is clean and complete**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
git status --short
git log --oneline master..HEAD
```

Expected: `git status` shows no modified tracked files (`.env` and `.output/` are gitignored). The log shows the spec commit, the plan commit, and the three feature commits from Tasks 1-3 — **and nothing on `master`**. If any feature commit landed on `master`, stop and report it.

- [ ] **Step 6: Push and open the PR**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/10-scheduled-destinations
git push -u origin worktree-10-scheduled-destinations
```

Write the PR text to a stable path outside the repo (line 1 = title, line 2 = blank, line 3+ = body):

```bash
mkdir -p ~/.cache/claude-pr
cat > ~/.cache/claude-pr/worktree-10-scheduled-destinations.md <<'EOF'
feat: scheduled destinations (#10)

Let a single link change where it points over time, so a printed QR code can follow an event's lifecycle without being reprinted.

## How it works

`schedule` is a list of `{ until, url }` entries. Each supplies the URL *until* its instant; sorted ascending, the first entry still in the future wins. Once every entry has passed, `link.url` is used — so the link's main URL is its final destination.

```
schedule: [ { until: <Sat 18:00>, url: ".../rsvp" } ]
url:      ".../photos"

before Sat 18:00 -> /rsvp
after            -> /photos
```

## Changes

- `server/utils/schedule.ts` — pure, total `resolveScheduledUrl(link, nowUnix)`; any missing, empty, or exhausted schedule degrades to `link.url`, so it cannot throw in the redirect path.
- `server/middleware/1.redirect.ts` — one line: `let targetUrl = resolveScheduledUrl(link, now)`. Precedence is now **device > geo > schedule > `link.url`**; nothing else in the redirect path changed.
- `shared/schemas/link.ts` — `schedule` array, capped at 10 entries.
- Dashboard — a "Scheduled Destinations" accordion with repeating rows (native `datetime-local` + URL), and a clock badge on the card, because the card shows `link.url`, which is not necessarily where a scheduled link currently points.
- Copy added to all 10 locales.

## Testing

- Unit-tested the resolver: no/empty schedule, single future entry, now between two cutoffs, all cutoffs passed, unsorted input, exact-cutoff boundary, and non-mutation of the caller's array.
- Unit-tested the `datetime-local` ⇄ unix helpers, including zero-padding and invalid input.
- e2e against a dev server with real KV, asserting the `Location` header: future cutoff → scheduled URL; past-only → main URL; **no schedule → main URL** (proving the middleware change is inert for existing links).
- Browser walkthrough: rows round-trip through save/reopen, delete leaves the rest intact, clearing all rows clears the field and the badge.
- Schema cap verified (11 entries → 400).

Closes #10

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
EOF
```

```bash
F=~/.cache/claude-pr/worktree-10-scheduled-destinations.md
gh pr create --base master --head worktree-10-scheduled-destinations \
  --title "$(head -n 1 "$F")" --body "$(tail -n +3 "$F")"
```

Expected: `gh` prints the PR URL. Report it.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Semantics (phases, sort, `until` exclusive, fallback) | Task 2 Steps 1-4 |
| Precedence device > geo > schedule > url | Task 2 Step 5 |
| `server/utils/schedule.ts` pure resolver | Task 2 Step 3 |
| Middleware one-line integration | Task 2 Step 5 |
| Schema (`.max(10)`, `int().safe()`, flat object) | Task 1 Step 1 |
| `editableOptionalLinkFields` | Task 1 Step 3 |
| Past entries retained, not pruned | Task 2 Step 3 (resolver never writes) + Task 1 Step 7 (round-trip preserves) |
| Editor accordion, rows, add/remove, auto-open | Task 3 Steps 7-9 |
| `datetime-local` trade-off | Task 3 Step 9 |
| Time helpers | Task 3 Steps 1-4 |
| Form wiring (`LinkFormData`, defaults, submit filter, clear) | Task 1 Steps 2, 4, 5 |
| Clock badge on card | Task 3 Step 10 |
| i18n, 10 locales | Task 3 Steps 5-6 |
| Error handling (total resolver, rows dropped, schema rejects) | Task 2 Step 1 (`{}` case), Task 1 Step 5, Task 1 Step 7 (cap → 400) |
| Testing 1 (unit) | Task 2 Steps 1-4 |
| Testing 2 (e2e Location) | Task 2 Step 6 |
| Testing 3 (regression, no schedule) | Task 2 Step 6 (`sched-none`) |
| Testing 4 (browser walkthrough) | Task 4 Steps 1-2 |
| Testing 5 (types/lint/build) | Task 4 Steps 3-4 |
| One PR, `Closes #10` | Task 4 Step 6 |

No gaps.

**Placeholder scan:** No TBD/TODO. Every code step carries complete code; every locale value is spelled out; every command has an expected result.

**Type consistency:** `resolveScheduledUrl(link, nowUnix): string` is named identically in Task 2 Steps 1, 3, 5 and the PR body. `ScheduledLink.schedule` (`{ until: number, url: string }[]`) accepts `Link['schedule']` from Task 1 Step 1 structurally. `LinkFormData['schedule']` (`{ until: number | undefined, url: string }[]`) is defined in Task 1 Step 2, produced in Task 1 Step 4, consumed by Task 1 Step 5's filter and Task 3's `ScheduleEntry` alias. `unix2datetimeLocal` / `datetimeLocal2unix` are named identically in Task 3 Steps 1, 3, 9. Consistent.

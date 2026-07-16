# A/B Split Links (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One short link, N weighted destinations; the middleware picks per request and logs which variant it served, so "which flyer converts" becomes measurable.

**Architecture:** A new optional `variants: [{ url, weight }]` field on `LinkSchema`, mutually exclusive with `schedule`/`geo`/device routing (rejected at the API boundary, because any precedence would let a chosen-and-logged variant be silently overridden — corrupting the measurement). A pure `selectVariant(variants, rand)` picks by cumulative weight; the middleware calls it where `schedule` resolves today and records the served variant's index to Analytics Engine `blob17`.

**Tech Stack:** Nuxt 4, Nitro on Cloudflare Workers, Zod, TanStack Form, shadcn-vue, Tailwind v4, `@nuxtjs/i18n`, Vitest (`@cloudflare/vitest-pool-workers`), Analytics Engine.

**Spec:** `docs/superpowers/specs/2026-07-16-ab-split-links-design.md`. This plan is **Phase 1 only** — the stats endpoint and dashboard charting are Phase 2 (issue #20), deferred.

## Global Constraints

- **This is a fork with hard-won environment quirks. All are verified.**
  - **The vitest pool tests the BUILT bundle, not live source.** `wrangler.jsonc` sets `"main": ".output/server/index.mjs"` and `vitest.config.ts` points the pool at that config. **After editing anything under `server/`, run `pnpm build` before the tests reflect it** — otherwise you run stale code and chase phantom results. Tests-only edits (`tests/**`) need no rebuild. **Never build with `CI=true`** (`nuxt.config.ts` uses `!import.meta.env.CI` to pick the Workers preset; `CI=true` silently produces a broken node-server bundle). `CI=true` IS fine for `pnpm types:check`.
  - **The vitest pool only starts with the `ai` binding removed** from `wrangler.jsonc`, plus a `.env`. Workers AI has no local emulation, so wrangler otherwise opens a remote proxy session our scoped token can't authenticate, and then **every binding including KV is `undefined`** and tests fail confusingly. To run tests:
    ```bash
    cp wrangler.jsonc /tmp/wrangler-backup.jsonc
    python3 - <<'PY'
    p='wrangler.jsonc'; s=open(p).read()
    old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
    assert old in s, "AI block not found"
    open(p,'w').write(s.replace(old,''))
    PY
    printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
    pnpm build > /tmp/ab-build.log 2>&1; echo "build exit: $?"
    pnpm vitest run tests/redirect.spec.ts tests/unit/variants.spec.ts
    git checkout wrangler.jsonc && rm -f .env   # ALWAYS restore
    ```
  - **`wrangler.jsonc` and `.env` must NEVER be committed.** Restore before every commit; `git status` must show neither. Do NOT `git add .`.
  - **Expected suite baseline:** `tests/api/stats.spec.ts` and `tests/api/logs.spec.ts` fail (22 tests) without Analytics Engine credentials — pre-existing on `master`, NOT your problem. Every other file must pass.
  - **Redirect tests assert 302, not 301** — `wrangler.jsonc` pins `NUXT_REDIRECT_STATUS_CODE: "302"` and the pool reads that config.
  - **`/api/link/query` returns the link UNWRAPPED** (no `{link:...}`); `create`/`edit` return `{ link, shortLink }`.
  - If the dev server is needed and port 7465 is taken, nuxt silently uses **port 3000** and prints `Unable to find an available port` — read the port off the banner. Kill stragglers with `pkill -f '[n]uxt dev'` (the `[n]` bracket stops the pattern from matching its own shell).
- Work only in the worktree `/home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links` on branch `worktree-11-ab-split-links`. **Never commit to `master`**; never `cd` to `/home/ubuntu/repos/Sink`.
- Code style: 2-space indent, single quotes, **no semicolons**, trailing commas. `pnpm lint:fix` before every commit.
- All code comments and docs in English; comments explain constraints, not narration.
- `LinkSchema` must stay a flat `z.object` — consumers read `LinkSchema.shape`. **No top-level `.refine()`.** The exclusion rule goes in a separate `refineLinkVariants` composed via `.superRefine()`, exactly like the existing `refineLinkContent`.
- `pnpm types:check` has pre-existing errors in `layers/dashboard/app/components/dashboard/links/Search.vue` — ignore only those.
- Conventional Commits with `(#11)` in the subject. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- **Binding decisions (from the spec, all binding):** 2–10 variants; `weight` a positive integer ≤ 1000; selection is per-request weighted-random (not sticky); variants **replace** `link.url` when set (`url` stays required as fallback); the served variant's **index** is logged (not its URL) to a new **`blob17`**, additively; `variants` may **not** be combined with `schedule`, `geo`, `apple`, or `google` (400 at write time).

## File Structure

| File | Responsibility |
| --- | --- |
| `shared/schemas/link.ts` | `variants` field + `refineLinkVariants` exclusion rule |
| `shared/types/link.ts` | Form-shape override for `variants` |
| `server/utils/link-processing.ts` | `variants` in `editableOptionalLinkFields` |
| `server/api/link/create.post.ts`, `upsert.post.ts`, `edit.put.ts` | Compose `refineLinkVariants` onto the validation schema |
| `layers/dashboard/app/components/dashboard/links/editor/Form.vue` | Map `variants` ⇄ API shape |
| `server/utils/variants.ts` | **New.** Pure `selectVariant` |
| `server/middleware/1.redirect.ts` | Select a variant; set `event.context.linkVariant` |
| `server/utils/access-log.ts` | `blob17: 'variant'`; populate from context |
| `tests/unit/variants.spec.ts` | **New.** Unit tests for `selectVariant` |
| `tests/redirect.spec.ts` | Integration + rejection + regression tests |
| `.../editor/Advanced.vue` | "Split Test (A/B)" accordion |
| `.../links/Link.vue` | `Split` badge |
| `i18n/locales/*.json` (10) | Copy |

---

## Task 1: Schema, exclusion rule, and form wiring

Deliverable: `variants` persists through create → query → edit → clear, and a conflicting or malformed configuration is rejected with 400.

**Files:**
- Modify: `shared/schemas/link.ts` (after line 62; and a new `refineLinkVariants` near `refineLinkContent` at :80)
- Modify: `shared/types/link.ts` (the `LinkFormFields` Omit list + intersection)
- Modify: `server/utils/link-processing.ts:16`
- Modify: `server/api/link/create.post.ts:1-3`, `server/api/link/upsert.post.ts:1-3`, `server/api/link/edit.put.ts:2-6`
- Modify: `layers/dashboard/app/components/dashboard/links/editor/Form.vue` (defaults near :64, submit near :104)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `LinkSchema.shape.variants` — `z.array(z.object({ url, weight }))min(2).max(10).optional()`
  - `Link['variants']` — `{ url: string, weight: number }[] | undefined`
  - `refineLinkVariants(data, ctx)` — a `superRefine` fn rejecting `variants` combined with `schedule`/`geo`/`apple`/`google`
  - `LinkFormData['variants']` — `{ url: string, weight: number | undefined }[]` (always an array; `weight` nullable while typing)

- [ ] **Step 1: Add the `variants` field to `LinkSchema`**

In `shared/schemas/link.ts`, find the `schedule` field ending at line 62:

```ts
  schedule: z.array(z.object({
    until: z.number().int().safe(),
    url: z.string().trim().url().max(2048),
  })).max(10).optional(),
```

Insert immediately **after** it (before `maxHits`):

```ts
  // A/B split test: 2-10 weighted destinations. Selected per request and, when
  // set, replaces `url` (which stays required as the fallback). Mutually
  // exclusive with schedule/geo/device routing — see refineLinkVariants.
  variants: z.array(z.object({
    url: z.string().trim().url().max(2048),
    weight: z.number().int().positive().max(1000),
  })).min(2).max(10).optional(),
```

- [ ] **Step 2: Add the exclusion rule**

In the same file, find `export function refineLinkContent(` (line 80) and read it to match its style. Immediately **before** it, add:

```ts
// A split link's variant is chosen and logged at redirect time. If a geo,
// device, or schedule override could then replace the destination, the served
// URL and the logged variant would disagree and every measurement would be
// wrong. Rather than invent a precedence, refuse the combination at write time.
export function refineLinkVariants(
  data: { variants?: unknown[], schedule?: unknown[], geo?: Record<string, unknown>, apple?: string, google?: string },
  ctx: z.RefinementCtx,
): void {
  if (!data.variants?.length)
    return
  const conflicts: string[] = []
  if (data.schedule?.length)
    conflicts.push('scheduled destinations')
  if (data.geo && Object.keys(data.geo).length > 0)
    conflicts.push('geo routing')
  if (data.apple || data.google)
    conflicts.push('device redirects')
  if (conflicts.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `A split link cannot also use ${conflicts.join(', ')}`,
      path: ['variants'],
    })
  }
}
```

- [ ] **Step 3: Compose the exclusion rule onto the three write endpoints**

In `server/api/link/create.post.ts`, change line 1-3 from:

```ts
import { LinkSchema, refineLinkContent } from '#shared/schemas/link'

const CreateLinkSchema = LinkSchema.superRefine(refineLinkContent)
```

to:

```ts
import { LinkSchema, refineLinkContent, refineLinkVariants } from '#shared/schemas/link'

const CreateLinkSchema = LinkSchema.superRefine(refineLinkContent).superRefine(refineLinkVariants)
```

In `server/api/link/upsert.post.ts`, apply the identical change (its lines 1 and 3 are the same shape, with `UpsertLinkSchema`).

In `server/api/link/edit.put.ts`, change lines 2-6 from:

```ts
import { EditLinkPasswordSchema, LinkSchema, refineLinkContent } from '#shared/schemas/link'

const EditLinkSchema = LinkSchema.extend({
  password: EditLinkPasswordSchema,
}).superRefine(refineLinkContent)
```

to:

```ts
import { EditLinkPasswordSchema, LinkSchema, refineLinkContent, refineLinkVariants } from '#shared/schemas/link'

const EditLinkSchema = LinkSchema.extend({
  password: EditLinkPasswordSchema,
}).superRefine(refineLinkContent).superRefine(refineLinkVariants)
```

(`.superRefine()` returns a `ZodEffects` that accepts a further `.superRefine()` — verified.)

**Why validating the request body is sufficient for `edit` (not a hole):** `edit.put.ts` validates the body, then `mergeEditableLink` merges it over the existing link and `cleanupOptionalLinkFields` **deletes any `editableOptionalLinkFields` entry absent from the body**. Since `variants`, `geo`, `schedule`, `apple`, and `google` are all editable-optional, a field persists after an edit *iff it was present in the body*. So the body-level `refineLinkVariants` sees exactly the set of conflict-relevant fields that will be stored — there is no partial-edit path that leaves `variants` and `geo` both set while hiding one from the refine. Do not add a post-merge re-validation; it would be redundant.

- [ ] **Step 4: Make `variants` editable and clearable**

In `server/utils/link-processing.ts`, find line 16 (`'schedule',`) in `editableOptionalLinkFields` and insert immediately after it:

```ts
  'variants',
```

- [ ] **Step 5: Override `variants` in the form field type**

In `shared/types/link.ts`, read the `LinkFormFields` type. It is `Omit<Link, ...> & { ... }`. Add `'variants'` to the `Omit<...>` union (alongside `'geo'`, `'schedule'`), and add this member to the intersection (next to the `schedule` member):

```ts
  // Always an array in the form; a row being typed may have a URL but no weight
  // yet, so weight is nullable here even though the schema requires it.
  variants: { url: string, weight: number | undefined }[]
```

`'variants'` must appear in **both** the `Omit` list and the intersection; omitting it from `Omit` makes the field `never`.

- [ ] **Step 6: Seed the form default**

In `layers/dashboard/app/components/dashboard/links/editor/Form.vue`, find line 64:

```ts
    schedule: (props.link.schedule ?? []).map(s => ({ until: s.until as number | undefined, url: s.url })),
```

Add immediately **after** it (inside `defaultValues`):

```ts
    variants: (props.link.variants ?? []).map(v => ({ url: v.url, weight: v.weight as number | undefined })),
```

- [ ] **Step 7: Map the form rows back to the API shape on submit**

In the same file's `onSubmit`, find the `scheduleEntries` block near line 78:

```ts
      const scheduleEntries = (value.schedule ?? [])
```

Read that whole block to match its style, then immediately after it add:

```ts
      // Keep only complete rows (a URL and a positive weight); a half-typed row
      // must not fail validation on save.
      const variantEntries = (value.variants ?? [])
        .filter((v): v is { url: string, weight: number } => v.url.trim() !== '' && typeof v.weight === 'number' && v.weight > 0)
        .map(v => ({ url: v.url.trim(), weight: v.weight }))
```

Then find this line in the `linkData` object (near line 104):

```ts
        schedule: scheduleEntries.length > 0 ? scheduleEntries : undefined,
```

and add immediately **after** it:

```ts
        variants: variantEntries.length >= 2 ? variantEntries : undefined,
```

The `>= 2` mirrors the schema's `.min(2)`: a single filled row is not a split and is dropped, so clearing works via `cleanupOptionalLinkFields`.

- [ ] **Step 8: Typecheck**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
```

Expected: **no output**.

- [ ] **Step 9: Round-trip and rejection tests via the real API**

Set up the env and build (the pool tests the built bundle):

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
cp wrangler.jsonc /tmp/wrangler-backup.jsonc
python3 - <<'PY'
p='wrangler.jsonc'; s=open(p).read()
old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
assert old in s, "AI block not found"
open(p,'w').write(s.replace(old,''))
PY
printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
pnpm dev > /tmp/ab-dev.log 2>&1 &
sleep 45
grep -E "Local:|Unable to find an available port" /tmp/ab-dev.log
```

Read the port off the banner, set `PORT`, then:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
PORT=<port from banner>
# Valid split link round-trips
curl -s -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/base","slug":"ab-rt","variants":[{"url":"https://example.com/a","weight":3},{"url":"https://example.com/b","weight":1}]}' \
  | python3 -m json.tool
curl -s -H 'Authorization: Bearer SinkCool' "http://localhost:$PORT/api/link/query?slug=ab-rt" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('variants:',json.dumps(d.get('variants')))"
```

Expected: create returns 201 with the two variants; query (unwrapped) returns the same array.

Rejection cases — each must be **400**:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
# 1 variant (below min)
curl -s -o /dev/null -w '1-variant: %{http_code}\n' -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"ab-min","variants":[{"url":"https://example.com/a","weight":1}]}'
# zero weight
curl -s -o /dev/null -w 'zero-weight: %{http_code}\n' -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"ab-w0","variants":[{"url":"https://example.com/a","weight":0},{"url":"https://example.com/b","weight":1}]}'
# variants + schedule
curl -s -o /dev/null -w 'with-schedule: %{http_code}\n' -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"ab-sch","variants":[{"url":"https://example.com/a","weight":1},{"url":"https://example.com/b","weight":1}],"schedule":[{"until":4000000000,"url":"https://example.com/x"}]}'
# variants + geo
curl -s -o /dev/null -w 'with-geo: %{http_code}\n' -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"ab-geo","variants":[{"url":"https://example.com/a","weight":1},{"url":"https://example.com/b","weight":1}],"geo":{"DE":"https://example.com/de"}}'
# variants + device (apple)
curl -s -o /dev/null -w 'with-apple: %{http_code}\n' -X POST "http://localhost:$PORT/api/link/create" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","slug":"ab-ios","variants":[{"url":"https://example.com/a","weight":1},{"url":"https://example.com/b","weight":1}],"apple":"https://apps.apple.com/x"}'
```

Expected: `400` for all five.

Clearing:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
curl -s -X PUT "http://localhost:$PORT/api/link/edit" \
  -H 'Authorization: Bearer SinkCool' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/base","slug":"ab-rt"}' | python3 -m json.tool
curl -s -H 'Authorization: Bearer SinkCool' "http://localhost:$PORT/api/link/query?slug=ab-rt" \
  | python3 -c "import sys,json;print('variants present:', 'variants' in json.load(sys.stdin))"
```

Expected: edit returns the link without `variants`; query shows `variants present: False`.

- [ ] **Step 10: Restore config, lint, commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
pkill -f '[n]uxt dev'
git checkout wrangler.jsonc && rm -f .env
git status --short   # must NOT list wrangler.jsonc or .env
pnpm lint:fix
git add shared/schemas/link.ts shared/types/link.ts server/utils/link-processing.ts server/api/link/create.post.ts server/api/link/upsert.post.ts server/api/link/edit.put.ts layers/dashboard/app/components/dashboard/links/editor/Form.vue
git commit -m "feat: add A/B variants field with exclusion rule and form wiring (#11)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

## Task 2: Selection, redirect, and variant logging

The feature. Deliverable: a split link serves its variants by weight and records the served index to `blob17`; non-variant links are unaffected.

**Files:**
- Create: `server/utils/variants.ts`
- Create: `tests/unit/variants.spec.ts`
- Modify: `server/middleware/1.redirect.ts:366`
- Modify: `server/utils/access-log.ts` (`blobsMap` at :37; `accessLogs` object at :129)
- Modify: `tests/redirect.spec.ts`

**Interfaces:**
- Consumes: `Link['variants']` (`{ url: string, weight: number }[] | undefined`) from Task 1.
- Produces: `selectVariant(variants: { url: string, weight: number }[], rand: number): { url: string, index: number } | null`, auto-imported into server code; `event.context.linkVariant: string | undefined`; `blob17` mapped to `'variant'`.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/variants.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { selectVariant } from '../../server/utils/variants'

const AB = [{ url: 'https://a', weight: 3 }, { url: 'https://b', weight: 1 }]

describe('selectVariant', () => {
  it('returns null for an empty list', () => {
    expect(selectVariant([], 0.5)).toBe(null)
  })

  it('returns the sole element for a one-item list', () => {
    expect(selectVariant([{ url: 'https://only', weight: 1 }], 0.99)).toEqual({ url: 'https://only', index: 0 })
  })

  it('selects the first variant at rand = 0', () => {
    expect(selectVariant(AB, 0)).toEqual({ url: 'https://a', index: 0 })
  })

  it('selects the first variant just below its cumulative boundary', () => {
    // weights [3,1], total 4; index 0 covers [0, 0.75)
    expect(selectVariant(AB, 0.7499)).toEqual({ url: 'https://a', index: 0 })
  })

  it('selects the second variant at its boundary', () => {
    // index 1 covers [0.75, 1)
    expect(selectVariant(AB, 0.75)).toEqual({ url: 'https://b', index: 1 })
  })

  it('selects the last variant just below rand = 1', () => {
    expect(selectVariant(AB, 0.9999)).toEqual({ url: 'https://b', index: 1 })
  })

  it('splits evenly for equal weights', () => {
    const even = [{ url: 'https://x', weight: 1 }, { url: 'https://y', weight: 1 }]
    expect(selectVariant(even, 0.49)).toEqual({ url: 'https://x', index: 0 })
    expect(selectVariant(even, 0.5)).toEqual({ url: 'https://y', index: 1 })
  })

  it('honors the weighted distribution over a deterministic sweep', () => {
    // 1000 evenly spaced rand values; index 0 (weight 3/4) should win ~750.
    let zero = 0
    for (let i = 0; i < 1000; i++) {
      if (selectVariant(AB, i / 1000)!.index === 0)
        zero++
    }
    expect(zero).toBe(750)
  })

  it('never returns an out-of-range index for rand at the very top', () => {
    // Guard against floating-point overrun landing past the last bucket.
    const result = selectVariant(AB, 0.999999999999)
    expect(result).not.toBe(null)
    expect(result!.index).toBeLessThan(AB.length)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Set up the env (see Global Constraints), then:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
# (ai binding removed + .env created per Global Constraints)
pnpm vitest run tests/unit/variants.spec.ts 2>&1 | tail -12
```

Expected: FAIL — cannot resolve `server/utils/variants`.

- [ ] **Step 3: Write the resolver**

Create `server/utils/variants.ts`:

```ts
// Structural rather than importing `Link`, mirroring server/utils/schedule.ts
// and fencing.ts: keeps this trivially unit-testable, and TypeScript still
// checks a real Link against it at the call site.
interface Variant {
  url: string
  weight: number
}

// Weighted pick over cumulative weights. `rand` is a caller-supplied [0, 1)
// value (injected, not Math.random() here) so the distribution is
// deterministically testable. Returns null for an empty/unusable list, letting
// the caller fall back to link.url. Runs in the redirect hot path; never throws.
export function selectVariant(variants: Variant[], rand: number): { url: string, index: number } | null {
  if (!variants.length)
    return null
  const total = variants.reduce((sum, v) => sum + v.weight, 0)
  if (total <= 0)
    return null
  const threshold = rand * total
  let cumulative = 0
  for (let i = 0; i < variants.length; i++) {
    cumulative += variants[i]!.weight
    if (threshold < cumulative)
      return { url: variants[i]!.url, index: i }
  }
  // Floating-point overrun (rand extremely close to 1): fall back to the last.
  const last = variants.length - 1
  return { url: variants[last]!.url, index: last }
}
```

- [ ] **Step 4: Run the unit test and watch it pass**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
pnpm vitest run tests/unit/variants.spec.ts 2>&1 | tail -8
```

Expected: all pass (`tests/unit/variants.spec.ts` needs no rebuild — it imports the source directly, not the bundle).

- [ ] **Step 5: Wire selection into the middleware**

In `server/middleware/1.redirect.ts`, find line 366-368:

```ts
      let targetUrl = resolveScheduledUrl(link, now)
      const country = event.context.cloudflare?.request?.cf?.country
      if (country && typeof country === 'string' && link.geo?.[country.toUpperCase()]) {
```

Insert the variant selection **between** the `resolveScheduledUrl` line and the `country` line, so it becomes:

```ts
      let targetUrl = resolveScheduledUrl(link, now)
      // Split links are mutually exclusive with schedule/geo/device (enforced at
      // write time), so the chosen variant is always the served destination and
      // the logged index below can never disagree with it.
      if (link.variants?.length) {
        const variant = selectVariant(link.variants, Math.random())
        if (variant) {
          targetUrl = variant.url
          event.context.linkVariant = String(variant.index)
        }
      }
      const country = event.context.cloudflare?.request?.cf?.country
      if (country && typeof country === 'string' && link.geo?.[country.toUpperCase()]) {
```

`selectVariant` needs no import (auto-imported from `server/utils/`). `Math.random()` is called here at the edge, keeping the resolver pure. Change nothing else.

- [ ] **Step 6: Declare `linkVariant` on the request context**

`event.context.linkVariant` is a new context key. Check whether the codebase augments `H3EventContext` (search for `interface H3EventContext` or `declare module`). In `server/middleware/1.redirect.ts` the context is accessed loosely, so a `declare` may not be required for the middleware to compile — but Task 2 Step 7 reads it in `access-log.ts`. If `CI=true pnpm types:check` (Step 9) reports an error about `linkVariant` not existing on the context type, add this augmentation to the top of `server/utils/access-log.ts` (after the imports):

```ts
declare module 'h3' {
  interface H3EventContext {
    linkVariant?: string
  }
}
```

If types pass without it, do not add it (YAGNI).

- [ ] **Step 7: Log the served variant to `blob17`**

In `server/utils/access-log.ts`, find `blobsMap` ending at line 37:

```ts
  blob16: 'COLO',
} as const
```

Change it to:

```ts
  blob16: 'COLO',
  blob17: 'variant',
} as const
```

Then find the `accessLogs` object (starts line 129) and its `COLO: cf?.colo,` line. Add immediately after `COLO: cf?.colo,`:

```ts
    variant: event.context.linkVariant,
```

`logs2blobs` renders a missing value as `''` (`String(logs[...] || '')`), so every non-variant link logs an empty `blob17` — additive and back-compatible. Note `accessLogs` already reads from `event.context` (via `link`), so `event.context.linkVariant` is in scope here; it is set at middleware line ~366, which runs before the access-log call at line ~420.

- [ ] **Step 8: Add integration + regression tests**

In `tests/redirect.spec.ts`, add to the existing `describe('/')` block (it defines `createdSlugs` and an `afterAll` cleanup; reuse them, as the geo test does):

```ts
  it('serves only the variant URLs for a split link, never the base', async () => {
    const slug = `ab-serve-${crypto.randomUUID()}`
    const a = 'https://example.com/variant-a'
    const b = 'https://example.com/variant-b'
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/base',
      slug,
      variants: [{ url: a, weight: 1 }, { url: b, weight: 1 }],
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const response = await fetch(`/${slug}`, { redirect: 'manual' })
      expect(response.status).toBe(302)
      const location = response.headers.get('Location')
      // The base URL must never be served while variants are set.
      expect(location === a || location === b).toBe(true)
      if (location)
        seen.add(location)
    }
    // Over 40 even-weighted draws, both variants should appear (flake
    // probability 2 * 0.5^40, astronomically small).
    expect(seen.has(a) && seen.has(b)).toBe(true)
  })

  it('redirects a non-variant link exactly as before', async () => {
    const slug = `ab-none-${crypto.randomUUID()}`
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/plain',
      slug,
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/plain')
  })

  it('rejects variants combined with geo routing', async () => {
    const response = await postJson('/api/link/create', {
      url: 'https://example.com',
      slug: `ab-reject-geo-${crypto.randomUUID()}`,
      variants: [{ url: 'https://example.com/a', weight: 1 }, { url: 'https://example.com/b', weight: 1 }],
      geo: { DE: 'https://example.com/de' },
    })
    expect(response.status).toBe(400)
  })
```

- [ ] **Step 9: Rebuild, run, typecheck**

The middleware and access-log changes are under `server/`, so **rebuild before testing**:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
pnpm build > /tmp/ab-build2.log 2>&1; echo "build exit: $?"
pnpm vitest run tests/redirect.spec.ts tests/unit/variants.spec.ts 2>&1 | tail -10
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
```

Expected: `build exit: 0`; all listed tests pass; no typecheck output.

- [ ] **Step 10: Restore config and commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
git checkout wrangler.jsonc && rm -f .env
git status --short   # must NOT list wrangler.jsonc or .env
pnpm lint:fix
git add server/utils/variants.ts tests/unit/variants.spec.ts server/middleware/1.redirect.ts server/utils/access-log.ts tests/redirect.spec.ts
git commit -m "feat: select and log A/B variant at redirect time (#11)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

## Task 3: Editor UI, card badge, and copy

Deliverable: variants are editable in the dashboard and a split link is visible on its card.

**Files:**
- Modify: `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue`
- Modify: `layers/dashboard/app/components/dashboard/links/Link.vue` (lucide import line 4; badge after the schedule badge)
- Modify: all 10 files in `i18n/locales/`

**Interfaces:**
- Consumes: `LinkFormData['variants']` (`{ url: string, weight: number | undefined }[]`) from Task 1.
- Produces: no new exports.

- [ ] **Step 1: Add the English copy**

In `i18n/locales/en-US.json`, find `"add_schedule_entry"` inside `links.form` and add immediately after it:

```json
      "split_test": "Split Test (A/B)",
      "split_test_description": "Send visitors to one of several URLs by weight, chosen per visit. Can't be combined with scheduling, geo routing, or device redirects. Per-variant numbers are available via the analytics API; in-dashboard charts are coming.",
      "split_test_url": "Variant URL",
      "split_test_weight": "Weight",
      "add_variant": "Add Variant",
```

Then find `"scheduled_destinations"` inside `links` (sibling of `notifications_on`) and add after it:

```json
    "split_test_on": "A/B split test"
```

Mind the JSON commas.

- [ ] **Step 2: Add the same keys to the other 9 locales**

Key names identical everywhere; only values translated. Insert in the same structural positions as `en-US.json`.

| Locale | `split_test` | `split_test_description` | `split_test_url` | `split_test_weight` | `add_variant` | `split_test_on` |
| --- | --- | --- | --- | --- | --- | --- |
| de-DE | Split-Test (A/B) | Besucher gewichtet auf eine von mehreren URLs leiten, pro Aufruf gewählt. Nicht mit Zeitplan, Geo-Routing oder Geräteweiterleitung kombinierbar. Werte je Variante sind über die Analytics-API verfügbar; Diagramme im Dashboard folgen. | Varianten-URL | Gewicht | Variante hinzufügen | A/B-Split-Test |
| fr-FR | Test A/B | Diriger les visiteurs vers l'une de plusieurs URL selon un poids, choisie à chaque visite. Incompatible avec la planification, le routage géo ou les redirections par appareil. Les chiffres par variante sont disponibles via l'API analytics ; les graphiques arrivent. | URL de la variante | Poids | Ajouter une variante | Test A/B |
| id-ID | Uji Split (A/B) | Arahkan pengunjung ke salah satu dari beberapa URL berdasarkan bobot, dipilih tiap kunjungan. Tidak bisa digabung dengan penjadwalan, geo-routing, atau pengalihan perangkat. Angka per varian tersedia via API analitik; grafik menyusul. | URL varian | Bobot | Tambah Varian | Uji split A/B |
| it-IT | Test A/B | Invia i visitatori a uno tra più URL in base al peso, scelto a ogni visita. Non combinabile con pianificazione, routing geografico o reindirizzamenti per dispositivo. I numeri per variante sono disponibili tramite API analytics; i grafici arriveranno. | URL della variante | Peso | Aggiungi variante | Test A/B |
| pt-BR | Teste A/B | Envie visitantes para uma de várias URLs por peso, escolhida a cada visita. Não combinável com agendamento, roteamento geográfico ou redirecionamentos por dispositivo. Os números por variante estão disponíveis via API de analytics; gráficos em breve. | URL da variante | Peso | Adicionar variante | Teste A/B |
| pt-PT | Teste A/B | Envie visitantes para um de vários URLs por peso, escolhido a cada visita. Não combinável com agendamento, encaminhamento geográfico ou redirecionamentos por dispositivo. Os números por variante estão disponíveis via API de analytics; gráficos em breve. | URL da variante | Peso | Adicionar variante | Teste A/B |
| vi-VN | Thử nghiệm A/B | Đưa khách đến một trong nhiều URL theo trọng số, chọn mỗi lượt truy cập. Không kết hợp được với lên lịch, định tuyến địa lý hay chuyển hướng theo thiết bị. Số liệu từng biến thể có qua API phân tích; biểu đồ sắp có. | URL biến thể | Trọng số | Thêm biến thể | Thử nghiệm A/B |
| zh-CN | A/B 分流测试 | 按权重将访问者引导至多个网址之一，每次访问随机选择。不能与定时、地区路由或设备跳转同时使用。各变体的数据可通过分析 API 获取；仪表盘图表即将推出。 | 变体网址 | 权重 | 添加变体 | A/B 分流测试 |
| zh-TW | A/B 分流測試 | 依權重將訪客導向多個網址之一，每次造訪隨機選擇。不能與定時、地區路由或裝置跳轉同時使用。各變體的數據可透過分析 API 取得；儀表板圖表即將推出。 | 變體網址 | 權重 | 新增變體 | A/B 分流測試 |

Validate all 10 parse and none were missed:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
for f in i18n/locales/*.json; do python3 -m json.tool "$f" > /dev/null && echo "ok $f"; done
grep -L "add_variant" i18n/locales/*.json
grep -L "split_test_on" i18n/locales/*.json
```

Expected: `ok` ×10, and **no output** from either `grep -L`.

- [ ] **Step 3: Add the row helpers to `Advanced.vue`**

In `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue`, find `removeScheduleEntry` and add immediately after it:

```ts
type VariantEntry = LinkFormData['variants'][number]

function updateVariant(entries: VariantEntry[], index: number | string, value: Partial<VariantEntry>) {
  const targetIndex = Number(index)
  return entries.map((entry, entryIndex) => entryIndex === targetIndex ? { ...entry, ...value } : entry)
}

function removeVariant(entries: VariantEntry[], index: number | string) {
  const targetIndex = Number(index)
  return entries.filter((_, entryIndex) => entryIndex !== targetIndex)
}
```

- [ ] **Step 4: Auto-open the section when a split exists**

In the same file, inside `defaultOpenItems`, find `items.push('schedule')` and its enclosing `if` block, then add immediately after that block:

```ts
  const variantsVal = props.form.getFieldValue('variants')
  if (Array.isArray(variantsVal) && variantsVal.length > 0) {
    items.push('split_test')
  }
```

- [ ] **Step 5: Add the accordion section**

In the same file's `<template>`, find the `<AccordionItem value="schedule">` block and its closing `</AccordionItem>`. Insert this **immediately after** that closing tag:

```vue
    <AccordionItem value="split_test">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.split_test') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="variants">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.split_test_description') }}
              </FieldDescription>
              <div
                v-for="(item, i) in field.state.value" :key="i" class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field class="flex-1">
                  <Input
                    :model-value="item.url"
                    placeholder="https://..."
                    autocomplete="url"
                    :aria-label="$t('links.form.split_test_url')"
                    @input="field.handleChange(updateVariant(field.state.value, i, { url: ($event.target as HTMLInputElement).value }))"
                  />
                </Field>
                <Field class="w-full sm:w-28">
                  <Input
                    type="number"
                    min="1"
                    :model-value="item.weight"
                    :placeholder="$t('links.form.split_test_weight')"
                    :aria-label="$t('links.form.split_test_weight')"
                    @input="field.handleChange(updateVariant(field.state.value, i, { weight: ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value) }))"
                  />
                </Field>
                <Button type="button" variant="ghost" size="icon" @click="field.handleChange(removeVariant(field.state.value, i))">
                  <Trash2 class="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" @click="field.handleChange([...field.state.value, { url: '', weight: undefined }])">
                <Plus class="mr-2 h-4 w-4" /> {{ $t('links.form.add_variant') }}
              </Button>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>
```

`Plus`, `Trash2`, `FieldDescription`, `Field`, `FieldGroup`, `Input` are all already used in this file. Add no imports.

- [ ] **Step 6: Add the `Split` badge to the link card**

In `layers/dashboard/app/components/dashboard/links/Link.vue`, add `Split` to the lucide import on line 4, keeping the list alphabetical (it sorts after `ShieldBan`/`ShieldAlert`, before `SquareChevronDown`).

Then find the schedule badge block (`<template v-if="link.schedule?.length">`) and its closing `</template>`, and insert immediately after it:

```vue
            <template v-if="link.variants?.length">
              <Separator orientation="vertical" />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span
                      class="
                        inline-flex items-center leading-5 whitespace-nowrap
                      "
                    >
                      <Split aria-hidden="true" class="h-4 w-4" />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{{ $t('links.split_test_on') }}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </template>
```

- [ ] **Step 7: Typecheck, lint, commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
pnpm lint:fix
git status --short   # must NOT list wrangler.jsonc or .env
git add layers/dashboard/app/components/dashboard/links/editor/Advanced.vue layers/dashboard/app/components/dashboard/links/Link.vue i18n/locales
git commit -m "feat: add A/B split test editor section and card badge (#11)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Typecheck expected: no output. `lint:fix` reformats Tailwind class strings — keep its output.

---

## Task 4: Verify the branch and open the PR

**Files:** none modified, plus `~/.cache/claude-pr/worktree-11-ab-split-links.md`.

- [ ] **Step 1: Full suite against the built bundle**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
cp wrangler.jsonc /tmp/wrangler-backup.jsonc
python3 - <<'PY'
p='wrangler.jsonc'; s=open(p).read()
old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
assert old in s, "AI block not found"
open(p,'w').write(s.replace(old,''))
PY
printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
unset CI
pnpm build > /tmp/ab-final-build.log 2>&1; echo "BUILD EXIT: $?"
grep -o '"preset": *"[^"]*"' .output/nitro.json
pnpm vitest run 2>&1 | tail -8
git checkout wrangler.jsonc && rm -f .env
```

Expected: `BUILD EXIT: 0`; preset `cloudflare-module`; only `stats.spec.ts` and `logs.spec.ts` fail (22 — the pre-existing baseline). Everything else passes.

- [ ] **Step 2: Final gates and branch state**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
pnpm lint
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
git status --short
git diff master..HEAD --stat -- wrangler.jsonc
git log --oneline master..HEAD
```

Expected: lint exit 0; no typecheck output; **`git status` clean**; **`wrangler.jsonc` diff EMPTY**; commits only on this branch, nothing on `master`.

- [ ] **Step 3: Push and convert the draft PR**

The branch already has an open **draft** PR (#19) containing the spec commit. Push the new commits and mark it ready:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/11-ab-split-links
git push origin worktree-11-ab-split-links
```

Update the PR body to describe the shipped Phase 1 (not just the spec), then mark ready for review:

```bash
gh pr ready 19
```

The body must cover: what the split does; the **mutual-exclusion decision** and why (a precedence would corrupt the measurement) — noting the owner approved it; that this is **Phase 1** with Phase 2 tracked in **#20**; the `blob17` index-logging choice and its reordering caveat; and the test evidence (unit distribution, integration serves-only-variants, rejection cases, regression). Because Phase 2 (#20) is filed, the body **may** use `Closes #11`. End with the standard footer.

**Do NOT merge.** The owner merges.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| `variants: [{url, weight}]`, 2-10, weight positive int | Task 1 Step 1 |
| Mutual exclusion w/ schedule/geo/device, at write time | Task 1 Steps 2-3; Task 2 Step 8 (integration reject) |
| Weighted per-request selection, injected `rand` | Task 2 Steps 1-4 |
| Variants replace `url`; `url` stays fallback | Task 2 Step 5; Task 1 Step 1 |
| Not sticky | Task 2 Step 5 (`Math.random()` per request) |
| Log variant index to `blob17`, additive | Task 2 Steps 6-7 |
| `editableOptionalLinkFields` | Task 1 Step 4 |
| Form wiring (default, submit, clear via >=2) | Task 1 Steps 5-7 |
| Editor accordion + per-request/exclusion/Phase-2 helper text | Task 3 Steps 3-5 |
| `Split` card badge | Task 3 Step 6 |
| i18n ×10 | Task 3 Steps 1-2 |
| `selectVariant` total, never throws | Task 2 Step 3 |
| Testing: unit/integration/rejection/regression/gates | Task 2 Steps 1,8; Task 4 |
| Phase 2 deferred, editor says so | Task 3 Step 1 copy; Phase 2 = #20 |
| PR closes #11 (Phase 2 filed) | Task 4 Step 3 |

No gaps.

**Placeholder scan:** none — every code block complete, every locale value spelled out, every command has an expected result. The one conditional (Task 2 Step 6's context augmentation) has an explicit "if types pass, don't add it" rule rather than a TODO.

**Type consistency:** `selectVariant(variants, rand): { url, index } | null` is named identically in Task 2 Steps 1/3/5. `Link['variants']` (`{ url: string, weight: number }[]`) from Task 1 Step 1 feeds `selectVariant`'s structural `Variant`. `LinkFormData['variants']` (`{ url: string, weight: number | undefined }[]`) is defined in Task 1 Step 5, seeded in Step 6, filtered in Step 7, consumed by Task 3's `VariantEntry` alias. `event.context.linkVariant` (string) is set in Task 2 Step 5 and read in Step 7. `blob17: 'variant'` is consistent across Task 2 Steps 7. Consistent.

# A/B Split Links — Design

**Date:** 2026-07-16
**Status:** Phase 1 approved by default — see "Decisions made without you"
**Issue:** #11

## Purpose

One short link, N destinations with weights. The middleware picks per request
and logs which variant it served, so "which flyer design converts" becomes
answerable with the analytics pipeline that already exists.

## The problem worth getting right

`variants` answers the same question as `schedule` (#10), `geo` routing, and
device redirects: **where does this link point?** They all write to the same
`targetUrl` at `server/middleware/1.redirect.ts:366-374`, in the order
**device > geo > schedule > url**.

Naively adding variants to that chain produces a subtle but real bug: **the
analytics would lie.**

```
link has variants + geo: { DE: '/de-page' }
  → pick variant 1, log "served variant 1"
  → geo override replaces targetUrl with /de-page
  → visitor actually lands on /de-page
  → the log says variant 1. It is wrong.
```

An A/B test whose measurements are silently wrong is worse than no A/B test —
you would ship the losing flyer with confidence. Any design where a variant can
be chosen, logged, and then overridden is unacceptable.

### The resolution: mutual exclusion, not precedence

**A link is either split-tested or routed — never both.** `variants` is
rejected at the API boundary when combined with `schedule`, `geo`, `apple`, or
`google`.

This is deliberately *not* a precedence rule. Inventing a precedence
("variants beat geo") would be guessing at a product decision nobody asked for,
and every ordering has a losing case that silently corrupts data. Refusing the
combination fails **loudly, at write time**, with a message naming the
conflict — instead of quietly producing wrong numbers months later.

It is also the cheap direction to reverse: relaxing a constraint later is easy
and back-compatible; changing an established precedence after links exist in
the wild is not.

Enforced with the existing `refineLinkContent` / `superRefine` pattern already
applied by `create.post.ts` and `upsert.post.ts`.

## Semantics

`variants: [{ url, weight }]`, 2–10 entries. Weighted random per request:

```
variants: [ { url: A, weight: 3 }, { url: B, weight: 1 } ]
→ A is served ~75% of the time, B ~25%
```

- `weight` is a positive integer. Equal weights = even split.
- **Minimum 2 variants.** A one-variant split is just a link; the schema says so
  rather than letting someone build a confusing no-op.
- When `variants` is set it **replaces** `link.url` as the destination. `url` is
  still required by `refineLinkContent` (every redirect link needs one) and acts
  as the fallback if the variant list is somehow unusable.
- **Selection is per request, not sticky.** A returning visitor may get a
  different variant.

## Decisions made without you

The owner was asleep. Each is cheap to reverse and flagged for review:

| Decision | Why | If you disagree |
| --- | --- | --- |
| **Variants exclude `schedule`/`geo`/device** | Any precedence lets a chosen-and-logged variant be overridden, making the measurements wrong. Better to refuse loudly at write time | Relax `refineLinkVariants` and define an explicit precedence |
| **No stickiness** (per-request random) | The issue says "weighted random per-request". Stickiness needs a cookie and a whole consent/identity conversation | Follow-up issue; needs a design of its own |
| **Log the variant *index*, not its URL** | Analytics Engine allows 20 blobs but only **5120 bytes total across all of them**; `blob2` already carries a URL up to 2048 bytes. A second URL risks silently blowing the budget. **Caveat: reordering variants re-labels history** | Add per-variant stable ids to the schema |
| **`blob17`, additively** | `blob1`–`blob16` are in use; AE allows 20. Adding a new blob never disturbs existing ones — old rows simply have no `blob17`. **Not** repurposing `blob2` | — |
| **Minimum 2 variants** | A 1-variant split is a no-op that looks like a feature | Change `.min(2)` |
| **Phase 1 excludes the stats UI** | See below | Merge the phases |

## Scope: this spec is Phase 1 only

The issue bundles two things of very different size:

1. **Phase 1 — the split works and is measured.** Schema, selection, redirect,
   `blob17` logging. Self-contained and independently valuable: the split runs
   in production and data accrues from day one.
2. **Phase 2 — the numbers are visible.** Stats endpoint grouping by the
   variant blob, plus per-variant visits in the dashboard.

Phase 2 is deliberately deferred to its own spec and PR. It is a stats-endpoint
and dashboard-charting job with little overlap with Phase 1, and **it needs
Phase 1 deployed first** — there is no variant data to group by until then.
Splitting also means Phase 1 can ship and start collecting while Phase 2 is
still being designed.

Until Phase 2 lands, variant data is queryable from the analytics API but not
surfaced in the UI. **The editor will say so** rather than implying a
dashboard that doesn't exist yet.

## Architecture

### `server/utils/variants.ts` (new, auto-imported)

```ts
export function selectVariant(variants: { url: string, weight: number }[], rand: number): { url: string, index: number } | null
```

Pure and total. `rand` is a caller-supplied `[0, 1)` value — **injected rather
than calling `Math.random()` internally**, so weighted distribution is
deterministically unit-testable rather than flaky. Returns `null` for an empty
or unusable list, letting the caller fall back to `link.url`.

Selection walks cumulative weights:

```
weights [3, 1] → cumulative [3, 4], total 4
rand 0.00–0.749 → index 0    rand 0.75–0.999 → index 1
```

Declares its parameter structurally rather than importing `Link` (same
rationale as `schedule.ts` and `fencing.ts`). It runs in the redirect hot path
and must never throw.

### Middleware integration

`server/middleware/1.redirect.ts:366`, where `schedule` resolves today:

```ts
let targetUrl = resolveScheduledUrl(link, now)
const variant = link.variants?.length ? selectVariant(link.variants, Math.random()) : null
if (variant) {
  targetUrl = variant.url
  event.context.linkVariant = String(variant.index)
}
```

Mutual exclusion means the geo/device overrides below cannot fire for a variant
link, so the logged variant is always the served variant. `Math.random()` is
called *here*, at the edge, keeping the resolver pure.

### Access log

`blobsMap` in `server/utils/access-log.ts` gains `blob17: 'variant'`, populated
from `event.context.linkVariant` (empty for every non-variant link). Purely
additive: `blob1`–`blob16` keep their meanings and historical rows are
unaffected.

## Schema

```ts
variants: z.array(z.object({
  url: z.string().trim().url().max(2048),
  weight: z.number().int().positive().max(1000),
})).min(2).max(10).optional(),
```

`LinkSchema` stays a flat `z.object` — consumers read `.shape`. The exclusion
rule lives in a new `refineLinkVariants(data, ctx)` in `shared/schemas/link.ts`,
composed alongside the existing `refineLinkContent` by `create.post.ts` and
`upsert.post.ts`, and rejects with a message naming the specific conflict
(e.g. "A split link cannot also use geo routing").

`variants` joins `editableOptionalLinkFields` so it can be edited and cleared
like `geo`.

## Editor

A "Split Test (A/B)" accordion in `Advanced.vue`, mirroring the geo rows: URL +
weight per row, remove button, "Add Variant". Helper text states the split is
per-request (not sticky), that it can't be combined with scheduling, geo
routing, or device redirects, and — until Phase 2 — that per-variant numbers
are available via the analytics API but not yet charted in the dashboard.

A `Split` (lucide) badge on the link card when `link.variants?.length`,
following the Bell/Gauge/Clock/ShieldBan pattern. The card shows `link.url`,
which for a split link is never where visitors actually land — the badge is what
tells the reader to look closer.

## Error handling

- `selectVariant` is total: an empty/unusable list returns `null` and the caller
  falls back to `link.url`. It cannot throw mid-redirect.
- Conflicting configurations are rejected at write time with a specific message.
- No new KV reads/writes and no new network calls — selection is pure in-memory
  work on the already-fetched link.
- `blob17` is empty for non-variant links; no analytics behavior changes for
  existing links.

## Testing

The vitest suite runs once the `ai` binding is temporarily removed from
`wrangler.jsonc` — see the plan's Global Constraints. **The pool tests the
built bundle**, so `pnpm build` must precede any run that covers `server/`.

1. **Unit (`tests/unit/variants.spec.ts`)** — `selectVariant` with injected
   `rand`: boundaries at exactly 0 and just under 1; the cumulative split for
   `[3,1]` at 0.74/0.75; equal weights; a single-element list; an empty list →
   `null`; and a distribution check over a deterministic sequence of `rand`
   values landing within expected proportions.
2. **Integration (`tests/redirect.spec.ts`)** — create a split link, follow it
   many times, and assert **every** `Location` is one of the variant URLs and
   (over enough runs) that both appear. Assert the base `url` is never served
   while variants are set.
3. **Rejection tests** — `variants` + `schedule`, + `geo`, + `apple`/`google`
   each return **400**; a 1-variant list returns 400; a zero/negative weight
   returns 400.
4. **Regression** — a link with no `variants` redirects exactly as before, and
   its `blob17` stays empty.
5. **Static gates** — lint, `types:check` (excl. known `Search.vue` errors),
   `build` with the preset guard.

## Non-goals (YAGNI)

- Stickiness / cookie-based assignment (needs its own design).
- Multi-armed bandit or auto-optimization.
- Per-variant OG metadata.
- Combining splits with scheduling, geo, or device routing (see above).
- The stats UI — that is Phase 2, its own spec and PR.

One PR to `master` for Phase 1, body contains `Closes #11` **only if** Phase 2 is
filed as a follow-up issue first; otherwise reference `#11` without closing it.

# A/B Split Links — Phase 2: Per-Variant Stats — Design

**Date:** 2026-07-16
**Status:** Approved by default — see "Decisions made without you"
**Issue:** #20 (Phase 2 of #11)

## Purpose

Phase 1 shipped the split: a link serves weighted variants and logs the served
variant's **index** to Analytics Engine `blob17`. Data has been accruing but is
only reachable via the raw analytics API. Phase 2 makes it visible: a
per-variant breakdown on the link's analytics page — which variant, its URL and
weight, and its measured visits and unique visitors — so "which flyer converts"
is answerable in the dashboard.

## What already exists (and what that means for scope)

Phase 1 added `blob17: 'variant'` to `blobsMap`. Two consequences:

1. The generic `/api/stats/metrics?type=variant&id=<link>` endpoint **already**
   groups by variant and returns `[{ name: "0", count: N }, …]`. So a minimal
   Phase 2 needs no backend at all.
2. But the generic endpoint returns only `count` (visits = `SUM(_sample_interval)`)
   and a bare index. For A/B analysis you want **unique visitors** per variant
   too, and the index means nothing without the variant's URL.

So Phase 2 adds a small dedicated endpoint for the richer numbers, and a
dashboard card that joins those numbers to the link's current variants.

## Architecture

```
Dashboard (link analytics page)
  analysis/Index.vue  — already receives `link` (has link.variants: URL+weight)
    └─ NEW SplitTest.vue  — shown only when link.variants?.length
         ├─ fetches /api/stats/variants?id=<link.id>&startAt&endAt
         └─ mergeVariantStats(link.variants, rows)  — pure, joins index→URL
             → renders every variant with url, weight, visits, visitors, %

Server
  NEW /api/stats/variants.get.ts
    └─ buildVariantStatsSql(query, dataset)  — pure SQL builder
        → groups AE by blob17, excludes '' (non-split rows),
          returns [{ variant, visits, visitors }]
```

### The two seams that carry the tests

Analytics Engine is queried through `useWAE`, which calls the Cloudflare API
directly and **cannot run in this environment** (same reason `stats.spec.ts`
fails — no AE credentials; see #17). So the testable logic is deliberately
isolated into two pure functions, each unit-tested, with the untestable AE call
kept to a thin shell:

- **`buildVariantStatsSql(query, dataset): string`** — builds the SQL. Unit
  tests assert it groups by the `variant` blob, filters out the empty-string
  bucket (so non-split scans never appear), selects visits and weighted
  distinct visitors, and applies the id/time filters via the existing
  `query2filter`/`appendTimeFilter` helpers.
- **`mergeVariantStats(variants, rows): VariantStat[]`** — joins the AE rows
  (keyed by index string) onto the link's current `variants`. Unit tests cover:
  every configured variant appears even with zero rows; percent is computed
  over total visits; rows whose index is out of range of the current variants
  (variant list was shortened after data accrued) surface as an "orphan" entry
  rather than being dropped or crashing; ordering is by configured index.

## The reordering caveat (carried from Phase 1, made honest here)

The logged value is an **index into `variants` at scan time**. If the owner
later reorders or edits the variant list, historical `blob17=1` rows now point
at a different URL than they did when logged. Phase 2 cannot retroactively know
the old URL. It handles this by being explicit rather than silently wrong:

- Each row is labelled **"Variant {n}"** by its 1-based index first — the index
  is the ground truth of what was logged — with the *current* URL shown beneath
  as a secondary label.
- A short note on the card states that variants reflect the link's current
  configuration and that reordering relabels past data.
- An AE index with no matching current variant (list was shortened) renders as
  **"Variant {n} (removed)"** with its visits, so the data is never dropped.

This is the same fail-honest posture as the rest of the codebase: show the data
we have, name the ambiguity, never fabricate.

## Decisions made without you

The owner asked for #20 then #17 back-to-back and is not reviewing between. Each
is cheap to reverse and flagged:

| Decision | Why | If you disagree |
| --- | --- | --- |
| **A dedicated `/api/stats/variants` endpoint**, not just the generic `metrics?type=variant` | The generic one returns visits only; A/B wants unique **visitors** per variant, and a purpose-built endpoint is a cleaner contract | Delete it and have the card use `metrics?type=variant`, losing per-variant visitors |
| **Join index→URL on the client**, endpoint stays link-agnostic (no KV read) | Matches every existing stats endpoint (AE-only, no KV); the card already holds `link.variants` | Move the join server-side (endpoint reads the link from KV) |
| **Label by index first, URL second** | The index is what was actually logged; the URL can drift (reordering caveat) | Lead with URL, drop the index |
| **Show zero-visit variants** | A variant that never served is a real, meaningful result ("nobody hit B") | Hide them |
| **Per-variant unique visitors** included | More honest than raw scans for "which converts" | Drop it, show visits only |
| **Reuse `Metric`/`List` visual style** or a small bespoke card | Consistency with the existing analytics cards | — |
| **No conversion tracking / significance test** | Out of scope; we only have scans, not conversions | Separate future issue |

## Schema / API

New endpoint `GET /api/stats/variants` (follows the `metrics.get.ts` pattern):

- Query: the existing `QuerySchema` (gives `id`, `startAt`, `endAt`, and blob
  filters). No new query fields. (`variant` is deliberately *not* a `QuerySchema`
  filter key — we group by it, not filter on it, so `query2filter` ignores it,
  which is correct.)
- Returns `{ data: { variant: string, visits: number, visitors: number }[] }`
  — the raw shape `useWAE` returns, one row per non-empty `blob17` value.
- **No `defineRouteMeta`/OpenAPI block** — the existing `server/api/stats/*`
  endpoints don't declare one, and matching that convention keeps the stats
  surface consistent.

Client types (in `layers/dashboard/shared/types/`):

```ts
export interface VariantStatRow { variant: string, visits: number, visitors: number }
export interface VariantStat {
  index: number
  url: string | null   // null when the index has no current variant (removed)
  weight: number | null
  visits: number
  visitors: number
  percent: number
}
```

## Editor copy update

Phase 1's editor helper text says per-variant numbers are "available via the
analytics API; in-dashboard charts are coming." Phase 2 delivers the charts, so
that sentence is updated across all 10 locales to drop the "coming" clause and
point at the link's analytics page.

## Testing

1. **Unit — `buildVariantStatsSql`** (`tests/unit/variant-stats.spec.ts`): the
   SQL groups by the variant blob, excludes the empty bucket, selects visits +
   weighted-distinct visitors, and includes id/time filters. Asserted on the
   generated SQL string (no AE call).
2. **Unit — `mergeVariantStats`**: all configured variants present (incl.
   zero-visit); percent over total; orphan index surfaced as removed; ordering
   by index; empty rows → all-zero variants; empty variants → empty result.
3. **Static gates** — `pnpm lint`, `types:check` (excl. known `Search.vue`),
   `pnpm build` with the preset guard.
4. **Manual note in the PR**: the live AE query path is unverifiable in this
   environment (no credentials — the same gap #17 tracks). The endpoint's shape
   and both pure seams are unit-tested; the AE round-trip is exercised only once
   deployed. This limitation is stated in the PR, not hidden.

## Non-goals (YAGNI)

- Conversion or goal tracking (we log scans, not conversions).
- Statistical-significance / winner declaration.
- Stable per-variant IDs to survive reordering (a Phase-1 schema change; noted
  as a possible future issue if the reordering caveat proves painful).
- Editing variants from the analytics page.
- A CSV export of per-variant stats (the generic access export already covers
  raw rows).

One PR to `master`, body contains `Closes #20`.

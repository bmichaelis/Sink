# Batch Single-Use Codes (Tickets/Vouchers) — Design

**Date:** 2026-07-14
**Status:** Approved
**Issue:** #6

## Purpose

Generate a batch of unique one-use QR codes in one action — "50 drink
vouchers", "30 event tickets" — with a dashboard view of claimed/unclaimed
status, printable QR sheets, and per-code reset. Two redemption modes,
chosen per batch:

- **redirect** (vouchers): the guest scans; the first scan redirects to the
  destination and burns the code; later scans see the standard
  link-expired page.
- **checkin** (tickets): staff scans the guest's code and sees a status page
  (✅ VALID / ❌ ALREADY USED); a **Check in** button marks it used. Loading
  the page never claims — guest curiosity, link previews, and bots cannot
  burn a ticket.

## Requirements

- Batch size 1–100, created in a single API request.
- Code slugs are random (nanoid(10)), never sequential — possessing one code
  must not let anyone guess another. Display order lives in `batchSeq`.
- Claim writes hit per-code KV keys only — a queue of simultaneous check-ins
  must not contend on a shared key.
- Redirect mode reuses `maxHits: 1` end to end: existing middleware
  enforcement, existing expired page, existing per-code Reset.
- Check-in claims require an explicit button POST; GET is always read-only.
- Reset (existing endpoint) also clears `claimedAt`, so codes in both modes
  can be un-burned individually.
- QR export: a print-CSS sheet (grid of QR + code number + short URL) and a
  client-generated ZIP of PNGs.
- Dashboard: new Batches page; the main links list hides batch member links.

## Data model

### Link fields (added to `LinkSchema`, which stays a flat `z.object`)

```ts
batchId: z.string().trim().max(26).optional(),
batchSeq: z.number().int().positive().optional(),
batchMode: z.enum(['redirect', 'checkin']).optional(),
claimedAt: z.number().int().safe().optional(),
```

- Redirect-mode codes additionally get `maxHits: 1` at creation.
- Check-in-mode codes have no `maxHits` and no `url` requirement:
  `refineLinkContent` returns early when `batchMode === 'checkin'`.
- `claimedAt` is server-managed (like `hitCount`/`firstHitAt`): excluded from
  `LinkFormData`, preserved by `mergeEditableLink`, cleared by Reset.

### Batch record (KV key `batch:<id>`)

```ts
interface BatchRecord {
  id: string              // nanoid(10)
  name: string            // 1..128 chars
  mode: 'redirect' | 'checkin'
  url?: string            // destination; required for redirect mode
  count: number           // 1..100
  createdAt: number       // unix seconds
  slugs: string[]         // ordered; batchSeq = index + 1
}
```

Claim state is never stored here — the record is written once at creation
and read for listing/detail. The `slugs` array bounds the detail view to
1 + ≤100 parallel KV gets (`pLimit(10)`, same pattern as the backup util).

### Claimed semantics (uniform accessor)

```
claimed(link) =
  link.batchMode === 'checkin' ? link.claimedAt != null
                               : (link.hitCount ?? 0) >= (link.maxHits ?? Infinity)
```

## API

All under the existing `/api/` auth middleware. New `server/api/batch/`:

| Endpoint | Body/Query | Behavior |
|---|---|---|
| `POST /api/batch/create` | `{ name, mode, url?, count }` | Validate (Zod; `url` required iff mode=redirect, count 1–100). Generate `id` + `count` random slugs. Write the N links first (pLimit(10)), then the batch record. Returns `{ batch }`. |
| `GET /api/batch/list` | — | KV list prefix `batch:`; returns records (metadata only). |
| `GET /api/batch/detail` | `?id=` | Batch record + per-code `{ slug, seq, claimed, claimedAt?, hitCount? }` from parallel link gets. Missing link records (partial delete/corruption) reported as `{ missing: true }`. |
| `POST /api/batch/delete` | `{ id }` | For each slug: `deleteLink` (already cleans sidecar keys), then delete the batch record. |

No batch edit endpoint — recreate instead (YAGNI).

Per-code operations reuse existing endpoints: `/api/link/reset` (extended to
clear `claimedAt`), `/api/link/delete`, `/api/link/query`.

## Middleware (`server/middleware/1.redirect.ts`)

One new branch, checked alongside the text-link branch (after hit-limit /
self-destruct handling — which is inert for check-in codes since they have
no `maxHits`/`viewExpireSeconds`):

```
if (link.batchMode === 'checkin'):
  GET  → render status HTML (no-store):
         not claimed → "✅ VALID — <batch name> · Ticket #<seq>" + Check in button
         claimed     → "❌ ALREADY USED — <local time of claimedAt>"
  POST (form field checkin=true) →
         not claimed → set claimedAt=now, AWAIT KV put, render "Checked in ✓"
         claimed     → render ALREADY USED page
```

- The button is a plain `<form method="POST">` to the same slug — the exact
  mechanism the password page already uses; no new public endpoint.
- The claim KV write is awaited (like self-destruct's `firstHitAt`) so the
  success page is only shown after persistence.
- Access logging (`useAccessLog`) fires on check-in GETs and POSTs like any
  other visit.
- Status/claim pages are server-rendered English (same precedent as the
  hit-limit expired page). Batch `name` and any echoed values are
  HTML-escaped with the existing `escapeHtml` helper.
- Redirect-mode codes take the existing path untouched (`maxHits: 1`).

## Dashboard

New nav entry **Batches** → `layers/dashboard/app/pages/dashboard/batches.vue`
with components under `layers/dashboard/app/components/dashboard/batches/`:

- **Batch list**: cards with name, mode badge, created date, and progress
  (`37/50 claimed`); a Create Batch button. The list endpoint returns
  metadata only, so each card lazily fetches `/api/batch/detail` for its
  progress count (skeleton while loading) — batches are few and detail is
  bounded, so this stays cheap.
- **Create dialog** (ResponsiveModal pattern): name, mode toggle
  (Voucher/redirect vs Ticket/check-in), destination URL (required for
  redirect, optional for check-in — shown for both), count (1–100).
- **Detail view** (query param, like `link.vue`): header with progress +
  actions (Print sheet, Download ZIP, Delete batch with confirm), grid of
  codes: `#seq`, short link + copy, claimed status (+ time), per-code Reset.
- **Print sheet**: `/dashboard/batches?print=<id>` renders a printable view
  — a grid of QR codes (existing client-side QR renderer, same as
  `QRCode.vue`) with code number and short URL under each, styled with
  `@media print` CSS; the user prints to paper/PDF from the browser.
- **ZIP export**: client-side; render each QR to a PNG canvas, zip with the
  `client-zip` package (tiny, streaming), download as
  `<batch-name>-codes.zip` containing `<seq>-<slug>.png`.
- **Links page**: `Index.vue` filters out links with `batchId` so batch
  members don't flood the main list (they remain in KV list/export/backup).

i18n: dashboard strings in all 10 locales. Server-rendered guest/staff pages
stay English (existing precedent).

## Error handling & edge cases

- **Claim race** (two staff POST the same code in the same second): both may
  see success; last write wins. Same accepted KV-race class as hit-limit.
- **Interrupted creation**: links are written before the batch record, so a
  failure mid-create leaves orphan links with random slugs and no batch
  record — invisible in UI, harmless; the user retries. Documented, not
  mitigated (bounded ≤100).
- **Slug collisions**: nanoid(10) over a 10^15 space; creation does not
  check existence (same stance as normal link creation defaults).
- **Batch detail with missing codes**: rendered as a "missing" row rather
  than failing the whole view.
- **Deleting a single code**: codes are hidden from the links page, so
  per-code deletion happens from the batch detail view (reusing
  `/api/link/delete`); a deleted code then shows as a "missing" row. Whole
  batches go through batch delete.

## Out of scope (YAGNI)

- Batch edit/rename; add codes to an existing batch.
- Per-code labels/guest names.
- Staff-PIN-gated check-in (confirm button chosen instead).
- Notifications on batch codes (`notifyUrl` not exposed in batch creation).
- i18n for server-rendered status pages.
- CSV export of claim status (detail view shows it; export can come later).

## Testing

1. **API e2e (dev server, real local KV)**: create batch (both modes);
   assert count, random non-sequential slugs, batch record shape; detail
   shows 0 claimed.
2. **Redirect mode e2e**: first scan `302` + burned (second scan `410`);
   reset un-burns (scan `302` again).
3. **Check-in mode e2e**: GET shows VALID and does NOT claim (GET again
   still VALID); POST `checkin=true` claims (page shows checked-in; GET now
   ALREADY USED); second POST shows ALREADY USED; reset un-claims.
4. **Delete e2e**: batch delete → all codes `404`, record gone from list.
5. **Dashboard walkthrough** (playwright): create a batch in the UI, see
   progress, open print sheet (QRs render), per-code reset works; links
   page does not show batch members.
6. Static gates: `types:check` (excl. known Search.vue), `lint`, `build`.

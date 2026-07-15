# Scheduled Destinations — Design

**Date:** 2026-07-15
**Status:** Approved
**Issue:** #10

## Purpose

Let a single link change where it points over time, so a printed QR code can
follow an event's lifecycle without being reprinted or hand-edited at an
awkward hour. "Before Saturday 6pm → RSVP page; after → photo album."

## Semantics — a phases model

`schedule` is a list of `{ until: <unix>, url }` entries. Sorted ascending by
`until`, the **first entry whose `until` is still in the future** supplies the
URL. If every entry's `until` has passed, the URL falls back to `link.url`.
`link.url` is therefore the *final* destination:

```
schedule: [ { until: <Sat 18:00>, url: "https://example.com/rsvp" } ]
link.url: "https://example.com/photos"

now < Sat 18:00  → https://example.com/rsvp
now >= Sat 18:00 → https://example.com/photos
```

Multiple entries chain into phases (teaser → RSVP → live stream → photos).
The resolver sorts entries itself, so editor row order can never produce
surprising behavior.

## Scope decisions (approved)

- **Precedence: the schedule replaces the base URL.** Geo and device
  overrides still apply on top of the scheduled URL. Final order:
  **device > geo > schedule > `link.url`**.
- **Granularity: date + time**, stored as an absolute unix instant.

## Architecture

The change is deliberately tiny in the request path — one line at the
existing target-resolution point.

```
GET /:slug → server/middleware/1.redirect.ts
    let targetUrl = resolveScheduledUrl(link, now)   // ← was: link.url!
    → geo override (unchanged)
    → buildTarget / query passthrough (unchanged)
    → device override (unchanged)
    → redirect
```

### `server/utils/schedule.ts` (new, auto-imported)

```ts
export function resolveScheduledUrl(link: Link, nowUnix: number): string
```

Pure and total:
- No `schedule`, or an empty array → returns `link.url ?? ''`.
- Otherwise: copy the array, sort ascending by `until`, return the `url` of
  the first entry with `until > nowUnix`.
- All entries passed → returns `link.url ?? ''`.

`link.url` is non-optional for redirect links (enforced by
`refineLinkContent`), so the `?? ''` is defensive only — the function must
never throw in the redirect path. Being pure, it is unit-testable without a
server or Cloudflare bindings.

### Middleware integration

`server/middleware/1.redirect.ts`, at the current line 366:

```ts
let targetUrl = link.url!
```

becomes:

```ts
let targetUrl = resolveScheduledUrl(link, now)
```

`now` (unix seconds) is already in scope at that point — declared above for
hit-limit handling. Nothing else in the redirect path changes: the geo
override, `buildTarget` query passthrough, device override, social-bot OG,
and cloaking branches all continue to operate on `targetUrl` exactly as
before. Text links, check-in codes, and the hit-limit/self-destruct branches
return earlier and are unaffected.

## Schema

Added to `LinkSchema` (which stays a flat `z.object`):

```ts
schedule: z.array(z.object({
  until: z.number().int().safe(),
  url: z.string().trim().url().max(2048),
})).max(10).optional(),
```

The 10-entry cap is a YAGNI/abuse guard; more phases than that is not a use
case we're building for. `schedule` is added to `editableOptionalLinkFields`
in `server/utils/link-processing.ts` so it can be edited and cleared exactly
like `geo`.

Entries whose `until` is in the past are retained as-is (not pruned) — they
are harmless, and pruning would silently rewrite a user's data.

## Editor

A new **"Scheduled destinations"** accordion item in
`layers/dashboard/app/components/dashboard/links/editor/Advanced.vue`,
mirroring the existing geo-routing section's repeating-row structure:

- Each row: an `<Input type="datetime-local">` (native date+time picker,
  shadcn `Input` styling) and a URL `<Input>`, plus a `Trash2` remove button.
- An "Add destination" button appends `{ until: undefined, url: '' }`.
- The section auto-opens (`defaultOpenItems`) when the link already has
  schedule entries.
- Helper text states the semantics: the URL applies *until* the given time;
  after the last entry the link's main URL is used.

**Accepted trade-off:** the existing `expiration` field uses a shadcn
Calendar popover, while these rows use a native `datetime-local` input. That
is one input per row instead of a Calendar + separate time input, which
matters for a repeating row. Visual inconsistency is accepted for the
reduction in surface area.

### Time helpers

Two small additions to `app/utils/time.ts` (home of the existing
`date2unix`/`unix2date`):

```ts
export function unix2datetimeLocal(unix: number): string   // → 'YYYY-MM-DDTHH:mm' in the viewer's local timezone
export function datetimeLocal2unix(value: string): number | undefined  // '' / invalid → undefined
```

Storing an absolute unix instant means the value always renders in the
viewer's own timezone; no timezone field is needed.

### Form wiring

- `LinkFormData`: `schedule` is overridden in `LinkFormFields` to the form
  shape `{ until: number | undefined, url: string }[]` (same technique the
  `geo` field already uses), because a row is incomplete while being typed.
- `Form.vue` `defaultValues`: `schedule: props.link.schedule ? props.link.schedule.map(s => ({ until: s.until, url: s.url })) : []`.
- `Form.vue` `onSubmit`: keep only rows with both a valid `until` and a
  non-empty `url`; send `undefined` when none remain (so clearing all rows
  clears the field via `cleanupOptionalLinkFields`).

## Link card

`layers/dashboard/app/components/dashboard/links/Link.vue` shows a small
**Clock** icon (lucide) in the meta row when `link.schedule?.length`, with a
tooltip "Scheduled destinations" — following the existing Bell/Gauge badge
pattern. This matters because the card displays `link.url`, which is not
necessarily where the link currently points.

## i18n

New keys in all 10 locales under `links.form`: `schedule`,
`schedule_description`, `schedule_until`, `schedule_url`,
`add_schedule_entry`; and under `links`: `scheduled_destinations` (the card
tooltip).

## Error handling

- `resolveScheduledUrl` is total: any malformed/empty state degrades to
  `link.url`. It cannot throw in the redirect path.
- Invalid rows (missing time or URL) are dropped at submit; the schema
  rejects a malformed `url` or non-integer `until` at the API boundary.
- No new KV reads/writes, no new network calls — resolution is pure
  in-memory work on the already-fetched link.

## Testing

1. **Unit (`resolveScheduledUrl`, executable locally via `npx tsx`)**: no
   schedule → `link.url`; empty array → `link.url`; single future entry →
   that URL; now between two cutoffs → the later entry's URL; all cutoffs
   passed → `link.url`; unsorted input → same result as sorted.
2. **e2e (dev server, real local KV)**: create a link whose `schedule` has a
   future cutoff pointing at URL-A with `link.url` = URL-B; scan → `302`
   with `Location: URL-A`. Create one whose only entry is already past →
   `302` with `Location: URL-B`. Assert on the `Location` header.
3. **Regression**: a link with no `schedule` still redirects to `link.url`
   (proves the one-line middleware change is inert when unused).
4. **Browser walkthrough**: add two schedule rows in the editor, save,
   reopen and confirm they round-trip; confirm the Clock badge appears on the
   card; screenshot both.
5. **Static gates**: `types:check` (excl. known Search.vue errors), `lint`,
   `build`.

## Deployment dependency

Scheduled destinations require redirects to be non-permanent. A `301`/`308`
gets cached indefinitely by the visitor's own browser, so a scan that happens
before a cutoff keeps resolving to the old phase from that cache — the worker
is never invoked again, and the phase change is silently never seen by that
visitor. `wrangler.jsonc` pins `NUXT_REDIRECT_STATUS_CODE` to `302` for this
reason (see the comment there), even though the repo's own default in
`nuxt.config.ts` is `301`. Any future change to that setting must preserve a
temporary status code, or scheduled destinations will break in production.

## Non-goals (YAGNI)

- Recurring/repeating schedules (e.g. "every Friday").
- Per-entry timezones (absolute instants only).
- Start times / windows with both a start and an end (an entry is defined
  solely by when it *stops* applying).
- Pruning past entries, or any dashboard visualization of the timeline.
- Scheduling anything other than the destination URL.

One PR to `master`, body contains `Closes #10`.

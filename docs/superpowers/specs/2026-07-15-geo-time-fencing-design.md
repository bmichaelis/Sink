# Geo/Time Fencing — Design

**Date:** 2026-07-15
**Status:** Approved by default — see "Decisions made without you"
**Issue:** #12

## Purpose

Upstream gave geo *routing* (send different countries to different URLs). This
adds geo *blocking* and *active hours*: a link that simply does not work
outside an allowed country, or outside business hours. Useful for a
region-restricted promo and a QR code on a shop door that shouldn't send
people to an ordering page at 3am.

## Two features, one slot

`allowedCountries` and `activeHours` are independent and ship together only
because they occupy the same place in the request: a **gate** that decides
whether the link works at all, before anything decides *where* it points.

```
GET /:slug
  → check-in codes (return early — NOT fenced, see below)
  → ┌─────────────────────────────────┐
    │ FENCE  ← this feature           │  blocked → 403 + explanation page
    └─────────────────────────────────┘
  → hit-limit gate (410 Gone)
  → hit-count increment            ← fence MUST be above this line
  → text links render / redirect resolution (schedule → geo → device)
```

**Placement is load-bearing.** The fence sits immediately *above* the
hit-limit check at `server/middleware/1.redirect.ts:324`, which puts it above
the hit-count increment at `:329`. Two reasons:

1. **A blocked visitor must not burn a hit.** If the fence ran after the
   increment, a single-use voucher scanned from the wrong country would be
   consumed without the visitor ever seeing it.
2. **A blocked visitor should not learn whether the link is expired.** Gating
   first means an out-of-region scanner gets one answer ("not available in
   your region") regardless of the link's internal state.

## Semantics

### `allowedCountries: string[]`

An **allowlist**. Absent or empty → no restriction. Present → the request's
country must be in the list, compared case-insensitively against
`cf.country`.

**Unknown country fails CLOSED.** If Cloudflare cannot determine a country
(`cf.country` undefined), a link with an allowlist **blocks**. An allowlist
means "only these"; admitting an unknown is the wrong reading of that intent.
Note this means fenced links cannot be exercised in local dev without
spoofing `cf.country` — which the test suite does.

### `activeHours: { start, end, tz }`

`start` and `end` are `"HH:MM"` (24-hour); `tz` is an IANA zone
(`America/Denver`). The window is **start-inclusive, end-exclusive**: `09:00`
to `17:00` is active at exactly 09:00 and inactive at exactly 17:00.

- **Overnight windows wrap.** `start > end` (e.g. `22:00`–`06:00`) means the
  window crosses midnight and is handled explicitly.
- **`start === end` means always active.** A zero-width window is
  meaningless, and treating it as "never active" would let a typo silently
  kill a link. This avoids a Zod refinement (see Schema).

### Interaction

Geo is checked first, then hours — deterministic, but the order is only
observable in *which* explanation page a doubly-blocked visitor sees.

Both fences are independent of `schedule` (#10): the fence decides *whether*,
the schedule decides *where*. A fenced link never reaches schedule
resolution.

## Decisions made without you

The owner was asleep. These were judgement calls; each is cheap to reverse
and flagged for review:

| Decision | Why | If you disagree |
| --- | --- | --- |
| Unknown country **blocks** (fail-closed) | An allowlist means "only these" | One-line flip in `evaluateFence` |
| `start === end` → **always active** | A typo shouldn't silently kill a link | One-line flip |
| **403** for both fences (not 410/503) | 410 means permanently gone, which is wrong; 503 + `Retry-After` is more correct for hours but QR scanners don't read it | Change `setResponseStatus` |
| Blocked scans are **not** logged to analytics | Matches the existing hit-limit gate, which also returns before `useAccessLog`. Logging them means moving the access-log call, which touches unrelated code | Follow-up issue — see Non-goals |
| Fencing does **not** apply to check-in codes | They return earlier, above even the hit-limit gate, deliberately ("so stray maxHits can never mutate a check-in code"). Fencing a ticket is a real use case but a different change | Follow-up issue |
| Fencing **does** apply to social-bot OG previews | The bot branch is below the fence, so previews are fenced too. **Correction (final review):** the original reasoning here — "a US-only link pasted in a foreign Slack shows no preview" — was wrong. Unfurl bots fetch from their own datacenters, so `cf.country` is the *bot's* infrastructure country, not the sharer's. The real behavior: a `DE`-only link previews **nowhere** (Slackbot fetches from the US), and an `activeHours` link unfurled at 3am gets no preview *and Slack caches that failure*, so it stays broken during business hours. The decision stands — a fence that bots walk through isn't a fence — but the consequence is bigger than first stated | Exempt verified bots from the fence, accepting that OG previews then leak the destination |
| **One** card badge, not two | Icon soup; the tooltip names which fence is set | — |
| Timezone is a **text input**, not a picker | A searchable IANA picker is a component in its own right; the field defaults to the viewer's own zone, which is right nearly always | Follow-up issue |

## A fenced link's redirect must not be cached

Found in final review, after the gate was already working. The **block** path
sets `Cache-Control: no-store`, but the **pass** path originally did not:
h3's `sendRedirect` sets no cache headers at all.

That made the fence bypassable by design. A visitor who passes once has the
redirect cached by their own browser, and every later scan replays it without
ever reaching the worker — so a `09:00`–`17:00` link, scanned at 14:00, still
opens at 03:00, and a `US`-only link keeps working after its visitor flies to
Berlin. An access-control feature that only checks the first visit is not one.

So a fenced link's redirect is now explicitly uncacheable:

```ts
if (link.allowedCountries?.length || link.activeHours)
  setHeader(event, 'Cache-Control', 'no-store')
```

placed so it dominates **both** redirect exits (the device-redirect branch and
the final fallback). **Unfenced links are untouched** — their cache behavior is
unchanged, guarded by its own regression test, because changing it would alter
every link in production for no reason.

This is why the fence is safe under a 301 default even though this deployment
pins 302: the fence carries its own cache rule rather than depending on the
status code.

## Architecture

### `server/utils/fencing.ts` (new, auto-imported)

```ts
export type FenceReason = 'geo' | 'hours'
export function evaluateFence(link: FenceableLink, country: string | undefined, nowMs: number): FenceReason | null
```

Pure and total — returns `null` when the link is not fenced or the visitor
passes. Declares a structural `FenceableLink` rather than importing `Link`
(same rationale as `server/utils/schedule.ts`: keeps it trivially unit
testable; TypeScript still checks a real `Link` structurally at the call
site). It runs in the redirect hot path and must never throw: a malformed
`tz` that somehow survives validation degrades to UTC rather than throwing.

Local time is derived with `Intl.DateTimeFormat().formatToParts()` using
**`hourCycle: 'h23'`** rather than `hour12: false`. Both return `"00"` at
midnight on this Node build (verified), but `hour12: false` has historically
returned `"24"` for midnight under some ICU/V8 builds, which would silently
corrupt every overnight window. `hourCycle: 'h23'` states the intent
directly and costs nothing. A unit test pins the midnight boundary so the
Workers runtime's actual behavior is asserted rather than assumed.

### Middleware integration

`server/middleware/1.redirect.ts`, immediately above the hit-limit check:

```ts
const fence = evaluateFence(link, event.context.cloudflare?.request?.cf?.country, Date.now())
if (fence) {
  setResponseStatus(event, 403)
  return sendNoStoreHtml(renderFencedPage(fence))
}
```

### `renderExpiredPage` gains parameters

The existing `renderExpiredPage()` (`1.redirect.ts:13`) hardcodes its title
and message. It becomes:

```ts
function renderExpiredPage(title = 'Link Expired', message = 'This link has reached its limit and is no longer available.'): string
```

Defaults preserve both existing call sites byte-for-byte. `renderFencedPage`
wraps it with per-reason copy:

- `geo` → "Not Available Here" / "This link isn't available in your region."
- `hours` → "Outside Active Hours" / "This link is only active during certain hours. Please try again later."

These pages are server-rendered HTML for anonymous visitors and are
deliberately **not** i18n'd — matching the existing expired page, which is
English-only. The dashboard copy *is* translated.

## Schema

Added to `LinkSchema` (stays a flat `z.object` — no top-level `.refine()`):

```ts
allowedCountries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(50).optional(),
activeHours: z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  tz: z.string().trim().min(1).max(64).refine(isValidTimezone, 'Invalid IANA timezone'),
}).optional(),
```

Both are added to `editableOptionalLinkFields` so they can be edited and
cleared like `geo`.

`.refine(isValidTimezone)` on the leaf `tz` string gives a 400 at the API
boundary instead of a silent UTC fallback. This is a nested-field refinement,
so `LinkSchema.shape` is untouched.

### `isValidTimezone` moves to `shared/`

`server/utils/time.ts` already has `isValidTimezone`, but the schema lives in
`shared/` and cannot import server utils. Rather than duplicate the
`try { Intl.DateTimeFormat(...) } catch` , it moves to
`shared/utils/timezone.ts`; `server/utils/time.ts` imports it from there and
keeps exporting `getSafeTimezone` (used by two stats endpoints). No behavior
change, no duplication.

## Editor

Two new accordion sections in `Advanced.vue`, both mirroring the existing
geo-routing section's structure:

- **Geo Restrictions** — repeating rows of `DashboardLinksEditorCountrySelect`
  (the same component geo routing uses) with a remove button, plus "Add
  Country". Helper text: only listed countries can open the link; empty means
  no restriction.
- **Active Hours** — `<Input type="time">` for start and end, an `<Input>` for
  the IANA timezone, and a clear/disable affordance. When the section is first
  populated the timezone defaults to the viewer's own zone via the existing
  `getTimeZone()` helper in `app/utils/time.ts`.

Both auto-open via `defaultOpenItems` when the link already has values.

## Link card

A single **ShieldBan** badge when `link.allowedCountries?.length` or
`link.activeHours` is set, tooltip "Access restricted" — following the
existing Bell/Gauge/Clock badge pattern. The card cannot show *where* a link
points if it's fenced off entirely, so a single honest marker is enough.

## i18n

New keys in all 10 locales under `links.form`: `geo_restrictions`,
`geo_restrictions_description`, `add_allowed_country`, `active_hours`,
`active_hours_description`, `active_hours_start`, `active_hours_end`,
`active_hours_tz`; and under `links`: `access_restricted` (the card tooltip).

## Error handling

- `evaluateFence` is total; it cannot throw in the redirect path.
- Invalid timezone is rejected at the API boundary (400); a malformed one that
  somehow reaches the resolver degrades to UTC.
- Empty `allowedCountries` array is treated as "no restriction", and the
  editor sends `undefined` when the last row is removed, so clearing works via
  `cleanupOptionalLinkFields`.
- No new KV reads/writes and no new network calls — the fence is pure
  in-memory work on the already-fetched link.

## Testing

The repo's vitest suite **does** run (contrary to an earlier assumption)
once the `ai` binding is temporarily removed from `wrangler.jsonc` — see
the plan's Global Constraints. Tests are therefore committed, not throwaway.

1. **Unit (`tests/unit/fencing.spec.ts`, new)** — `evaluateFence` against a
   fixed `nowMs`: no fence → null; allowed country → null; disallowed → 'geo';
   unknown country with an allowlist → 'geo'; case-insensitive match; inside
   window → null; outside → 'hours'; overnight window inside/outside;
   `start === end` → null; boundary at exactly `start` (active) and exactly
   `end` (blocked); invalid tz does not throw.
2. **Integration (`tests/redirect.spec.ts`)** — the existing `cf: { country }`
   spoofing pattern already used by the geo tests: allowed country → 302 to
   the URL; blocked country → **403**; and a link with no fence still
   redirects (regression). Active-hours windows are computed **relative to the
   test's current time in UTC** so they are deterministic rather than
   wall-clock flaky.
3. **Hit-preservation regression** — a link with `maxHits: 1` scanned from a
   blocked country returns 403 and its `hitCount` stays 0. This is the test
   that proves the placement decision above; without it the whole "don't burn
   a hit" rationale is unverified.
4. **Static gates** — `pnpm lint`, `types:check` (excl. known `Search.vue`
   errors), `pnpm build` with the preset guard.

## Non-goals (YAGNI)

- Days of the week ("weekdays only") — `activeHours` is a daily window.
- Multiple windows per day (split shifts).
- Country **block**lists (only allowlists) — the inverse is expressible by
  listing what you want.
- Region/city granularity; ASN or IP fencing.
- Fencing check-in codes (they return before the gate).
- Logging blocked scans to analytics.
- Translating the visitor-facing block pages.

One PR to `master`, body contains `Closes #12`.

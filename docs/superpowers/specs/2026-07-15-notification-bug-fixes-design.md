# Scan-Notification Bug Fixes — Design

**Date:** 2026-07-15
**Status:** Approved
**Issues:** #1 (social unfurl bots), #2 (stale notify state + read-error/corruption conflation)

## Purpose

Two contained bug fixes in the scan-notifications feature, both flagged by
the feature's final whole-branch review:

1. **#1** — social link-preview fetchers (WhatsApp, Facebook, TikTok, etc.)
   trigger false "someone scanned your link" push notifications.
2. **#2** — the per-link notify state (`notify:<slug>` KV key) leaks when a
   link's `notifyUrl` is removed, and a transient KV read error is
   indistinguishable from corrupt state (resetting lifetime counters).

## Fix #1 — suppress social unfurl bots

### Problem

`isBotScan()` in `server/utils/scan-notify.ts` only treats a scan as a bot
when `cf.botManagement.verifiedBot` is set or the User-Agent contains one of
`['bot', 'crawler', 'spider', 'preview']`. The redirect middleware
(`server/middleware/1.redirect.ts`) maintains a richer 15-entry `SOCIAL_BOTS`
list for OG-preview rendering. Several of its entries —
`facebookexternalhit`, `whatsapp`, `tiktok`, `mastodon`, `snapchat`,
`skypeuripreview`, `linkexpanding` — contain none of the four generic markers,
so pasting a short link into those apps' message composers (which pre-fetch a
preview) fires a false scan notification.

### Change

- New file **`server/utils/bots.ts`** (auto-imported, per Nitro convention)
  holds the `SOCIAL_BOTS` array and `isSocialBot(userAgent: string): boolean`,
  moved verbatim from the middleware. Single source of truth.
- `server/middleware/1.redirect.ts` deletes its local `SOCIAL_BOTS` const and
  `isSocialBot` function; the auto-imported versions replace them with no
  behavior change (its existing `isSocialBot(userAgent) && hasOgConfig(link)`
  call is unaffected).
- `isBotScan()` in `scan-notify.ts` adds the social check:

  ```ts
  return BOT_UA_MARKERS.some(m => ua.includes(m)) || isSocialBot(ua)
  ```

  (`verifiedBot` short-circuit above stays.) `isSocialBot` already lowercases
  its input, and `ua` here is already lowercased — double-lowercasing is
  harmless.

### Result

WhatsApp/iMessage/Facebook/etc. link-preview fetches no longer notify, and no
state is written for them (the bot check runs before any KV read/write).

## Fix #2a — delete notify state when `notifyUrl` is removed

### Problem

`notify:<slug>` is deleted only in `deleteLink` (`server/utils/link-store.ts`),
i.e. only when the whole link is deleted. Editing a link to clear its
`notifyUrl` leaves the state key behind. Re-adding a `notifyUrl` later resumes
the stale `total` and — because `lastNotifiedAt` is old and the cooldown has
long since elapsed — fires an immediate push on the next scan.

### Change

- New exported helper in `scan-notify.ts`:

  ```ts
  export async function deleteNotifyState(event: H3Event, slug: string): Promise<void> {
    const { KV } = event.context.cloudflare.env
    await KV.delete(notifyStateKey(slug))
  }
  ```

- In `server/api/link/edit.put.ts`, after `newLink = mergeEditableLink(...)`
  (and before/after `putLink` — order does not matter, they touch different
  keys), delete the notify state **only on the set→unset transition**:

  ```ts
  if (existingLink.notifyUrl && !newLink.notifyUrl)
    await deleteNotifyState(event, newLink.slug)
  ```

### Scope decision (approved)

A *changed* `notifyUrl` (set→different-value) keeps its state: lifetime
`total` is a property of the link, not the notify target, and letting the new
target notify on the next scan (old cooldown elapsed) is acceptable. Only
removal (set→unset) clears state.

## Fix #2b — distinguish transient read errors from corruption

### Problem

`const raw = await KV.get(key, { type: 'json' }).catch(() => null)` in
`sendScanNotification` swallows every failure into `null`, which the counter
math treats as zeros. A momentary KV read blip therefore resets the link's
lifetime `total` to 1 on the next write. Only *corrupt stored JSON* should
reset to zeros.

### Change

Read as text and parse explicitly, so a read failure propagates (skipping the
notification without mutating state) while only a parse failure self-heals:

```ts
const rawText = await KV.get(key, { type: 'text' })
let raw: Partial<NotifyState> | null = null
if (rawText) {
  try {
    raw = JSON.parse(rawText) as Partial<NotifyState>
  }
  catch {
    raw = null // genuinely corrupt → self-heal to zeros on the write below
  }
}
```

If `KV.get` itself throws (transient error), it is caught by the existing
outer `try/catch` in `sendScanNotification`, which logs and returns without
writing — state is preserved. The rest of the function (the `Number(raw?.x)
|| 0` normalization and the cooldown/write logic) is unchanged.

## Non-goals

- No change to redirect-mode behavior, the cooldown algorithm, or the
  notification payload formats.
- No reset of state on a *changed* (not removed) `notifyUrl`.
- No new self-hosted-ntfy or channel work.

## Testing

Dev server with real local KV (`NUXT_SITE_TOKEN=devtoken12345 pnpm dev`,
`CLOUDFLARE_ACCOUNT_ID` set for bindings). All scans use a real random
`ntfy.sh` topic; delivery verified via ntfy's poll API.

1. **#1 bot suppression:** create a link with a `notifyUrl` (cooldown 0);
   scan with `User-Agent: facebookexternalhit/1.1`; assert **no** ntfy
   message arrives. Then scan once with a normal iPhone-Safari UA and assert
   the push reads "1 scan since last ping · 1 total" — proving the prior bot
   scan neither notified nor incremented the counter. Repeat the bot check
   with a `whatsapp/2.x` UA. The Safari scan doubling as a regression guard
   confirms real visits still notify.
2. **#2a stale state:** create link + notifyUrl → human scan (state exists,
   total 1) → edit to remove notifyUrl → edit to re-add notifyUrl → human
   scan → assert the push reads "1 scan since last ping · 1 total" (fresh),
   not a resurrected higher total or an immediate double-fire.
3. **#2b read-error/corruption:** covered by code inspection plus a targeted
   check — manually `PUT` a corrupt value into `notify:<slug>` via a scan
   path is not directly reachable; instead assert via the existing e2e that
   normal operation still batches/counts correctly (regression), and rely on
   the explicit parse-in-try structure for the corruption path (miniflare
   can't simulate a transient read throw, same limitation noted for the
   feature's cache tests).
4. Static gates: `types:check` (excl. known Search.vue), `lint`, `build`.

One PR to `master`, body contains `Closes #1` and `Closes #2`.

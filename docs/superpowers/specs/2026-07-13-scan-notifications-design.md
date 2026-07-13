# Scan Notifications — Design

**Date:** 2026-07-13
**Status:** Approved

## Purpose

Push a notification when someone visits (scans) a link, so QR codes on
physical objects become active: the owner knows the moment the physical
world touches a link. Per-link opt-in; supports ntfy phone push, Discord
webhooks, and generic JSON webhooks through a single URL field.

## Requirements

- **Channels:** ntfy.sh (phone push), Discord webhook, generic webhook —
  auto-detected from the URL; one field serves all three.
- **Scope:** per-link only. A `notifyUrl` field on the link; no global setting.
- **Throttling:** per-link cooldown window. First scan notifies immediately;
  scans during the cooldown are counted silently; the next scan after the
  window notifies with the batched count ("N scans since last ping") plus a
  lifetime total.
- **Cooldown:** per-link `notifyCooldownMinutes` (0 = every scan, max 1440);
  default **5 minutes** when unset, applied in logic (not stored).
- **Bots never notify**, regardless of the access-log bot setting.
- **Zero added latency** for the person scanning: the outbound POST runs via
  `event.waitUntil()` after the response is sent.

## Architecture

```
scan → server/middleware/1.redirect.ts
         → existing: hit-limit check / self-destruct / useAccessLog
         → if link.notifyUrl: event.waitUntil(sendScanNotification(event, link))
         → redirect or text-page response (never delayed)

sendScanNotification (server/utils/scan-notify.ts):
  state = KV.get(`notify:<slug>`)            // { lastNotifiedAt, pending, total }
  if bot → return
  if now - lastNotifiedAt >= cooldown:
      POST notification (count = pending + 1, total = total + 1)
      KV.put(state = { lastNotifiedAt: now, pending: 0, total: total + 1 })
  else:
      KV.put(state = { lastNotifiedAt, pending: pending + 1, total: total + 1 })
```

### Components

| Unit | Responsibility |
|---|---|
| `server/utils/scan-notify.ts` (new) | All notification logic: bot check, cooldown state, payload formatting, outbound POST. Exports `sendScanNotification(event, link)`. |
| `server/middleware/1.redirect.ts` | Two one-line hooks (`event.waitUntil(...)`) beside the existing `useAccessLog` call sites — redirect path and text-link path. |
| `shared/schemas/link.ts` | Two new optional fields. |
| `server/utils/link-processing.ts` | Add both fields to `editableOptionalLinkFields`. |
| `server/api/link/delete.post.ts` | Also delete `notify:<slug>` KV key. |
| `layers/dashboard/.../editor/Advanced.vue` | New "Notifications" accordion section (URL + cooldown fields). |
| `layers/dashboard/.../editor/Form.vue` | Default values + submit mapping for the two fields. |
| `layers/dashboard/.../links/Link.vue` | Bell icon in the card meta row when `notifyUrl` is set. |
| `i18n/locales/*` (all 10) | New keys, plus backfill of earlier feature keys missing from de-DE, id-ID, it-IT, pt-BR, pt-PT. |

## Schema

Added to `LinkSchema` (kept a flat `z.object`; `.shape` consumers unaffected):

```ts
notifyUrl: z.string().trim().url().max(2048).optional(),
notifyCooldownMinutes: z.number().int().nonnegative().max(1440).optional(),
```

`LinkFormData` additions mirror `maxHits`: `notifyUrl: string`,
`notifyCooldownMinutes: number | undefined`.

## Notification state (KV)

Key `notify:<slug>`, value:

```json
{ "lastNotifiedAt": 1783719000, "pending": 0, "total": 27 }
```

- Separate key rather than fields on the link object: avoids interacting with
  the link read cache (`linkCacheTtl`) and the hit-limit/self-destruct link
  writes.
- Read fresh (no `cacheTtl`) — the volume is one read per scan on opted-in
  links only.
- Deleted alongside the link in the delete endpoint. No TTL.

## Payload formats (auto-detected from `notifyUrl`)

| Detection | Format |
|---|---|
| hostname is `ntfy.sh` | POST, plain-text body = message, header `X-Title: Scan: <slug>` |
| hostname `discord.com`/`discordapp.com` with `/api/webhooks/` path | POST JSON `{ "content": <message> }` |
| anything else | POST JSON: `{ slug, shortLink, count, total, country, city, device, browser, referer, timestamp }` |

Message text (ntfy/Discord):

```
🔗 bavvr5 scanned from Salt Lake City, US (Chrome/iOS) — 3 scans since last ping · 27 total
```

Geo/device values come from the same sources `useAccessLog` uses
(`cf.country/city`, User-Agent). When unavailable, the message omits them
gracefully. Count phrase is "1 scan" when unbatched.

## Bot filtering

Lightweight check inside `scan-notify.ts` (independent of access-log's
UAParser pipeline): `cf.botManagement?.verifiedBot === true`, or the
lowercased User-Agent contains any of `bot`, `crawler`, `spider`, `preview`.
Bot scans return before touching KV state (they neither notify nor count).

## Error handling

- Outbound fetch: 5-second timeout; all failures caught and `console.error`d.
  A notification failure can never affect the redirect (it runs in
  `waitUntil` after the response) and never throws.
- Invalid `notifyUrl` rejected at the schema boundary (`z.url()`).
- Missing/corrupt KV state treated as `{ lastNotifiedAt: 0, pending: 0, total: 0 }`.

## Accepted trade-offs

- **KV races:** two near-simultaneous scans may double-notify or miscount by
  one. Harmless at QR-scan volumes; Queues would fix it and is deliberately
  not used.
- **Trailing batch:** scans during a cooldown are reported by the *next* scan
  after the window. If traffic stops, the pending count waits until the next
  scan whenever it comes. A cron flush could report these sooner — out of
  scope, noted as a possible follow-up.
- **SSRF:** `notifyUrl` is set only by the authenticated dashboard owner
  (single-tenant tool), so outbound fetch to an arbitrary URL is acceptable.
- **410 pages:** scans of hit-limit-expired or self-destructed links do not
  notify (consistent with them not access-logging).

## Editor UI

New "Notifications" accordion item in `Advanced.vue`, following the existing
Device/Geo section pattern:

- **Notify URL** — `FieldInput` with the existing optional-URL validator;
  placeholder `https://ntfy.sh/your-topic`; description explains ntfy,
  Discord, and generic webhooks are all accepted.
- **Cooldown (minutes)** — number input, min 0; placeholder "5"; description
  explains batching and that 0 notifies on every scan.

Section auto-opens (via `defaultOpenItems`) when `notifyUrl` is set.
`Form.vue` maps empty string / empty number to `undefined` on submit, same as
`maxHits`.

## Link card

`Link.vue` shows a small **Bell** icon (lucide `Bell`) in the meta row when
`link.notifyUrl` is set, with a tooltip "Notifications on". No counts shown
on the card (state lives in a separate KV key; not worth a read per card).

## i18n

New keys (`links.form.notifications`, `notify_url`, `notify_url_description`,
`notify_url_placeholder`, `notify_cooldown`, `notify_cooldown_description`,
`notify_cooldown_placeholder`, `links.notifications_on`) added to **all 10
locales**. Additionally backfill the earlier ported-feature keys (text mode,
hit limit, self-destruct, reset) into de-DE, id-ID, it-IT, pt-BR, pt-PT,
which currently fall back to English.

## Testing

1. **Local end-to-end (automatable):** `pnpm dev` with local KV; create a
   link whose `notifyUrl` is a real `ntfy.sh/<random-topic>`; curl-scan it;
   verify delivery via ntfy's poll API
   (`curl ntfy.sh/<topic>/json?poll=1`). Assert message content includes
   slug and counts.
2. **Cooldown behavior:** scan twice within the window (expect exactly one
   push), scan again after the window (expect a push with batched count of 2).
3. **Generic webhook:** point `notifyUrl` at a local echo HTTP server in dev;
   assert the JSON payload shape.
4. **Bot suppression:** scan with a `Googlebot` User-Agent; assert no push
   and no state change.
5. **Static checks:** `pnpm types:check`, `pnpm lint`.
6. **Live smoke test after deploy:** real link + real ntfy topic on
   `scan.flippinflops.com`.

(The repo's vitest workers-pool suite currently fails to initialize in this
environment on an upstream dependency; if it becomes runnable, unit tests for
the cooldown state machine belong in `tests/`.)

## Out of scope

- Cron flush of trailing pending counts.
- Global/default notify URL.
- Email or SMS channels.
- Per-channel explicit type field (auto-detection only).
- Self-hosted ntfy instances: detection matches `ntfy.sh` only, so a
  self-hosted ntfy server receives the generic JSON payload instead of the
  ntfy text format. It still gets notified — the message is just less pretty.
  Acceptable.

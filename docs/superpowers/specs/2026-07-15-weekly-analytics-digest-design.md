# Weekly Analytics Digest — Design

**Date:** 2026-07-15
**Status:** Approved
**Issue:** #8

## Purpose

Push a weekly analytics digest to the self-hosted ntfy server so link
performance is passively visible without opening the dashboard. A Cloudflare
cron queries Analytics Engine for the last 7 days (with a week-over-week
delta) and sends a glanceable phone notification.

## Scope decisions (approved)

- **Content: Focused.** Header totals (visits, visitors) each with a
  week-over-week arrow; top 5 links by visits; top 3 countries.
- **Schedule: Monday 14:00 UTC** (8am Mountain / start-of-week recap of the
  previous 7 days). Cron `0 14 * * 1`.
- **Delivery:** a configurable notify URL (`NUXT_DIGEST_NOTIFY_URL`) pointed
  at the self-hosted ntfy digest topic. Unset = feature off (no separate
  disable flag).

## Architecture

```
Cloudflare cron "0 14 * * 1"
   → cloudflare:scheduled hook (server/plugins/weekly-digest.ts)
       → route: only run when THIS cron fired (not the 00:00 backup cron)
       → buildWeeklyDigest(config)  ── AE SQL ──►  Analytics Engine
       → formatDigest(data)         → ntfy body
       → postDigest(url, title, body) → ntfy.flippinflops.com/digest

Manual trigger (testing): POST /api/digest (auth) runs the same
buildWeeklyDigest + formatDigest + postDigest path.
```

The backup plugin (`server/plugins/backup.ts`) is untouched; the digest is an
independent second subscriber to the same hook.

## Components

### `server/utils/digest.ts` (new, auto-imported)

Pure, testable units:

- `interface DigestData { visits: number, visitors: number, prevVisits: number, prevVisitors: number, topLinks: { slug: string, visits: number }[], topCountries: { country: string, visits: number }[] }`
- `async function buildWeeklyDigest(config): Promise<DigestData>` — runs the
  four AE queries (below) via a config-based query helper and shapes the
  result. `config` is the object returned by `useRuntimeConfig()` (has
  `cfAccountId`, `cfApiToken`, `dataset`); no H3Event needed, so it works in
  the cron context.
- `function formatDigest(data: DigestData): string` — pure formatter →
  multi-line ntfy body.
- `async function postDigest(notifyUrl: string, title: string, body: string): Promise<void>` —
  POSTs to the notify URL, mirroring `postChecked` in `scan-notify.ts`
  (adds `User-Agent: sink-weekly-digest/1.0`, `X-Title: <title>`, 5s
  `AbortSignal.timeout`, throws on non-2xx).
- Private `queryAE(accountId, apiToken, sql): Promise<Array<Record<string, string>>>` —
  POSTs SQL to `https://api.cloudflare.com/client/v4/accounts/<id>/analytics_engine/sql`
  with the bearer token, returns `result.data`. (Same endpoint `useWAE` uses;
  a standalone copy avoids refactoring the event-based `useWAE`.)

### AE queries

`<ds>` = `config.dataset`. All windows use the AE `timestamp` column.

1. **This week totals:**
   `SELECT SUM(_sample_interval) AS visits, ROUND(COUNT(DISTINCT blob4) * SUM(_sample_interval) / COUNT()) AS visitors FROM <ds> WHERE timestamp >= NOW() - INTERVAL '7' DAY`
2. **Previous week totals:**
   `SELECT SUM(_sample_interval) AS visits, ROUND(COUNT(DISTINCT blob4) * SUM(_sample_interval) / COUNT()) AS visitors FROM <ds> WHERE timestamp >= NOW() - INTERVAL '14' DAY AND timestamp < NOW() - INTERVAL '7' DAY`
3. **Top 5 links:**
   `SELECT blob1 AS slug, SUM(_sample_interval) AS visits FROM <ds> WHERE timestamp >= NOW() - INTERVAL '7' DAY GROUP BY slug ORDER BY visits DESC LIMIT 5`
4. **Top 3 countries:**
   `SELECT blob6 AS country, SUM(_sample_interval) AS visits FROM <ds> WHERE timestamp >= NOW() - INTERVAL '7' DAY GROUP BY country ORDER BY visits DESC LIMIT 3`

`blob1` = slug, `blob4` = ip, `blob6` = country per the existing
`blobsMap` in `server/utils/access-log.ts`. `_sample_interval` and the
weighted-distinct idiom match the stats endpoints exactly. AE returns numeric
columns as strings; `buildWeeklyDigest` coerces with `Number(...) || 0`.
Empty-string slug/country rows are dropped from the top lists.

### Week-over-week arrow (in `formatDigest`)

For each of visits/visitors, comparing `cur` to `prev`:
- `prev > 0` → `pct = Math.round((cur - prev) / prev * 100)`; ` ↑{pct}%` if
  `pct > 0`, ` ↓{|pct|}%` if `pct < 0`, ` →0%` if `pct === 0`.
- `prev === 0 && cur > 0` → ` (new)`.
- `prev === 0 && cur === 0` → no arrow.

### Message format

```
📊 Last 7 days

Visits: 142  ↑12%
Visitors: 89  ↓3%

Top links
 1. bavvr5 — 84
 2. promo — 31
 3. flyer — 18

Top countries
 US 120 · CA 14 · GB 8
```

- Title (ntfy `X-Title`): `Weekly digest`.
- Host is intentionally omitted from the header (no request host in cron
  context; keeps the unit host-agnostic).
- **Empty week** (`visits === 0`): body is a single line
  `📊 Last 7 days — no visits.` so the notification still confirms the cron is
  alive.
- Top-links/countries sections are omitted when their list is empty.

### `server/plugins/weekly-digest.ts` (new)

```
defineNitroPlugin → hook 'cloudflare:scheduled':
  const config = useRuntimeConfig()
  if (!config.digestNotifyUrl) return           // feature off
  if (!isDigestCron(event)) return              // wrong cron (e.g. backup)
  try {
    const data = await buildWeeklyDigest(config)
    await postDigest(config.digestNotifyUrl, 'Weekly digest', formatDigest(data))
  } catch (error) { console.error('[digest] Failed:', error) }
```

`isDigestCron(event)`: returns `event.cron === '0 14 * * 1'` when the runtime
exposes the fired cron on the scheduled controller; otherwise falls back to
`now.getUTCDay() === 1 && now.getUTCHours() === 14`. Since the two configured
crons run at different hours (00:00 backup, 14:00 digest), the hour-based
fallback unambiguously distinguishes them.

### `server/api/digest.post.ts` (new, auth-gated)

Mirrors `server/api/backup.post.ts`. Runs `buildWeeklyDigest(useRuntimeConfig(event))`
+ `postDigest(...)` and returns `{ success: true, message: string, preview: string }`
where `preview` is the sent body (so a manual run shows exactly what went
out). Returns a 400-class error if `digestNotifyUrl` is unset.

### Config

- `nuxt.config.ts` runtimeConfig: add `digestNotifyUrl: ''` (env
  `NUXT_DIGEST_NOTIFY_URL`).
- `wrangler.jsonc` triggers: `"crons": ["0 0 * * *", "0 14 * * 1"]`.
- Production: set the `NUXT_DIGEST_NOTIFY_URL` **secret** to
  `https://ntfy.flippinflops.com/digest?auth=<token>` (set out-of-band with
  `wrangler secret put`, not committed).

## Error handling

- No `digestNotifyUrl` → digest silently skipped (plugin) / 400 (endpoint).
- AE query error, format error, or send failure → caught and `console.error`d
  in the plugin; never throws in the scheduled context.
- `postDigest` non-2xx or timeout → throws (caught by the plugin; surfaced as
  a 500 from the manual endpoint so testing sees the failure).

## Testing

The repo's vitest pool does not run in this environment, and Analytics Engine
is not writable/populated in local dev, so:

1. **`formatDigest` unit test (local, executable):** a standalone Node script
   feeds fixture `DigestData` (normal week, empty week, `prev === 0` "new"
   case, negative delta) and asserts the exact output lines — covers the WoW
   arrow logic and section omission without touching AE.
2. **Static gates (local):** `types:check` (excl. known Search.vue), `lint`,
   `build`.
3. **Live integration (production, final task):** temporarily set the
   `NUXT_DIGEST_NOTIFY_URL` secret to a throwaway ntfy topic, `POST /api/digest`
   against `scan.flippinflops.com`, and verify a real digest arrives via
   ntfy's poll API with plausible numbers; then restore the secret to the
   real digest URL. This exercises `buildWeeklyDigest` (real AE), `formatDigest`,
   and `postDigest` end to end.
4. Cron routing verified by code inspection (the plugin's `isDigestCron`
   guard) plus the endpoint proving the build+send path; the actual scheduled
   invocation is a Cloudflare concern not reproducible in a test.

## Non-goals (YAGNI)

- Per-link digests, historical charts/graphs, email delivery, dashboard UI.
- Configurable content or schedule via UI (env-only).
- Devices/browsers or new-country breakdowns (deferred; "Rich" option not
  chosen).

One PR to `master`, body contains `Closes #8`.

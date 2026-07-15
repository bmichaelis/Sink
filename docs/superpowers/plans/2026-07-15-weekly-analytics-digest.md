# Weekly Analytics Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A weekly Cloudflare cron queries Analytics Engine for the last 7 days and pushes a glanceable digest (totals with week-over-week deltas, top 5 links, top 3 countries) to the self-hosted ntfy server.

**Architecture:** A pure `formatDigest` + AE-querying `buildWeeklyDigest` + ntfy `postDigest` live in `server/utils/digest.ts`. A new `cloudflare:scheduled` plugin runs them on a second cron (`0 14 * * 1`), routed by a shared cron-matching helper; the existing backup plugin gets a matching guard so each cron does exactly one thing. A guarded `POST /api/digest` runs the same path for testing.

**Tech Stack:** Nuxt 4 (layers) + Nitro on Cloudflare Workers, Cloudflare Analytics Engine (SQL API), Workers KV/R2, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-15-weekly-analytics-digest-design.md`
**Issue:** #8 — the PR body must contain `Closes #8`.

## Global Constraints

- Work in the worktree `/home/ubuntu/repos/Sink/.claude/worktrees/8-weekly-analytics-digest` on branch `worktree-8-weekly-analytics-digest`. **Before EVERY git commit run `git rev-parse --show-toplevel` and confirm it prints that worktree path** — if it prints `/home/ubuntu/repos/Sink`, STOP. Never `cd /home/ubuntu/repos/Sink`. Never commit or push master. Ships as a PR.
- Package manager is **pnpm**. **NEVER build or run dev with `CI=true`** (`CI=true` is fine for `pnpm types:check` and `pnpm install`).
- Fresh worktree: run `CI=true pnpm install` first.
- Dev server (start once, background): `CLOUDFLARE_ACCOUNT_ID=3fec0e6981622dd93b3889f06ed9532b NUXT_SITE_TOKEN=devtoken12345 NUXT_REDIRECT_STATUS_CODE=302 pnpm dev` → `http://localhost:7465`. First boot ~90s. If it's down mid-task, report BLOCKED.
- `$SCRATCH` = `/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/digest-tests` — `export SCRATCH=...` and `mkdir -p "$SCRATCH"` at the top of every shell session.
- Server utils in `server/utils/` are **auto-imported** across server code — no import statements needed for functions defined there. `$fetch` (ofetch), `fetch`, `AbortSignal`, `useRuntimeConfig`, `defineNitroPlugin`, `defineRouteMeta`, `eventHandler`, `createError`, `setResponseStatus` are Nitro/Nuxt globals — no imports.
- **Analytics Engine is not populated or writable in local dev**, so `buildWeeklyDigest` can only run for real against production (which has the AE data + `NUXT_CF_API_TOKEN`/`NUXT_CF_ACCOUNT_ID` secrets). Local verification is: the `formatDigest` unit test, the endpoint's "unset URL → 400" wiring check, and types/lint/build. The full AE path is validated live in Task 3.
- Style: 2-space indent, single quotes, no semicolons (`@antfu/eslint-config`; the `lint-staged` pre-commit hook runs `eslint --fix` — its output is normal). Never edit `app/components/ui/**`.
- Every commit message references the issue (`(#8)`) and ends with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- Known pre-existing failure to IGNORE: `types:check` errors in `layers/dashboard/app/components/dashboard/links/Search.vue`. Any OTHER type error is yours.

---

### Task 1: `server/utils/digest.ts` — AE query, build, format, send

**Files:**
- Create: `server/utils/digest.ts`
- Test script: `$SCRATCH/format-test.ts`

**Interfaces:**
- Produces (auto-imported): `interface DigestData`, `buildWeeklyDigest(config: { cfAccountId: string, cfApiToken: string, dataset: string }): Promise<DigestData>`, `formatDigest(data: DigestData): string`, `postDigest(notifyUrl: string, title: string, body: string): Promise<void>`.
- Consumes: nothing from earlier tasks; uses Nitro global `$fetch`, `fetch`, `AbortSignal`.

- [ ] **Step 1: Write the failing `formatDigest` test**

Write `$SCRATCH/format-test.ts` (imports the real function; run with tsx):

```ts
import { formatDigest } from '/home/ubuntu/repos/Sink/.claude/worktrees/8-weekly-analytics-digest/server/utils/digest.ts'

let fail = 0
function eq(label: string, got: string, want: string) {
  if (got === want) { console.log('PASS:', label) }
  else { console.log('FAIL:', label, '\n--- got ---\n' + got + '\n--- want ---\n' + want); fail = 1 }
}

// 1) normal week: up visits, down visitors, links + countries
eq('normal week',
  formatDigest({
    visits: 142, visitors: 89, prevVisits: 127, prevVisitors: 92,
    topLinks: [{ slug: 'bavvr5', visits: 84 }, { slug: 'promo', visits: 31 }, { slug: 'flyer', visits: 18 }],
    topCountries: [{ country: 'US', visits: 120 }, { country: 'CA', visits: 14 }, { country: 'GB', visits: 8 }],
  }),
  [
    '📊 Last 7 days',
    '',
    'Visits: 142  ↑12%',
    'Visitors: 89  ↓3%',
    '',
    'Top links',
    ' 1. bavvr5 — 84',
    ' 2. promo — 31',
    ' 3. flyer — 18',
    '',
    'Top countries',
    ' US 120 · CA 14 · GB 8',
  ].join('\n'))

// 2) empty week
eq('empty week',
  formatDigest({ visits: 0, visitors: 0, prevVisits: 5, prevVisitors: 3, topLinks: [], topCountries: [] }),
  '📊 Last 7 days — no visits.')

// 3) prev zero -> (new); no countries section when empty
eq('new (prev zero)',
  formatDigest({ visits: 10, visitors: 4, prevVisits: 0, prevVisitors: 0,
    topLinks: [{ slug: 'x', visits: 10 }], topCountries: [] }),
  [
    '📊 Last 7 days',
    '',
    'Visits: 10 (new)',
    'Visitors: 4 (new)',
    '',
    'Top links',
    ' 1. x — 10',
  ].join('\n'))

// 4) zero delta arrow
eq('zero delta',
  formatDigest({ visits: 50, visitors: 50, prevVisits: 50, prevVisitors: 50, topLinks: [], topCountries: [] }),
  [
    '📊 Last 7 days',
    '',
    'Visits: 50  →0%',
    'Visitors: 50  →0%',
  ].join('\n'))

console.log(fail ? 'FAILURES' : 'ALL PASS')
process.exit(fail)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx --yes tsx $SCRATCH/format-test.ts`
Expected: an error that `server/utils/digest.ts` cannot be found / has no export `formatDigest` (file doesn't exist yet). Non-zero exit.

- [ ] **Step 3: Create `server/utils/digest.ts`**

```ts
export interface DigestData {
  visits: number
  visitors: number
  prevVisits: number
  prevVisitors: number
  topLinks: { slug: string, visits: number }[]
  topCountries: { country: string, visits: number }[]
}

interface DigestConfig {
  cfAccountId: string
  cfApiToken: string
  dataset: string
}

async function queryAE(accountId: string, apiToken: string, sql: string): Promise<Array<Record<string, string>>> {
  const res = await $fetch<{ data?: Array<Record<string, string>> }>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: sql,
      retry: 1,
      retryDelay: 100,
    },
  )
  return res.data ?? []
}

export async function buildWeeklyDigest(config: DigestConfig): Promise<DigestData> {
  const { cfAccountId, cfApiToken, dataset } = config
  const q = (sql: string) => queryAE(cfAccountId, cfApiToken, sql)
  const week = `timestamp >= NOW() - INTERVAL '7' DAY`
  const prevWeek = `timestamp >= NOW() - INTERVAL '14' DAY AND timestamp < NOW() - INTERVAL '7' DAY`
  const visitorsExpr = `ROUND(COUNT(DISTINCT blob4) * SUM(_sample_interval) / COUNT())`

  const [cur, prev, links, countries] = await Promise.all([
    q(`SELECT SUM(_sample_interval) AS visits, ${visitorsExpr} AS visitors FROM ${dataset} WHERE ${week}`),
    q(`SELECT SUM(_sample_interval) AS visits, ${visitorsExpr} AS visitors FROM ${dataset} WHERE ${prevWeek}`),
    q(`SELECT blob1 AS slug, SUM(_sample_interval) AS visits FROM ${dataset} WHERE ${week} GROUP BY slug ORDER BY visits DESC LIMIT 5`),
    q(`SELECT blob6 AS country, SUM(_sample_interval) AS visits FROM ${dataset} WHERE ${week} GROUP BY country ORDER BY visits DESC LIMIT 3`),
  ])

  return {
    visits: Number(cur[0]?.visits) || 0,
    visitors: Number(cur[0]?.visitors) || 0,
    prevVisits: Number(prev[0]?.visits) || 0,
    prevVisitors: Number(prev[0]?.visitors) || 0,
    topLinks: links.map(r => ({ slug: r.slug, visits: Number(r.visits) || 0 })).filter(l => l.slug),
    topCountries: countries.map(r => ({ country: r.country, visits: Number(r.visits) || 0 })).filter(c => c.country),
  }
}

function wowArrow(cur: number, prev: number): string {
  if (prev === 0)
    return cur > 0 ? ' (new)' : ''
  const pct = Math.round((cur - prev) / prev * 100)
  if (pct > 0)
    return `  ↑${pct}%`
  if (pct < 0)
    return `  ↓${Math.abs(pct)}%`
  return '  →0%'
}

export function formatDigest(data: DigestData): string {
  if (data.visits === 0)
    return '📊 Last 7 days — no visits.'

  const lines: string[] = ['📊 Last 7 days', '']
  lines.push(`Visits: ${data.visits}${wowArrow(data.visits, data.prevVisits)}`)
  lines.push(`Visitors: ${data.visitors}${wowArrow(data.visitors, data.prevVisitors)}`)

  if (data.topLinks.length) {
    lines.push('', 'Top links')
    data.topLinks.forEach((l, i) => lines.push(` ${i + 1}. ${l.slug} — ${l.visits}`))
  }

  if (data.topCountries.length) {
    lines.push('', 'Top countries')
    lines.push(` ${data.topCountries.map(c => `${c.country} ${c.visits}`).join(' · ')}`)
  }

  return lines.join('\n')
}

export async function postDigest(notifyUrl: string, title: string, body: string): Promise<void> {
  const response = await fetch(notifyUrl, {
    method: 'POST',
    body,
    headers: {
      'User-Agent': 'sink-weekly-digest/1.0',
      'X-Title': title,
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok)
    throw new Error(`digest endpoint responded ${response.status}`)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx --yes tsx $SCRATCH/format-test.ts`
Expected: `PASS:` ×4 then `ALL PASS`, exit 0. If a spacing mismatch appears, the test's expected strings are the source of truth for the format — fix `formatDigest`, not the test.

- [ ] **Step 5: Static checks + commit**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → 0 errors.

Confirm `git rev-parse --show-toplevel` prints the worktree path, then:

```bash
git add server/utils/digest.ts
git commit -m "feat: weekly digest builder, formatter, and ntfy sender (#8)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 2: Cron routing, plugins, endpoint, config

**Files:**
- Create: `server/utils/cron.ts`
- Create: `server/plugins/weekly-digest.ts`
- Create: `server/api/digest.post.ts`
- Modify: `server/plugins/backup.ts` (add a cron guard)
- Modify: `nuxt.config.ts` (runtimeConfig, ~line 36)
- Modify: `wrangler.jsonc` (triggers.crons)

**Interfaces:**
- Consumes: `buildWeeklyDigest`, `formatDigest`, `postDigest` (Task 1); existing `backupKVToR2`.
- Produces (auto-imported): `cronFired(event: unknown, cronExpr: string, utcHour: number, utcDay?: number): boolean`.

- [ ] **Step 1: Create the cron-matching helper `server/utils/cron.ts`**

```ts
// Determine whether the currently-firing Cloudflare scheduled event corresponds
// to a given cron. Prefers the controller's `cron` field when the runtime
// exposes it; otherwise falls back to matching the current UTC hour (and day),
// which is unambiguous here because our two crons run at different hours.
export function cronFired(event: unknown, cronExpr: string, utcHour: number, utcDay?: number): boolean {
  const cron = (event as { cron?: unknown })?.cron
  if (typeof cron === 'string')
    return cron === cronExpr
  const now = new Date()
  return now.getUTCHours() === utcHour && (utcDay === undefined || now.getUTCDay() === utcDay)
}
```

- [ ] **Step 2: Guard the backup plugin to its own cron**

Adding a second cron means the `cloudflare:scheduled` hook fires for both crons, and the backup plugin currently runs on every firing. Guard it so a backup only happens on the daily `0 0 * * *` cron (otherwise the Monday digest cron would also trigger a redundant backup).

In `server/plugins/backup.ts`, the hook body currently is:

```ts
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    const config = useRuntimeConfig()

    if (config.disableAutoBackup) {
      console.info('[backup:kv] Auto backup is disabled by configuration')
      return
    }

    const env = event.env as Cloudflare.Env
    await backupKVToR2(env)
  })
```

Change to:

```ts
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    // Only run on the daily backup cron; other crons (e.g. the weekly digest)
    // share this hook and must not trigger a backup.
    if (!cronFired(event, '0 0 * * *', 0))
      return

    const config = useRuntimeConfig()

    if (config.disableAutoBackup) {
      console.info('[backup:kv] Auto backup is disabled by configuration')
      return
    }

    const env = event.env as Cloudflare.Env
    await backupKVToR2(env)
  })
```

(`cronFired` is auto-imported.)

- [ ] **Step 3: Create the digest plugin `server/plugins/weekly-digest.ts`**

```ts
/// <reference path="../../worker-configuration.d.ts" />

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    const config = useRuntimeConfig()

    if (!config.digestNotifyUrl)
      return
    if (!cronFired(event, '0 14 * * 1', 14, 1))
      return

    try {
      const data = await buildWeeklyDigest(config)
      await postDigest(config.digestNotifyUrl, 'Weekly digest', formatDigest(data))
      console.info('[digest] Weekly digest sent')
    }
    catch (error) {
      console.error('[digest] Failed:', error)
    }
  })
})
```

- [ ] **Step 4: Create the manual-trigger endpoint `server/api/digest.post.ts`**

```ts
defineRouteMeta({
  openAPI: {
    description: 'Manually build and send the weekly analytics digest',
    security: [{ bearerAuth: [] }],
  },
})

export default eventHandler(async (event) => {
  const config = useRuntimeConfig(event)

  if (!config.digestNotifyUrl) {
    throw createError({
      status: 400,
      statusText: 'NUXT_DIGEST_NOTIFY_URL is not configured',
    })
  }

  const data = await buildWeeklyDigest(config)
  const body = formatDigest(data)
  await postDigest(config.digestNotifyUrl, 'Weekly digest', body)

  return {
    success: true,
    message: 'Digest sent successfully',
    preview: body,
  }
})
```

- [ ] **Step 5: Add the `digestNotifyUrl` runtimeConfig key**

In `nuxt.config.ts`, the runtimeConfig currently contains (~line 36):

```ts
    disableAutoBackup: false,
```

Add directly below it:

```ts
    disableAutoBackup: false,
    digestNotifyUrl: '',
```

(Nuxt maps the env var `NUXT_DIGEST_NOTIFY_URL` onto this key at runtime.)

- [ ] **Step 6: Add the weekly cron to `wrangler.jsonc`**

The triggers block currently is:

```jsonc
  "triggers": {
    "crons": ["0 0 * * *"] // Run backup task daily at 00:00 UTC
  }
```

Change to:

```jsonc
  "triggers": {
    "crons": [
      "0 0 * * *", // Daily backup at 00:00 UTC
      "0 14 * * 1" // Weekly analytics digest, Mondays at 14:00 UTC (8am MT)
    ]
  }
```

- [ ] **Step 7: Static checks**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → 0 errors.

- [ ] **Step 8: Dev-server wiring check (unset URL → 400)**

Start the dev server if not running (`CLOUDFLARE_ACCOUNT_ID=3fec0e6981622dd93b3889f06ed9532b NUXT_SITE_TOKEN=devtoken12345 NUXT_REDIRECT_STATUS_CODE=302 pnpm dev`; wait for 200). The dev server has no `NUXT_DIGEST_NOTIFY_URL`, so the endpoint must reject cleanly (proves the endpoint, config read, and auth wiring without needing AE):

```bash
AUTH="Authorization: Bearer devtoken12345"; BASE=http://localhost:7465
# no auth -> 401 (global /api guard)
curl -s -o /dev/null -w "no-auth -> %{http_code}\n" -X POST "$BASE/api/digest"
# authed but unconfigured -> 400
curl -s -o /dev/null -w "unconfigured -> %{http_code}\n" -X POST "$BASE/api/digest" -H "$AUTH"
```

Expected: `no-auth -> 401`, `unconfigured -> 400`.

- [ ] **Step 9: Commit**

Confirm `git rev-parse --show-toplevel` prints the worktree path, then:

```bash
git add server/utils/cron.ts server/plugins/weekly-digest.ts server/plugins/backup.ts server/api/digest.post.ts nuxt.config.ts wrangler.jsonc
git commit -m "feat: weekly digest cron, plugin, endpoint, and config (#8)

Adds a Monday 14:00 UTC cron that pushes the analytics digest, a shared
cron-matching helper, a guarded backup plugin (so the new cron does not
trigger a redundant backup), and a manual POST /api/digest trigger.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 3: Full gates, live production smoke, push, PR

**Files:**
- Create: `~/.cache/claude-pr/worktree-8-weekly-analytics-digest.md` (PR text, outside the repo)
- No repo files modified unless a gate fails.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: pushed branch + PR with `Closes #8`. **Do NOT merge; do NOT push master; do NOT deploy the worker.**

- [ ] **Step 1: Full static + build gate**

```bash
CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"   # expect empty
pnpm lint                                                                 # expect 0 errors
pnpm build                                                                # NO CI=true! expect exit 0
```

- [ ] **Step 2: Re-run the format unit test**

```bash
npx --yes tsx $SCRATCH/format-test.ts   # expect ALL PASS
```

- [ ] **Step 3: Live production integration test (real AE → real ntfy)**

This is the only place the full `buildWeeklyDigest` path runs (local dev has no AE data), and it needs no deploy: run this branch's `digest.ts` locally under tsx, pointed at **production** Analytics Engine (real data) via the session's `CLOUDFLARE_API_TOKEN`, and post the rendered digest to a throwaway ntfy.sh topic. This proves the four AE queries return sane data, `formatDigest` renders them, and `postDigest` delivers — end to end.

```bash
# Pull the prod analytics credentials the digest needs, run buildWeeklyDigest + formatDigest
# locally against real Analytics Engine, and post to a throwaway ntfy topic — proving the
# real query returns sane data and the message renders, without deploying.
export SCRATCH=/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/digest-tests
ACCT=3fec0e6981622dd93b3889f06ed9532b
# The scoped analytics token is stored as a worker secret; reuse the session's broad token
# (CLOUDFLARE_API_TOKEN) which has Analytics:Read for a read-only query.
TOPIC="sink-digest-smoke-$RANDOM$RANDOM"
cat > "$SCRATCH/live-digest.ts" <<TS
import { buildWeeklyDigest, formatDigest, postDigest } from '/home/ubuntu/repos/Sink/.claude/worktrees/8-weekly-analytics-digest/server/utils/digest.ts'
const data = await buildWeeklyDigest({ cfAccountId: '${ACCT}', cfApiToken: process.env.CLOUDFLARE_API_TOKEN!, dataset: 'kinda_sink' })
const body = formatDigest(data)
console.log('--- DIGEST BODY ---\n' + body + '\n-------------------')
await postDigest('https://ntfy.sh/${TOPIC}', 'Weekly digest (smoke)', body)
console.log('posted to https://ntfy.sh/${TOPIC}')
TS
npx --yes tsx "$SCRATCH/live-digest.ts"
sleep 3
echo "=== delivered? ==="
curl -s "https://ntfy.sh/${TOPIC}/json?poll=1" | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    if d.get("event") == "message":
        print("TITLE:", d.get("title")); print(d.get("message"))'
```

Expected: the printed digest body has plausible numbers (`Visits:` line present; top links include real slugs like `bavvr5` if there was traffic, or `📊 Last 7 days — no visits.` if the last 7 days were quiet), and the ntfy poll shows the same message delivered. (ntfy.sh works here because this runs from the VM, not the Workers egress that ntfy.sh blocks.) If `buildWeeklyDigest` throws an AE auth/SQL error, the queries are wrong — fix before proceeding. **Look at the numbers** and confirm they are sane relative to `curl -s "https://scan.flippinflops.com/api/stats/counters" -H "Authorization: Bearer <site token>"`.

- [ ] **Step 4: Push the branch and open the PR**

Confirm `git rev-parse --show-toplevel` prints the worktree path, then:

```bash
git push -u origin worktree-8-weekly-analytics-digest
mkdir -p ~/.cache/claude-pr
cat > ~/.cache/claude-pr/worktree-8-weekly-analytics-digest.md <<'EOF'
feat: weekly analytics digest pushed to ntfy

## What

A Cloudflare cron (`0 14 * * 1` — Mondays 14:00 UTC / 8am MT) queries Analytics Engine for the last 7 days and pushes a glanceable digest to the self-hosted ntfy server:

- Total visits and visitors, each with a week-over-week delta arrow.
- Top 5 links by visits; top 3 countries.
- Empty weeks still send a one-line "no visits" note so the cron's health is visible.

## Implementation

- `server/utils/digest.ts`: `buildWeeklyDigest` (4 Analytics Engine SQL queries reusing the existing `blobsMap`/weighted-distinct idioms), a pure `formatDigest`, and `postDigest` (mirrors the scan-notification sender).
- `server/plugins/weekly-digest.ts`: runs on the new cron, gated by `NUXT_DIGEST_NOTIFY_URL` (unset = off).
- Shared `cronFired` helper routes the shared `cloudflare:scheduled` hook; the backup plugin is guarded to its own daily cron so the digest cron no longer triggers a redundant backup.
- `POST /api/digest` (auth-gated) runs the same path for manual/testing use.

Config: set the `NUXT_DIGEST_NOTIFY_URL` secret to `https://ntfy.flippinflops.com/digest?auth=<token>` after merge.

## Testing

`formatDigest` unit-tested (normal/empty/new/zero-delta cases); endpoint wiring verified (401 unauth, 400 unconfigured); and a live run of `buildWeeklyDigest` against production Analytics Engine rendered and delivered a real digest to a throwaway ntfy topic. Plus types/lint/build.

Closes #8

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
EOF
F=~/.cache/claude-pr/worktree-8-weekly-analytics-digest.md
gh pr create -R bmichaelis/Sink --base master --head worktree-8-weekly-analytics-digest \
  --title "$(head -n 1 "$F")" --body "$(tail -n +3 "$F")"
```

Expected: PR URL printed. Report it. **After merge** (user's call — merging auto-deploys via the Actions workflow), the `NUXT_DIGEST_NOTIFY_URL` secret must be set on the worker for the digest to activate; note this in the report as a required follow-up.

# A/B Split Phase 2 (Per-Variant Stats) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-variant visits and unique visitors on a split link's analytics page, so "which flyer converts" is answerable in the dashboard.

**Architecture:** A dedicated `/api/stats/variants` endpoint groups Analytics Engine by `blob17` (the variant index Phase 1 logs). A dashboard `SplitTest.vue` card, shown only for split links, fetches it and joins the index→URL against the link's current `variants`. All logic that can be tested without Analytics Engine is isolated into two pure functions (`buildVariantStatsSql`, `mergeVariantStats`); the untestable AE call is a thin shell.

**Tech Stack:** Nuxt 4, Nitro on Cloudflare Workers, Analytics Engine (SQL API), sql-bricks, Vue 3, shadcn-vue, `@nuxtjs/i18n`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-ab-split-phase2-design.md`

## Global Constraints

- **This is a fork with verified environment quirks:**
  - **The vitest pool tests the BUILT bundle.** After editing anything under `server/`, run `pnpm build` before endpoint/integration tests reflect it. **Pure unit tests in `tests/unit/` that import a source file directly do NOT need a rebuild.** **Never build with `CI=true`** (`nuxt.config.ts` uses `!import.meta.env.CI` for the Workers preset; `CI=true` silently makes a broken node-server bundle). `CI=true` IS fine for `pnpm types:check`.
  - **The vitest pool only starts with the `ai` binding removed** from `wrangler.jsonc` plus a `.env`:
    ```bash
    cp wrangler.jsonc /tmp/wrangler-backup.jsonc
    python3 - <<'PY'
    p='wrangler.jsonc'; s=open(p).read()
    old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
    assert old in s, "AI block not found"
    open(p,'w').write(s.replace(old,''))
    PY
    printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
    # ...run tests...
    git checkout wrangler.jsonc && rm -f .env   # ALWAYS restore
    ```
    **`wrangler.jsonc` and `.env` must NEVER be committed.** Restore before every commit; `git status` must show neither. Do NOT `git add .`.
  - **The live Analytics Engine query (`useWAE`) cannot run in this environment** — it calls the Cloudflare API and needs credentials this sandbox lacks. This is the same gap that makes `tests/api/stats.spec.ts` and `tests/api/logs.spec.ts` fail (22 tests, pre-existing on `master`, NOT your problem). **Do not try to integration-test the AE round-trip.** The two pure functions carry the test weight; the AE path is exercised only once deployed. State this in the PR.
- Work only in the worktree `/home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats` on branch `worktree-20-ab-split-phase2-stats`. **Never commit to `master`**; never `cd` to `/home/ubuntu/repos/Sink`.
- Code style: 2-space indent, single quotes, **no semicolons**, trailing commas. `pnpm lint:fix` before every commit.
- All code comments and docs in English; comments explain constraints, not narration.
- `pnpm types:check` has pre-existing errors in `layers/dashboard/app/components/dashboard/links/Search.vue` — ignore only those.
- Conventional Commits with `(#20)` in the subject. Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- **Binding decisions (from the spec):** dedicated endpoint returns `{ variant, visits, visitors }` per non-empty `blob17`; the index→URL join happens client-side against the link's current `variants`; rows are labelled by 1-based index first, current URL second; zero-visit variants are shown; an AE index with no current variant renders as "removed"; no OpenAPI block (matches existing `stats/*` endpoints).

## File Structure

| File | Responsibility |
| --- | --- |
| `server/utils/variant-stats.ts` | **New.** Pure `buildVariantStatsSql` — the AE SQL assembly |
| `server/api/stats/variants.get.ts` | **New.** Thin endpoint: resolve globals, call the builder, hand to `useWAE` |
| `layers/dashboard/app/utils/variant-stats.ts` | **New.** Pure `mergeVariantStats` — joins AE rows to the link's variants |
| `layers/dashboard/shared/types/metrics.ts` | `VariantStatRow` + `VariantStat` types |
| `layers/dashboard/app/components/dashboard/analysis/SplitTest.vue` | **New.** The per-variant card |
| `layers/dashboard/app/components/dashboard/analysis/Index.vue` | Render the card for split links |
| `i18n/locales/*.json` (10) | Card copy + update Phase 1's "charts are coming" line |
| `tests/unit/variant-stats-sql.spec.ts` | **New.** Unit tests for `buildVariantStatsSql` |
| `tests/unit/merge-variant-stats.spec.ts` | **New.** Unit tests for `mergeVariantStats` |

---

## Task 1: The stats endpoint and its SQL builder

Deliverable: `GET /api/stats/variants` exists and returns AE-shaped per-variant rows; the SQL assembly is unit-tested.

**Files:**
- Create: `server/utils/variant-stats.ts`
- Create: `server/api/stats/variants.get.ts`
- Create: `tests/unit/variant-stats-sql.spec.ts`

**Interfaces:**
- Consumes: nothing new (uses existing `query2filter`, `logsMap`, `useWAE`, `QuerySchema`).
- Produces: `buildVariantStatsSql(opts): string` where `opts` is `{ dataset: string, variantColumn: string, visitorColumn: string, filter: unknown, startAt?: number, endAt?: number }`; and the endpoint `GET /api/stats/variants` returning `{ meta, data: { variant: string, visits: number, visitors: number }[] }` (the raw `useWAE` shape).

- [ ] **Step 1: Write the failing unit test for the SQL builder**

Create `tests/unit/variant-stats-sql.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildVariantStatsSql } from '../../server/utils/variant-stats'

describe('buildVariantStatsSql', () => {
  const base = { dataset: 'sink', variantColumn: 'blob17', visitorColumn: 'blob4', filter: [] as unknown }

  it('groups by the variant column', () => {
    const sql = buildVariantStatsSql(base)
    expect(sql).toContain('blob17 as variant')
    expect(sql).toMatch(/GROUP BY variant/i)
  })

  it('excludes the empty variant bucket so non-split scans never appear', () => {
    const sql = buildVariantStatsSql(base)
    // blob17 is '' for every non-variant redirect; those rows must be filtered
    // out. sql-bricks renders notEq as `<>` (verified), so accept either form.
    expect(sql).toMatch(/blob17\s*(!=|<>)\s*''/)
  })

  it('selects visits and weighted distinct visitors', () => {
    const sql = buildVariantStatsSql(base)
    expect(sql).toMatch(/SUM\(_sample_interval\) as visits/i)
    expect(sql).toContain('COUNT(DISTINCT blob4)')
    expect(sql).toContain('as visitors')
  })

  it('applies start and end time bounds when given', () => {
    const sql = buildVariantStatsSql({ ...base, startAt: 1000, endAt: 2000 })
    expect(sql).toContain('toDateTime(1000)')
    expect(sql).toContain('toDateTime(2000)')
  })

  it('omits time bounds when not given', () => {
    const sql = buildVariantStatsSql(base)
    expect(sql).not.toContain('toDateTime(')
  })

  it('reads from the given dataset', () => {
    expect(buildVariantStatsSql({ ...base, dataset: 'kinda_sink' })).toContain('kinda_sink')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
pnpm vitest run tests/unit/variant-stats-sql.spec.ts 2>&1 | tail -12
```

Expected: FAIL — cannot resolve `server/utils/variant-stats`. (No env setup needed; this is a pure unit test with no auto-import globals — `sql-bricks` is a normal npm dependency.)

- [ ] **Step 3: Write the SQL builder**

Create `server/utils/variant-stats.ts`:

```ts
// Explicit sql-bricks import (not the Nuxt-auto-imported `SqlBricks` global) so
// this module has no auto-import dependencies and can be unit-tested directly,
// the same way server/utils/schedule.ts and fencing.ts are. The endpoint (a thin
// shell) resolves the auto-imported globals and passes them in.
import SqlBricks from 'sql-bricks'

const { select } = SqlBricks

interface VariantStatsSqlOptions {
  dataset: string
  variantColumn: string // resolved from logsMap.variant, e.g. 'blob17'
  visitorColumn: string // resolved from logsMap.ip, e.g. 'blob4'
  filter: unknown // from query2filter (a sql-bricks expression or [])
  startAt?: number
  endAt?: number
}

// Weighted distinct, matching server/api/stats/[action].get.ts: Analytics Engine
// stores a _sample_interval per row, so a raw COUNT(DISTINCT) under-counts a
// sampled dataset. Scaling by SUM(_sample_interval)/COUNT() re-inflates it.
function weightedDistinct(column: string): string {
  return `ROUND(COUNT(DISTINCT ${column}) * SUM(_sample_interval) / COUNT())`
}

export function buildVariantStatsSql(opts: VariantStatsSqlOptions): string {
  const sql = select([
    `${opts.variantColumn} as variant`,
    'SUM(_sample_interval) as visits',
    `${weightedDistinct(opts.visitorColumn)} as visitors`,
  ].join(', '))
    .from(opts.dataset)
    .where(opts.filter)
    // Only variant scans carry a non-empty index; every other redirect logs ''.
    .where(SqlBricks.notEq(opts.variantColumn, ''))
    .groupBy('variant')
    .orderBy('variant')

  if (opts.startAt !== undefined)
    sql.where(SqlBricks.gte('timestamp', SqlBricks(`toDateTime(${Math.floor(opts.startAt)})`)))
  if (opts.endAt !== undefined)
    sql.where(SqlBricks.lte('timestamp', SqlBricks(`toDateTime(${Math.floor(opts.endAt)})`)))

  return sql.toString()
}
```

- [ ] **Step 4: Run the unit test and watch it pass**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
pnpm vitest run tests/unit/variant-stats-sql.spec.ts 2>&1 | tail -8
```

Expected: all 6 pass.

(`.where([])` with an empty-array filter is verified to work — it produces no clause and combines cleanly with the `<>` exclusion, matching how `metrics.get.ts` passes possibly-`[]` filters to `.where()`. No fallback needed.)

- [ ] **Step 5: Write the endpoint**

Create `server/api/stats/variants.get.ts`, modelled on `server/api/stats/metrics.get.ts`:

```ts
import { QuerySchema } from '#shared/schemas/query'

export default eventHandler(async (event) => {
  const query = await getValidatedQuery(event, QuerySchema.parse)
  const { dataset } = useRuntimeConfig(event)
  const sql = buildVariantStatsSql({
    dataset,
    // logsMap is the value->blobKey reverse of blobsMap; 'variant' -> 'blob17',
    // 'ip' -> 'blob4'. Resolving here (not in the pure builder) keeps the builder
    // free of the auto-imported globals so it stays unit-testable.
    variantColumn: logsMap.variant!,
    visitorColumn: logsMap.ip!,
    filter: query2filter(query),
    startAt: query.startAt,
    endAt: query.endAt,
  })
  return useWAE(event, sql)
})
```

`buildVariantStatsSql`, `logsMap`, `query2filter`, `useWAE` are all auto-imported (server utils). No import needed beyond `QuerySchema`.

- [ ] **Step 6: Typecheck**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
```

Expected: no output.

- [ ] **Step 7: Confirm the route resolves (structural, not an AE round-trip)**

The AE call can't succeed here, but the route should exist and reach `useWAE` (which then fails on credentials — proving routing + SQL build worked, not a 404). Set up the env and build:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
cp wrangler.jsonc /tmp/wrangler-backup.jsonc
python3 - <<'PY'
p='wrangler.jsonc'; s=open(p).read()
old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
assert old in s, "AI block not found"
open(p,'w').write(s.replace(old,''))
PY
printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
pnpm dev > /tmp/p2-dev.log 2>&1 &
sleep 45
grep -E "Local:|Unable to find an available port" /tmp/p2-dev.log
```

Read the port off the banner, then (with auth):

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
PORT=<port from banner>
curl -s -o /dev/null -w 'variants route status: %{http_code}\n' \
  -H 'Authorization: Bearer SinkCool' "http://localhost:$PORT/api/stats/variants?id=test"
# Also confirm the generated SQL is what we expect, from the dev log:
grep -m1 "useWAE" /tmp/p2-dev.log | sed 's/.*useWAE //'
```

Expected: the status is **not 404** (it will be 500 or a CF error because AE credentials are absent/fake — that is fine and expected). The logged SQL line should show `blob17 as variant`, `GROUP BY variant`, and `blob17 != ''`. If the status is 404, the route file is misnamed or misplaced.

Stop the dev server and restore config:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
pkill -f '[n]uxt dev'
git checkout wrangler.jsonc && rm -f .env
git status --short   # must NOT list wrangler.jsonc or .env
```

- [ ] **Step 8: Lint and commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
pnpm lint:fix
git add server/utils/variant-stats.ts server/api/stats/variants.get.ts tests/unit/variant-stats-sql.spec.ts
git commit -m "feat: add per-variant stats endpoint and SQL builder (#20)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

## Task 2: The client join function and types

Deliverable: a pure `mergeVariantStats` that turns AE rows + the link's variants into display rows, fully unit-tested.

**Files:**
- Modify: `layers/dashboard/shared/types/metrics.ts`
- Create: `layers/dashboard/app/utils/variant-stats.ts`
- Create: `tests/unit/merge-variant-stats.spec.ts`

**Interfaces:**
- Consumes: `Link['variants']` shape (`{ url: string, weight: number }[]`) and the endpoint's `{ variant, visits, visitors }[]`.
- Produces: `mergeVariantStats(variants: { url: string, weight: number }[] | undefined, rows: VariantStatRow[]): VariantStat[]`, auto-imported in the dashboard layer.

- [ ] **Step 1: Add the types**

In `layers/dashboard/shared/types/metrics.ts`, append:

```ts
export interface VariantStatRow {
  variant: string
  visits: number
  visitors: number
}

export interface VariantStat {
  index: number
  // null when an AE row's index has no matching current variant (the variant
  // list was shortened after that data was logged — see the reordering caveat).
  url: string | null
  weight: number | null
  visits: number
  visitors: number
  percent: number
}
```

- [ ] **Step 2: Write the failing unit test**

Create `tests/unit/merge-variant-stats.spec.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mergeVariantStats } from '../../layers/dashboard/app/utils/variant-stats'

const variants = [
  { url: 'https://a', weight: 3 },
  { url: 'https://b', weight: 1 },
]

describe('mergeVariantStats', () => {
  it('returns an empty array when the link has no variants', () => {
    expect(mergeVariantStats(undefined, [])).toEqual([])
    expect(mergeVariantStats([], [{ variant: '0', visits: 5, visitors: 4 }])).toEqual([])
  })

  it('shows every configured variant, including zero-visit ones', () => {
    const rows = [{ variant: '0', visits: 30, visitors: 20 }]
    const result = mergeVariantStats(variants, rows)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ index: 0, url: 'https://a', weight: 3, visits: 30, visitors: 20 })
    expect(result[1]).toMatchObject({ index: 1, url: 'https://b', weight: 1, visits: 0, visitors: 0, percent: 0 })
  })

  it('computes percent over total visits', () => {
    const rows = [
      { variant: '0', visits: 75, visitors: 50 },
      { variant: '1', visits: 25, visitors: 20 },
    ]
    const result = mergeVariantStats(variants, rows)
    expect(result[0]!.percent).toBe(75)
    expect(result[1]!.percent).toBe(25)
  })

  it('orders by configured variant index, not by row order', () => {
    const rows = [
      { variant: '1', visits: 25, visitors: 20 },
      { variant: '0', visits: 75, visitors: 50 },
    ]
    const result = mergeVariantStats(variants, rows)
    expect(result.map(r => r.index)).toEqual([0, 1])
  })

  it('surfaces an orphan index (variant removed after data was logged) rather than dropping it', () => {
    // AE has data for index 2, but the link now has only 2 variants (0, 1).
    const rows = [
      { variant: '0', visits: 40, visitors: 30 },
      { variant: '2', visits: 10, visitors: 8 },
    ]
    const result = mergeVariantStats(variants, rows)
    const orphan = result.find(r => r.index === 2)
    expect(orphan).toMatchObject({ index: 2, url: null, weight: null, visits: 10, visitors: 8 })
    // Orphans sort after the configured variants.
    expect(result[result.length - 1]!.index).toBe(2)
  })

  it('treats all-zero totals without dividing by zero', () => {
    const result = mergeVariantStats(variants, [])
    expect(result.every(r => r.percent === 0)).toBe(true)
  })

  it('coerces string counts from the raw AE shape to numbers', () => {
    // useWAE returns numbers as strings in some fields; be defensive.
    const rows = [{ variant: '0', visits: '30' as unknown as number, visitors: '20' as unknown as number }]
    const result = mergeVariantStats(variants, rows)
    expect(result[0]!.visits).toBe(30)
    expect(result[0]!.visitors).toBe(20)
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
pnpm vitest run tests/unit/merge-variant-stats.spec.ts 2>&1 | tail -12
```

Expected: FAIL — cannot resolve `layers/dashboard/app/utils/variant-stats`.

- [ ] **Step 4: Write the join function**

Create `layers/dashboard/app/utils/variant-stats.ts`:

```ts
import type { VariantStat, VariantStatRow } from '../../shared/types/metrics'

// Join Analytics Engine's per-index rows onto the link's current variants.
// - Every configured variant appears, even with zero visits.
// - A row whose index has no current variant (the list was shortened after that
//   data was logged) surfaces as an orphan with url/weight null, so data is
//   never silently dropped — see the reordering caveat in the design spec.
// - Percent is over total visits across all rows shown.
export function mergeVariantStats(
  variants: { url: string, weight: number }[] | undefined,
  rows: VariantStatRow[],
): VariantStat[] {
  if (!variants?.length)
    return []

  const byIndex = new Map<number, { visits: number, visitors: number }>()
  for (const row of rows) {
    const index = Number(row.variant)
    if (!Number.isInteger(index) || index < 0)
      continue
    byIndex.set(index, { visits: Number(row.visits) || 0, visitors: Number(row.visitors) || 0 })
  }

  const total = [...byIndex.values()].reduce((sum, v) => sum + v.visits, 0)
  const pct = (visits: number) => total > 0 ? Math.floor(visits / total * 100) || (visits ? 1 : 0) : 0

  const configured: VariantStat[] = variants.map((variant, index) => {
    const hit = byIndex.get(index) ?? { visits: 0, visitors: 0 }
    return { index, url: variant.url, weight: variant.weight, visits: hit.visits, visitors: hit.visitors, percent: pct(hit.visits) }
  })

  // Orphan indices: AE rows pointing past the current variant list.
  const orphans: VariantStat[] = [...byIndex.entries()]
    .filter(([index]) => index >= variants.length)
    .sort(([a], [b]) => a - b)
    .map(([index, hit]) => ({ index, url: null, weight: null, visits: hit.visits, visitors: hit.visitors, percent: pct(hit.visits) }))

  return [...configured, ...orphans]
}
```

- [ ] **Step 5: Run the unit test and watch it pass**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
pnpm vitest run tests/unit/merge-variant-stats.spec.ts 2>&1 | tail -8
```

Expected: all 7 pass.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
pnpm lint:fix
git add layers/dashboard/shared/types/metrics.ts layers/dashboard/app/utils/variant-stats.ts tests/unit/merge-variant-stats.spec.ts
git commit -m "feat: add mergeVariantStats join and variant stat types (#20)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Typecheck expected: no output.

---

## Task 3: The dashboard card, wiring, and copy

Deliverable: a "Split Test" card on a split link's analytics page showing per-variant URL, weight, visits, visitors, and percent.

**Files:**
- Create: `layers/dashboard/app/components/dashboard/analysis/SplitTest.vue`
- Modify: `layers/dashboard/app/components/dashboard/analysis/Index.vue`
- Modify: all 10 files in `i18n/locales/`

**Interfaces:**
- Consumes: `mergeVariantStats` and `VariantStat` (Task 2); the endpoint `/api/stats/variants` (Task 1); the `link` prop already passed to `analysis/Index.vue`; `useDashboardAnalysisStore()` for `dateRange`/`filters` (as `Metric.vue` does).
- Produces: no new exports.

- [ ] **Step 1: Add the English copy**

In `i18n/locales/en-US.json`, inside the `dashboard` object (find an existing key like `"details"` or `"count"` to anchor near — place these alphabetically-adjacent or at the end of `dashboard`), add:

```json
      "split_test": "Split Test",
      "split_test_variant": "Variant {index}",
      "split_test_removed": "Variant {index} (removed)",
      "split_test_weight": "weight {weight}",
      "split_test_visits": "Visits",
      "split_test_visitors": "Visitors",
      "split_test_note": "Variants reflect the link's current setup; reordering relabels past data.",
      "split_test_empty": "No variant visits recorded yet.",
```

Then update the Phase 1 editor line under `links.form` — replace the existing `split_test_description` value:

```json
      "split_test_description": "Send visitors to one of several URLs by weight, chosen per visit. Can't be combined with scheduling, geo routing, or device redirects. Per-variant results appear on the link's analytics page.",
```

- [ ] **Step 2: Add the same keys to the other 9 locales**

Key names identical; only values translated. `{index}` and `{weight}` are interpolation placeholders — keep them verbatim in every locale.

| Locale | `split_test` | `split_test_variant` | `split_test_removed` | `split_test_weight` | `split_test_visits` | `split_test_visitors` | `split_test_note` | `split_test_empty` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| de-DE | Split-Test | Variante {index} | Variante {index} (entfernt) | Gewicht {weight} | Besuche | Besucher | Varianten zeigen die aktuelle Konfiguration; Umsortieren benennt frühere Daten um. | Noch keine Variantenbesuche erfasst. |
| fr-FR | Test A/B | Variante {index} | Variante {index} (supprimée) | poids {weight} | Visites | Visiteurs | Les variantes reflètent la configuration actuelle ; réordonner renomme les données passées. | Aucune visite de variante enregistrée pour l'instant. |
| id-ID | Uji Split | Varian {index} | Varian {index} (dihapus) | bobot {weight} | Kunjungan | Pengunjung | Varian mencerminkan konfigurasi tautan saat ini; mengurutkan ulang mengubah label data lama. | Belum ada kunjungan varian yang tercatat. |
| it-IT | Test A/B | Variante {index} | Variante {index} (rimossa) | peso {weight} | Visite | Visitatori | Le varianti riflettono la configurazione attuale; riordinare rietichetta i dati passati. | Nessuna visita di variante registrata finora. |
| pt-BR | Teste A/B | Variante {index} | Variante {index} (removida) | peso {weight} | Visitas | Visitantes | As variantes refletem a configuração atual; reordenar renomeia dados antigos. | Nenhuma visita de variante registrada ainda. |
| pt-PT | Teste A/B | Variante {index} | Variante {index} (removida) | peso {weight} | Visitas | Visitantes | As variantes refletem a configuração atual; reordenar renomeia dados antigos. | Ainda não há visitas de variantes registadas. |
| vi-VN | Thử nghiệm A/B | Biến thể {index} | Biến thể {index} (đã xóa) | trọng số {weight} | Lượt truy cập | Khách truy cập | Các biến thể phản ánh cấu hình hiện tại; sắp xếp lại sẽ đổi nhãn dữ liệu cũ. | Chưa ghi nhận lượt truy cập biến thể nào. |
| zh-CN | 分流测试 | 变体 {index} | 变体 {index}（已移除） | 权重 {weight} | 访问量 | 访客数 | 变体反映链接的当前配置；重新排序会改变历史数据的标签。 | 暂无变体访问记录。 |
| zh-TW | 分流測試 | 變體 {index} | 變體 {index}（已移除） | 權重 {weight} | 造訪次數 | 訪客數 | 變體反映連結的目前設定；重新排序會改變歷史資料的標籤。 | 尚無變體造訪記錄。 |

Also update each locale's `links.form.split_test_description` to drop the "coming" clause, translating the en-US replacement from Step 1 in that locale's style (keep it faithful; the key change is replacing "available via the analytics API; in-dashboard charts are coming" with "appear on the link's analytics page").

Validate all 10 parse and none were missed:

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
for f in i18n/locales/*.json; do python3 -m json.tool "$f" > /dev/null && echo "ok $f"; done
grep -L "split_test_note" i18n/locales/*.json
grep -Ln "in-dashboard charts are coming|charts are coming|analytics API" i18n/locales/*.json || true
```

Expected: `ok` ×10; no output from `grep -L` (every locale has the card keys); and the second grep should find **no** remaining "charts are coming"/"analytics API" phrasing in any locale (each was updated).

- [ ] **Step 3: Write the card component**

Create `layers/dashboard/app/components/dashboard/analysis/SplitTest.vue`, mirroring how `Metric.vue` fetches (store-driven, throttled) but rendering the joined variant rows:

```vue
<script setup lang="ts">
import type { Link } from '@/types'
import type { VariantStat, VariantStatRow } from '../../../../shared/types/metrics'
import { watchThrottled } from '@vueuse/core'

const props = defineProps<{
  link: Link
}>()

const { locale } = useI18n()
const analysisStore = useDashboardAnalysisStore()

const stats = ref<VariantStat[]>([])
const pending = ref(true)

async function getVariantStats() {
  pending.value = true
  try {
    const result = await useAPI<{ data: VariantStatRow[] }>('/api/stats/variants', {
      query: {
        id: props.link.id,
        startAt: analysisStore.dateRange.startAt,
        endAt: analysisStore.dateRange.endAt,
        ...analysisStore.filters,
      },
    })
    stats.value = mergeVariantStats(props.link.variants, Array.isArray(result.data) ? result.data : [])
  }
  finally {
    pending.value = false
  }
}

watchThrottled([() => analysisStore.dateRange, () => analysisStore.filters], getVariantStats, {
  deep: true,
  throttle: 500,
  leading: true,
  trailing: true,
})

onMounted(getVariantStats)

const hasVisits = computed(() => stats.value.some(s => s.visits > 0))
</script>

<template>
  <Card class="flex flex-col gap-0 p-0">
    <CardHeader class="px-4 py-3">
      <CardTitle class="text-base">
        {{ $t('dashboard.split_test') }}
      </CardTitle>
      <CardDescription class="text-xs">
        {{ $t('dashboard.split_test_note') }}
      </CardDescription>
    </CardHeader>
    <CardContent class="p-0">
      <div
        class="
          flex justify-between border-t px-4 py-2 text-xs font-medium
          text-muted-foreground
        "
      >
        <span>{{ $t('dashboard.name') }}</span>
        <span class="flex gap-4">
          <span>{{ $t('dashboard.split_test_visits') }}</span>
          <span>{{ $t('dashboard.split_test_visitors') }}</span>
        </span>
      </div>
      <div
        v-for="stat in stats"
        :key="stat.index"
        class="flex items-center justify-between border-t px-4 py-2 text-sm"
      >
        <div class="min-w-0 flex-1 pr-4">
          <div class="font-medium">
            {{ stat.url === null
              ? $t('dashboard.split_test_removed', { index: stat.index + 1 })
              : $t('dashboard.split_test_variant', { index: stat.index + 1 }) }}
            <span
              v-if="stat.weight !== null"
              class="text-xs text-muted-foreground"
            >· {{ $t('dashboard.split_test_weight', { weight: stat.weight }) }}</span>
          </div>
          <div
            v-if="stat.url"
            class="truncate text-xs text-muted-foreground"
          >
            {{ stat.url }}
          </div>
        </div>
        <div class="flex gap-4 text-right tabular-nums">
          <span class="w-16">
            {{ formatNumber(stat.visits, locale) }}
            <span class="text-xs text-gray-500">({{ stat.percent }}%)</span>
          </span>
          <span class="w-12">{{ formatNumber(stat.visitors, locale) }}</span>
        </div>
      </div>
      <div
        v-if="!pending && !hasVisits"
        class="border-t px-4 py-3 text-xs text-muted-foreground"
      >
        {{ $t('dashboard.split_test_empty') }}
      </div>
    </CardContent>
  </Card>
</template>
```

Notes:
- `mergeVariantStats` and `formatNumber` are auto-imported (dashboard `app/utils/`). `Card*` and store are auto-imported.
- If `formatNumber`'s import path differs, check how `List.vue` calls it (it uses `formatNumber(metric.count, locale)` unimported) and match.
- The relative type import path (`../../../../shared/types/metrics`) must resolve from the component's location; verify with `types:check` and adjust the depth if needed (the dashboard layer's `shared/types/` is the target).

- [ ] **Step 4: Render the card for split links**

In `layers/dashboard/app/components/dashboard/analysis/Index.vue`, find `<DashboardAnalysisMetrics />` near the end of the template and insert immediately **before** it:

```vue
    <DashboardAnalysisSplitTest
      v-if="link && link.variants?.length"
      :link="link"
    />
```

`link` is already a prop on this component. The card only renders for split links, so non-split analytics pages are unchanged.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
pnpm lint:fix
git status --short   # must NOT list wrangler.jsonc or .env
git add layers/dashboard/app/components/dashboard/analysis/SplitTest.vue layers/dashboard/app/components/dashboard/analysis/Index.vue i18n/locales
git commit -m "feat: add per-variant split test card to link analytics (#20)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

Typecheck expected: no output. `lint:fix` reformats Tailwind class strings — keep its output.

---

## Task 4: Verify the branch and open the PR

**Files:** none modified, plus `~/.cache/claude-pr/worktree-20-ab-split-phase2-stats.md`.

- [ ] **Step 1: Full suite (build first — server/ changed)**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
cp wrangler.jsonc /tmp/wrangler-backup.jsonc
python3 - <<'PY'
p='wrangler.jsonc'; s=open(p).read()
old='  "ai": {\n    "binding": "AI",\n    "remote": true\n  },\n'
assert old in s, "AI block not found"
open(p,'w').write(s.replace(old,''))
PY
printf 'NUXT_SITE_TOKEN=SinkCool\n' > .env
unset CI
pnpm build > /tmp/p2-build.log 2>&1; echo "BUILD EXIT: $?"
grep -o '"preset": *"[^"]*"' .output/nitro.json
pnpm vitest run 2>&1 | tail -10
git checkout wrangler.jsonc && rm -f .env
```

Expected: `BUILD EXIT: 0`; preset `cloudflare-module`; the two new unit specs pass; the only failures are `stats.spec.ts` and `logs.spec.ts` (22 — the pre-existing AE baseline). Everything else passes.

- [ ] **Step 2: Final gates and branch state**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
pnpm lint
CI=true pnpm types:check 2>&1 | grep -E "error TS" | grep -v "Search.vue" | head
git status --short
git diff master..HEAD --stat -- wrangler.jsonc
git log --oneline master..HEAD
```

Expected: lint exit 0; no typecheck output; **`git status` clean**; **`wrangler.jsonc` diff EMPTY**; commits only on this branch, nothing on `master`.

- [ ] **Step 3: Push and open the PR**

```bash
cd /home/ubuntu/repos/Sink/.claude/worktrees/20-ab-split-phase2-stats
git push -u origin worktree-20-ab-split-phase2-stats
```

Write the PR body to `~/.cache/claude-pr/worktree-20-ab-split-phase2-stats.md` (line 1 = title, line 2 = blank, line 3+ = body). It must cover: what the card shows; that per-variant counts come from Phase 1's `blob17`; the **dedicated-endpoint** and **client-join** decisions from the spec's "Decisions made without you" table; the **reordering caveat** and how the card handles it (index-first labels, "removed" orphans, the note); and — stated plainly — that the live Analytics Engine query path is **not verifiable in this environment** (no credentials, the gap #17 tracks), so the two pure seams are unit-tested and the AE round-trip is exercised only once deployed. End with `Closes #20`, then the standard footer.

```bash
F=~/.cache/claude-pr/worktree-20-ab-split-phase2-stats.md
gh pr create --base master --head worktree-20-ab-split-phase2-stats \
  --title "$(head -n 1 "$F")" --body "$(tail -n +3 "$F")"
```

**Do NOT merge.** The owner merges.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
| --- | --- |
| Dedicated `/api/stats/variants` endpoint | Task 1 Step 5 |
| `buildVariantStatsSql` pure, groups by blob17, excludes '', visits+visitors | Task 1 Steps 1,3 |
| No OpenAPI block (matches stats convention) | Task 1 Step 5 (none added) |
| Client-side index→URL join | Task 2 Steps 2,4 |
| Show every variant incl. zero-visit | Task 2 (test + impl) |
| Orphan index → "removed", not dropped | Task 2 (test + impl); Task 3 Step 3 (render) |
| Label index-first, URL-second | Task 3 Step 3 |
| Per-variant unique visitors | Task 1 (SQL) + Task 3 (render) |
| Reordering caveat note on card | Task 3 Steps 1,3 |
| Card only for split links | Task 3 Step 4 |
| Editor "charts coming" copy updated | Task 3 Steps 1,2 |
| i18n ×10 | Task 3 Steps 1,2 |
| AE path untestable — pure seams tested, stated in PR | Task 1/2 unit tests; Task 4 Step 3 |
| Closes #20 | Task 4 Step 3 |

No gaps.

**Placeholder scan:** none — every code block complete, every locale value spelled out, every command has an expected result. The two conditional adjustments (Task 1 Step 4 empty-filter fallback; Task 3 Step 3 import-path depth) carry explicit "verify and adjust" instructions rather than TODOs.

**Type consistency:** `buildVariantStatsSql(opts): string` is named identically in Task 1 Steps 1/3/5. `mergeVariantStats(variants, rows): VariantStat[]` is named identically in Task 2 Steps 2/4 and consumed in Task 3 Step 3. `VariantStatRow` (`{ variant, visits, visitors }`) and `VariantStat` (`{ index, url, weight, visits, visitors, percent }`) are defined in Task 2 Step 1 and used consistently in the endpoint return shape (Task 1) and the card (Task 3). Consistent.

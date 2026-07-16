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
    // Accept only a non-negative integer index. Number('') is 0 and
    // Number('1.5') is 1.5 — coercing first would misattribute a blank or
    // malformed variant field to a real variant, which this join must never do.
    const raw = String(row.variant).trim()
    if (!/^\d+$/.test(raw))
      continue
    const index = Number(raw)
    // The endpoint GROUP BYs on the variant blob, so at most one row per index.
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

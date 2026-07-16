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

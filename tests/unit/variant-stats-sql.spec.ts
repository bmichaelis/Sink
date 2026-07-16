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

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
    // filter is typed `unknown` in the public interface (see above); cast to the
    // shape sql-bricks expects. query2filter always returns a WhereGroup or `[]`,
    // and `.where([])` is verified to produce no clause.
    .where(opts.filter as SqlBricks.WhereExpression)
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

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

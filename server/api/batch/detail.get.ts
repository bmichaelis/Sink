import type { BatchCodeStatus } from '#shared/schemas/batch'
import pLimit from 'p-limit'
import { z } from 'zod'

const DetailQuerySchema = z.object({
  id: z.string().trim().min(1).max(26),
})

defineRouteMeta({
  openAPI: {
    description: 'Get a batch with per-code claimed status',
    security: [{ bearerAuth: [] }],
    parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
  },
})

export default eventHandler(async (event) => {
  const { id } = await getValidatedQuery(event, DetailQuerySchema.parse)
  const batch = await getBatch(event, id)
  if (!batch) {
    throw createError({ status: 404, statusText: 'Batch not found' })
  }

  const limit = pLimit(10)
  const codes: BatchCodeStatus[] = await Promise.all(batch.slugs.map((slug, i) => limit(async () => {
    const link = await getLink(event, slug)
    if (!link) {
      return { slug, seq: i + 1, missing: true, claimed: false, claimedAt: null, hitCount: 0 }
    }
    const claimed = link.batchMode === 'checkin'
      ? link.claimedAt != null
      : (link.hitCount ?? 0) >= (link.maxHits ?? Number.POSITIVE_INFINITY)
    return {
      slug,
      seq: i + 1,
      missing: false,
      claimed,
      claimedAt: link.claimedAt ?? null,
      hitCount: link.hitCount ?? 0,
    }
  })))

  return { batch, codes, claimedCount: codes.filter(c => c.claimed).length }
})

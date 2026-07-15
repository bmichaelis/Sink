import type { BatchRecord } from '#shared/schemas/batch'
import type { Link } from '#shared/schemas/link'
import { CreateBatchSchema } from '#shared/schemas/batch'
import { nanoid } from '#shared/schemas/link'
import pLimit from 'p-limit'

defineRouteMeta({
  openAPI: {
    description: 'Create a batch of single-use codes',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'mode', 'count'],
            properties: {
              name: { type: 'string', description: 'Batch name' },
              mode: { type: 'string', enum: ['redirect', 'checkin'], description: 'Redemption mode' },
              url: { type: 'string', description: 'Destination URL (required for redirect mode)' },
              count: { type: 'integer', description: 'Number of codes (1-100)' },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event) => {
  const { previewMode } = useRuntimeConfig(event).public
  if (previewMode) {
    throw createError({ status: 403, statusText: 'Preview mode cannot create batches.' })
  }

  const body = await readValidatedBody(event, CreateBatchSchema.parse)
  const generate = nanoid(10)
  const id = generate()
  const now = Math.floor(Date.now() / 1000)
  const slugs = Array.from({ length: body.count }, () => generate())

  const limit = pLimit(10)
  await Promise.all(slugs.map((slug, i) => limit(async () => {
    const link: Link = {
      id: generate(),
      type: 'redirect',
      slug,
      createdAt: now,
      updatedAt: now,
      hitCount: 0,
      batchId: id,
      batchSeq: i + 1,
      batchMode: body.mode,
      ...(body.url ? { url: body.url } : {}),
      ...(body.mode === 'redirect' ? { maxHits: 1 } : {}),
    }
    await putLink(event, link)
  })))

  const batch: BatchRecord = {
    id,
    name: body.name,
    mode: body.mode,
    count: body.count,
    createdAt: now,
    slugs,
    ...(body.url ? { url: body.url } : {}),
  }
  await putBatch(event, batch)

  setResponseStatus(event, 201)
  return { batch }
})

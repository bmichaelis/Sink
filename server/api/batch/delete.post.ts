import pLimit from 'p-limit'
import { z } from 'zod'

const DeleteBatchSchema = z.object({
  id: z.string().trim().min(1).max(26),
})

defineRouteMeta({
  openAPI: {
    description: 'Delete a batch and all of its codes',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', description: 'Batch id' } },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event) => {
  const { previewMode } = useRuntimeConfig(event).public
  if (previewMode) {
    throw createError({ status: 403, statusText: 'Preview mode cannot delete batches.' })
  }

  const { id } = await readValidatedBody(event, DeleteBatchSchema.parse)
  const batch = await getBatch(event, id)
  if (!batch) {
    throw createError({ status: 404, statusText: 'Batch not found' })
  }

  const limit = pLimit(10)
  await Promise.all(batch.slugs.map(slug => limit(() => deleteLink(event, slug))))
  await deleteBatchRecord(event, id)

  return { success: true }
})

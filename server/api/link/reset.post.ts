import type { Link } from '#shared/schemas/link'

defineRouteMeta({
  openAPI: {
    description: 'Reset a link\'s hit count and self-destruct timer',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['slug'],
            properties: {
              slug: { type: 'string', description: 'The slug of the link to reset' },
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
    throw createError({
      status: 403,
      statusText: 'Preview mode cannot reset links.',
    })
  }

  const { slug } = await readBody(event)
  if (!slug) {
    throw createError({
      status: 400,
      statusText: 'Slug is required',
    })
  }

  const existingLink: Link | null = await getLink(event, normalizeSlug(event, slug))
  if (!existingLink) {
    throw createError({
      status: 404,
      statusText: 'Link not found',
    })
  }

  const newLink: Link = {
    ...existingLink,
    hitCount: 0,
    firstHitAt: undefined,
    claimedAt: undefined,
    updatedAt: Math.floor(Date.now() / 1000),
  }

  await putLink(event, newLink)
  setResponseStatus(event, 200)
  return buildLinkResponse(event, newLink)
})

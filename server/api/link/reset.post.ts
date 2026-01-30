import type { LinkSchema } from '@@/schemas/link'
import type { z } from 'zod'

export default eventHandler(async (event) => {
  const { previewMode } = useRuntimeConfig(event).public
  if (previewMode) {
    throw createError({
      status: 403,
      statusText: 'Preview mode cannot reset links.',
    })
  }
  const { slug } = await readBody(event)
  if (slug) {
    const { cloudflare } = event.context
    const { KV } = cloudflare.env

    const existingLink: z.infer<typeof LinkSchema> | null = await KV.get(`link:${slug}`, { type: 'json' })
    if (existingLink) {
      const updatedLink = {
        ...existingLink,
        hitCount: 0,
        firstHitAt: undefined,
        updatedAt: Math.floor(Date.now() / 1000),
      }
      const expiration = getExpiration(event, updatedLink.expiration)
      await KV.put(`link:${slug}`, JSON.stringify(updatedLink), {
        expiration,
        metadata: {
          expiration,
          url: updatedLink.url,
          comment: updatedLink.comment,
        },
      })
      setResponseStatus(event, 200)
      const shortLink = `${getRequestProtocol(event)}://${getRequestHost(event)}/${updatedLink.slug}`
      return { link: updatedLink, shortLink }
    }
  }
})

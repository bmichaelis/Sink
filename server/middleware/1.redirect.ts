import type { LinkSchema } from '@@/schemas/link'
import type { z } from 'zod'
import { marked } from 'marked'
import { parsePath, withQuery } from 'ufo'

function renderTextPage(link: z.infer<typeof LinkSchema>): string {
  const content = link.content || ''
  const htmlContent = marked.parse(content, { async: false }) as string
  const title = link.title || link.slug

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${link.description ? `<meta name="description" content="${link.description}">` : ''}
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #fafafa;
      padding: 2rem 1rem;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #e5e5e5; }
      a { color: #60a5fa; }
      pre, code { background: #2d2d2d; }
      blockquote { border-color: #404040; color: #a3a3a3; }
      hr { border-color: #404040; }
    }
    article {
      max-width: 65ch;
      margin: 0 auto;
    }
    h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 0.5em; line-height: 1.3; }
    h1 { font-size: 2em; }
    h2 { font-size: 1.5em; }
    h3 { font-size: 1.25em; }
    p { margin: 1em 0; }
    a { color: #2563eb; }
    pre {
      background: #f3f4f6;
      padding: 1rem;
      border-radius: 0.5rem;
      overflow-x: auto;
      margin: 1em 0;
    }
    code {
      background: #f3f4f6;
      padding: 0.2em 0.4em;
      border-radius: 0.25rem;
      font-size: 0.9em;
    }
    pre code { background: none; padding: 0; }
    blockquote {
      border-left: 4px solid #e5e7eb;
      padding-left: 1rem;
      margin: 1em 0;
      color: #6b7280;
    }
    ul, ol { margin: 1em 0; padding-left: 2em; }
    li { margin: 0.5em 0; }
    img { max-width: 100%; height: auto; border-radius: 0.5rem; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #e5e7eb; padding: 0.5rem; text-align: left; }
    th { background: #f9fafb; }
  </style>
</head>
<body>
  <article>${htmlContent}</article>
</body>
</html>`
}

export default eventHandler(async (event) => {
  const { pathname: slug } = parsePath(event.path.replace(/^\/|\/$/g, '')) // remove leading and trailing slashes
  const { slugRegex, reserveSlug } = useAppConfig(event)
  const { homeURL, linkCacheTtl, redirectWithQuery, caseSensitive } = useRuntimeConfig(event)
  const { cloudflare } = event.context

  if (event.path === '/' && homeURL)
    return sendRedirect(event, homeURL)

  if (slug && !reserveSlug.includes(slug) && slugRegex.test(slug) && cloudflare) {
    const { KV } = cloudflare.env

    let link: z.infer<typeof LinkSchema> | null = null

    const getLink = async (key: string) =>
      await KV.get(`link:${key}`, { type: 'json', cacheTtl: linkCacheTtl })

    const lowerCaseSlug = slug.toLowerCase()
    link = await getLink(caseSensitive ? slug : lowerCaseSlug)

    // fallback to original slug if caseSensitive is false and the slug is not found
    if (!caseSensitive && !link && lowerCaseSlug !== slug) {
      console.log('original slug fallback:', `slug:${slug} lowerCaseSlug:${lowerCaseSlug}`)
      link = await getLink(slug)
    }

    if (link) {
      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }

      // Handle text type links
      if (link.type === 'text' || (link.content && !link.url)) {
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        return renderTextPage(link)
      }

      // Handle redirect type links
      const target = redirectWithQuery ? withQuery(link.url!, getQuery(event)) : link.url!
      return sendRedirect(event, target, +useRuntimeConfig(event).redirectStatusCode)
    }
  }
})

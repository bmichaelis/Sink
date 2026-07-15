import type { Link } from '@/types'
import { marked } from 'marked'
import { parsePath, withQuery } from 'ufo'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderExpiredPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Link Expired</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      line-height: 1.6;
      color: #1a1a1a;
      background: #fafafa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1a1a1a; color: #e5e5e5; }
      p { color: #9ca3af; }
    }
    .container { text-align: center; padding: 2rem; }
    h1 { font-size: 2em; margin-bottom: 0.5em; }
    p { color: #6b7280; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Link Expired</h1>
    <p>This link has reached its limit and is no longer available.</p>
  </div>
</body>
</html>`
}

function renderTextPage(link: Link): string {
  const content = link.content || ''
  const htmlContent = marked.parse(content, { async: false }) as string
  const title = escapeHtml(link.title || link.slug)

  // Self-destruct countdown timer (only when a first view has been recorded)
  let countdownHtml = ''
  let countdownScript = ''
  let countdownCss = ''
  if (link.viewExpireSeconds && link.firstHitAt) {
    const expiresAt = link.firstHitAt + link.viewExpireSeconds
    countdownHtml = '<div id="countdown" class="countdown"></div>'
    countdownCss = `
    .countdown {
      position: fixed;
      bottom: 1rem;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(239, 68, 68, 0.95);
      color: white;
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      font-size: 0.875rem;
      font-weight: 500;
      z-index: 1000;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    @media (prefers-color-scheme: dark) {
      .countdown { background: rgba(220, 38, 38, 0.95); }
    }`
    countdownScript = `
  <script>
    (function() {
      var expiresAt = ${expiresAt} * 1000;
      var el = document.getElementById('countdown');
      function update() {
        var remaining = Math.max(0, expiresAt - Date.now());
        if (remaining <= 0) { window.location.reload(); return; }
        var secs = Math.ceil(remaining / 1000);
        var mins = Math.floor(secs / 60);
        var s = secs % 60;
        el.textContent = mins > 0
          ? 'Self-destructs in ' + mins + 'm ' + s + 's'
          : 'Self-destructs in ' + secs + 's';
      }
      update();
      setInterval(update, 1000);
    })();
  </script>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  ${link.description ? `<meta name="description" content="${escapeHtml(link.description)}">` : ''}
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
    article { max-width: 65ch; margin: 0 auto; }
    h1, h2, h3, h4, h5, h6 { margin: 1.5em 0 0.5em; line-height: 1.3; }
    h1 { font-size: 2em; }
    h2 { font-size: 1.5em; }
    h3 { font-size: 1.25em; }
    p { margin: 1em 0; }
    a { color: #2563eb; }
    pre { background: #f3f4f6; padding: 1rem; border-radius: 0.5rem; overflow-x: auto; margin: 1em 0; }
    code { background: #f3f4f6; padding: 0.2em 0.4em; border-radius: 0.25rem; font-size: 0.9em; }
    pre code { background: none; padding: 0; }
    blockquote { border-left: 4px solid #e5e7eb; padding-left: 1rem; margin: 1em 0; color: #6b7280; }
    ul, ol { margin: 1em 0; padding-left: 2em; }
    li { margin: 0.5em 0; }
    img { max-width: 100%; height: auto; border-radius: 0.5rem; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 2em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    th, td { border: 1px solid #e5e7eb; padding: 0.5rem; text-align: left; }
    th { background: #f9fafb; }${countdownCss}
  </style>
</head>
<body>
  <article>${htmlContent}</article>
  ${countdownHtml}${countdownScript}
</body>
</html>`
}

type CheckinState = 'valid' | 'used' | 'claimed-now'

function renderCheckinPage(link: Link, batchName: string, state: CheckinState): string {
  const seq = link.batchSeq ?? 0
  const title = escapeHtml(batchName || 'Ticket')
  const usedTime = link.claimedAt
    ? new Date(link.claimedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
    : ''

  let statusHtml = ''
  if (state === 'valid') {
    statusHtml = `
    <div class="mark ok">✓</div>
    <h1>VALID</h1>
    <p class="meta">${title} · Ticket #${seq}</p>
    <form method="POST">
      <input type="hidden" name="checkin" value="true">
      <button type="submit">Check in</button>
    </form>`
  }
  else if (state === 'claimed-now') {
    statusHtml = `
    <div class="mark ok">✓</div>
    <h1>Checked in</h1>
    <p class="meta">${title} · Ticket #${seq}</p>`
  }
  else {
    statusHtml = `
    <div class="mark bad">✕</div>
    <h1>ALREADY USED</h1>
    <p class="meta">${title} · Ticket #${seq}${usedTime ? ` · ${usedTime} UTC` : ''}</p>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · Ticket #${seq}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #fafafa; color: #1a1a1a;
    }
    @media (prefers-color-scheme: dark) { body { background: #1a1a1a; color: #e5e5e5; } }
    .card { text-align: center; padding: 2rem; }
    .mark { font-size: 4rem; line-height: 1; margin-bottom: 0.5rem; }
    .ok { color: #16a34a; }
    .bad { color: #dc2626; }
    h1 { font-size: 2em; margin-bottom: 0.25em; }
    .meta { color: #6b7280; margin-bottom: 1.5rem; }
    button {
      font-size: 1.25rem; font-weight: 600; padding: 0.9rem 3rem; border: none;
      border-radius: 0.75rem; background: #16a34a; color: white; cursor: pointer;
    }
    button:active { background: #15803d; }
  </style>
</head>
<body>
  <div class="card">${statusHtml}</div>
</body>
</html>`
}

function isTextLink(link: Link): boolean {
  return link.type === 'text' || (!!link.content && !link.url)
}

const SOCIAL_BOTS = [
  'applebot',
  'discordbot',
  'facebot',
  'facebookexternalhit',
  'linkedinbot',
  'linkexpanding',
  'mastodon',
  'skypeuripreview',
  'slackbot',
  'slackbot-linkexpanding',
  'snapchat',
  'telegrambot',
  'tiktok',
  'twitterbot',
  'whatsapp',
]

const APPLE_DEVICE_UA_MARKERS = ['iphone', 'ipad', 'ipod', 'crios']

function isSocialBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  return SOCIAL_BOTS.some(bot => ua.includes(bot))
}

function getDeviceRedirectUrl(userAgent: string, link: Link): string | null {
  if (!link.apple && !link.google)
    return null

  const ua = userAgent.toLowerCase()

  if (link.google && ua.includes('android')) {
    return link.google
  }

  if (link.apple && APPLE_DEVICE_UA_MARKERS.some(marker => ua.includes(marker))) {
    return link.apple
  }

  return null
}

function hasOgConfig(link: Link): boolean {
  return !!(link.title || link.image)
}

export default eventHandler(async (event) => {
  const { pathname: slug } = parsePath(event.path.replace(/^\/|\/$/g, ''))
  const { slugRegex, reserveSlug } = useAppConfig()
  const { homeURL, linkCacheTtl, caseSensitive, redirectWithQuery, redirectStatusCode } = useRuntimeConfig(event)
  const { cloudflare } = event.context

  if (event.path === '/' && homeURL)
    return sendRedirect(event, homeURL)

  const { notFoundRedirect } = useRuntimeConfig(event)
  // Bypass redirect check for notFoundRedirect path to prevent infinite loop
  if (notFoundRedirect && event.path === notFoundRedirect) {
    return
  }

  if (slug && !reserveSlug.includes(slug) && slugRegex.test(slug) && cloudflare) {
    let link: Link | null = null

    const lowerCaseSlug = slug.toLowerCase()
    link = await getLink(event, caseSensitive ? slug : lowerCaseSlug, linkCacheTtl)

    if (!caseSensitive && !link && lowerCaseSlug !== slug) {
      console.log('original slug fallback:', `slug:${slug} lowerCaseSlug:${lowerCaseSlug}`)
      link = await getLink(event, slug, linkCacheTtl)
    }

    // Self-destruct links and batch codes must read fresh (bypass KV edge
    // cache) so firstHitAt / claimedAt / hitCount are accurate.
    if (link?.viewExpireSeconds || link?.batchMode) {
      link = await getLink(event, caseSensitive ? slug : lowerCaseSlug)
    }

    if (link) {
      let locale: RedirectLocale | undefined
      const getLocale = () => {
        locale ??= resolveRedirectLocale(event)
        return locale
      }
      const sendNoStoreHtml = (html: string) => {
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        setHeader(event, 'Cache-Control', 'no-store')
        return html
      }
      const userAgent = getHeader(event, 'user-agent') || ''
      const query = getQuery(event)
      const shouldRedirectWithQuery = link.redirectWithQuery ?? redirectWithQuery
      const buildTarget = (url: string) => shouldRedirectWithQuery ? withQuery(url, query) : url

      // Check-in batch codes: GET renders a read-only status page; the
      // confirm-button POST (checkin=true) claims with an awaited write.
      // Runs before the hit-limit/self-destruct block so stray maxHits /
      // viewExpireSeconds fields can never mutate or expire a check-in code.
      if (link.batchMode === 'checkin') {
        event.context.link = link
        try {
          await useAccessLog(event)
        }
        catch (error) {
          console.error('Failed write access log:', error)
        }

        const batch = link.batchId ? await getBatch(event, link.batchId) : null
        const batchName = batch?.name ?? ''

        const now = Math.floor(Date.now() / 1000)
        if (event.method === 'POST') {
          const body = await readBody(event).catch(() => null)
          if (body?.checkin === 'true') {
            if (link.claimedAt)
              return sendNoStoreHtml(renderCheckinPage(link, batchName, 'used'))
            const claimedLink: Link = { ...link, claimedAt: now }
            await putLink(event, claimedLink)
            return sendNoStoreHtml(renderCheckinPage(claimedLink, batchName, 'claimed-now'))
          }
        }

        return sendNoStoreHtml(renderCheckinPage(link, batchName, link.claimedAt ? 'used' : 'valid'))
      }

      // --- Hit limit + self-destruct handling (applies to redirect and text links) ---
      if (link.maxHits !== undefined && (link.hitCount || 0) >= link.maxHits) {
        setResponseStatus(event, 410)
        return sendNoStoreHtml(renderExpiredPage())
      }

      const now = Math.floor(Date.now() / 1000)
      if (link.maxHits !== undefined || link.viewExpireSeconds !== undefined) {
        const updatedLink: Link = {
          ...link,
          hitCount: (link.hitCount || 0) + 1,
          firstHitAt: link.firstHitAt || now,
        }
        const writePromise = putLink(event, updatedLink)
          .catch((err: unknown) => console.error('Failed to update hit count:', err))
        // For self-destruct links and single-use voucher codes, await the write
        // so firstHitAt / the burned hitCount are persisted before responding.
        if (link.viewExpireSeconds || link.batchMode === 'redirect')
          await writePromise
        link = updatedLink
      }

      // Text links render their content instead of redirecting.
      if (isTextLink(link)) {
        if (link.viewExpireSeconds && link.firstHitAt && now >= link.firstHitAt + link.viewExpireSeconds) {
          setResponseStatus(event, 410)
          return sendNoStoreHtml(renderExpiredPage())
        }
        event.context.link = link
        try {
          await useAccessLog(event)
        }
        catch (error) {
          console.error('Failed write access log:', error)
        }
        if (link.notifyUrl)
          queueScanNotification(event, link)
        if (link.viewExpireSeconds)
          return sendNoStoreHtml(renderTextPage(link))
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        return renderTextPage(link)
      }

      let targetUrl = link.url!
      const country = event.context.cloudflare?.request?.cf?.country
      if (country && typeof country === 'string' && link.geo?.[country.toUpperCase()]) {
        targetUrl = link.geo[country.toUpperCase()]!
      }
      targetUrl = buildTarget(targetUrl)

      const deviceRedirectUrl = getDeviceRedirectUrl(userAgent, link)
      const finalTargetUrl = deviceRedirectUrl ?? targetUrl

      // Password protection check
      if (link.password) {
        const headerPassword = getHeader(event, 'x-link-password')

        if (event.method === 'POST') {
          const body = await readBody(event)
          const submittedPassword = typeof body?.password === 'string' ? body.password : ''

          if (!await verifyLinkPassword(submittedPassword, link.password)) {
            return sendNoStoreHtml(generatePasswordHtml(slug, { hasError: true, locale: getLocale() }))
          }

          // Password correct - show unsafe warning if needed
          if (link.unsafe && body?.confirm !== 'true') {
            return sendNoStoreHtml(generateUnsafeWarningHtml(slug, finalTargetUrl, { password: submittedPassword, locale: getLocale() }))
          }
        }
        else if (headerPassword) {
          if (!await verifyLinkPassword(headerPassword, link.password)) {
            throw createError({ status: 403, statusText: 'Incorrect password' })
          }
          // Header-password path: check unsafe warning via x-link-confirm header
          if (link.unsafe && getHeader(event, 'x-link-confirm') !== 'true') {
            throw createError({ status: 403, statusText: 'Unsafe link: confirmation required (set x-link-confirm: true header)' })
          }
        }
        else {
          return sendNoStoreHtml(generatePasswordHtml(slug, { locale: getLocale() }))
        }
      }

      // Unsafe link warning (for links without password)
      if (!link.password && link.unsafe) {
        if (event.method === 'POST') {
          const body = await readBody(event)
          if (body?.confirm !== 'true') {
            return sendNoStoreHtml(generateUnsafeWarningHtml(slug, finalTargetUrl, { locale: getLocale() }))
          }
        }
        else {
          return sendNoStoreHtml(generateUnsafeWarningHtml(slug, finalTargetUrl, { locale: getLocale() }))
        }
      }

      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }

      if (link.notifyUrl)
        queueScanNotification(event, link)

      if (deviceRedirectUrl) {
        return sendRedirect(event, finalTargetUrl, +redirectStatusCode)
      }

      if (isSocialBot(userAgent) && hasOgConfig(link)) {
        const baseUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`
        const html = generateOgHtml(link, targetUrl, baseUrl)
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        return html
      }

      if (link.cloaking) {
        const baseUrl = `${getRequestProtocol(event)}://${getRequestHost(event)}`
        const html = generateCloakingHtml(link, targetUrl, baseUrl)
        setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
        setHeader(event, 'Cache-Control', 'no-store, private')
        return html
      }

      return sendRedirect(event, finalTargetUrl, +redirectStatusCode)
    }
    else {
      if (notFoundRedirect) {
        return sendRedirect(event, notFoundRedirect, 302)
      }

      throw createError({ status: 404, statusText: 'Link not found' })
    }
  }
})

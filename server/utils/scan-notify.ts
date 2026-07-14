import type { Link } from '#shared/schemas/link'
import type { H3Event } from 'h3'

const DEFAULT_COOLDOWN_MINUTES = 5
const FETCH_TIMEOUT_MS = 5000
const BOT_UA_MARKERS = ['bot', 'crawler', 'spider', 'preview']

export interface NotifyState {
  lastNotifiedAt: number
  pending: number
  total: number
}

export function notifyStateKey(slug: string): string {
  return `notify:${slug}`
}

function isBotScan(event: H3Event): boolean {
  const cf = event.context.cloudflare?.request?.cf
  if (cf?.botManagement?.verifiedBot)
    return true

  const ua = (getHeader(event, 'user-agent') || '').toLowerCase()
  return BOT_UA_MARKERS.some(marker => ua.includes(marker))
}

function uaBrowser(ua: string): string {
  if (ua.includes('Edg/'))
    return 'Edge'
  if (ua.includes('OPR/'))
    return 'Opera'
  if (ua.includes('CriOS'))
    return 'Chrome'
  if (ua.includes('FxiOS') || ua.includes('Firefox/'))
    return 'Firefox'
  if (ua.includes('Chrome/'))
    return 'Chrome'
  if (ua.includes('Safari/'))
    return 'Safari'
  if (ua.includes('curl/'))
    return 'curl'
  return ''
}

function uaOs(ua: string): string {
  if (ua.includes('iPhone') || ua.includes('iPad'))
    return 'iOS'
  if (ua.includes('Android'))
    return 'Android'
  if (ua.includes('Mac OS X'))
    return 'macOS'
  if (ua.includes('Windows'))
    return 'Windows'
  if (ua.includes('Linux'))
    return 'Linux'
  return ''
}

type NotifyChannel = 'ntfy' | 'discord' | 'generic'

export function detectChannel(notifyUrl: string): NotifyChannel {
  try {
    const { hostname, pathname } = new URL(notifyUrl)
    // ntfy.sh or self-hosted ntfy on an "ntfy." subdomain (e.g. ntfy.example.com)
    if (hostname === 'ntfy.sh' || hostname.startsWith('ntfy.'))
      return 'ntfy'
    if ((hostname === 'discord.com' || hostname === 'discordapp.com') && pathname.includes('/api/webhooks/'))
      return 'discord'
  }
  catch {
    // fall through to generic; the URL already passed schema validation
  }
  return 'generic'
}

export function formatScanMessage(slug: string, location: string, device: string, count: number, total: number): string {
  const scans = count === 1 ? '1 scan' : `${count} scans`
  let message = `🔗 ${slug} scanned`
  if (location)
    message += ` from ${location}`
  if (device)
    message += ` (${device})`
  message += ` — ${scans} since last ping · ${total} total`
  return message
}

async function postChecked(url: string, init: RequestInit): Promise<void> {
  // Workers fetch sends no User-Agent by default; some services (e.g. ntfy.sh)
  // drop UA-less datacenter requests as abuse. Identify ourselves politely.
  const response = await fetch(url, {
    ...init,
    headers: { 'User-Agent': 'sink-scan-notify/1.0', ...init.headers },
  })
  if (!response.ok)
    throw new Error(`notification endpoint responded ${response.status}`)
}

async function postNotification(event: H3Event, link: Link, count: number, total: number): Promise<void> {
  const notifyUrl = link.notifyUrl!
  const channel = detectChannel(notifyUrl)
  const cf = event.context.cloudflare?.request?.cf
  const ua = getHeader(event, 'user-agent') || ''
  const browser = uaBrowser(ua)
  const os = uaOs(ua)
  const location = [cf?.city, cf?.country].filter(Boolean).join(', ')
  const device = [browser, os].filter(Boolean).join('/')
  const message = formatScanMessage(link.slug, location, device, count, total)
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)

  if (channel === 'ntfy') {
    await postChecked(notifyUrl, {
      method: 'POST',
      body: message,
      headers: { 'X-Title': `Scan: ${link.slug}` },
      signal,
    })
    return
  }

  if (channel === 'discord') {
    await postChecked(notifyUrl, {
      method: 'POST',
      body: JSON.stringify({ content: message }),
      headers: { 'Content-Type': 'application/json' },
      signal,
    })
    return
  }

  await postChecked(notifyUrl, {
    method: 'POST',
    body: JSON.stringify({
      slug: link.slug,
      shortLink: buildShortLink(event, link.slug),
      count,
      total,
      country: cf?.country ?? null,
      city: cf?.city ?? null,
      device: os || null,
      browser: browser || null,
      referer: getHeader(event, 'referer') || null,
      timestamp: new Date().toISOString(),
    }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  })
}

async function sendScanNotification(event: H3Event, link: Link): Promise<void> {
  try {
    if (!link.notifyUrl || isBotScan(event))
      return

    const { cloudflare } = event.context
    const { KV } = cloudflare.env
    const key = notifyStateKey(link.slug)
    const raw = await KV.get(key, { type: 'json' }).catch(() => null) as Partial<NotifyState> | null
    const lastNotifiedAt = Number(raw?.lastNotifiedAt) || 0
    const pending = Number(raw?.pending) || 0
    const total = (Number(raw?.total) || 0) + 1

    const cooldownSeconds = (link.notifyCooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60
    const now = Math.floor(Date.now() / 1000)

    if (now - lastNotifiedAt >= cooldownSeconds) {
      try {
        await postNotification(event, link, pending + 1, total)
        await KV.put(key, JSON.stringify({ lastNotifiedAt: now, pending: 0, total } satisfies NotifyState))
      }
      catch (error) {
        // Failed delivery: keep the batch pending so the next scan retries it.
        console.error('[scan-notify] Delivery failed:', error)
        await KV.put(key, JSON.stringify({ lastNotifiedAt, pending: pending + 1, total } satisfies NotifyState))
      }
    }
    else {
      await KV.put(key, JSON.stringify({ lastNotifiedAt, pending: pending + 1, total } satisfies NotifyState))
    }
  }
  catch (error) {
    console.error('[scan-notify] Failed to send notification:', error)
  }
}

export function queueScanNotification(event: H3Event, link: Link): void {
  const promise = sendScanNotification(event, link)
  // Nitro assigns event.waitUntil at runtime (forwards to the Workers
  // ExecutionContext), but h3 1.x does not declare it — hence the cast.
  const waitUntil = (event as unknown as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil
  waitUntil?.(promise)
}

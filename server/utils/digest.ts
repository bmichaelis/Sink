export interface DigestData {
  visits: number
  visitors: number
  prevVisits: number
  prevVisitors: number
  topLinks: { slug: string, visits: number }[]
  topCountries: { country: string, visits: number }[]
}

interface DigestConfig {
  cfAccountId: string
  cfApiToken: string
  dataset: string
}

async function queryAE(accountId: string, apiToken: string, sql: string): Promise<Array<Record<string, string | number | null>>> {
  const res = await $fetch<{ data?: Array<Record<string, string | number | null>> }>(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}` },
      body: sql,
      retry: 1,
      retryDelay: 100,
    },
  )
  return res.data ?? []
}

export async function buildWeeklyDigest(config: DigestConfig): Promise<DigestData> {
  const { cfAccountId, cfApiToken, dataset } = config
  const q = (sql: string) => queryAE(cfAccountId, cfApiToken, sql)
  const week = `timestamp >= NOW() - INTERVAL '7' DAY`
  const prevWeek = `timestamp >= NOW() - INTERVAL '14' DAY AND timestamp < NOW() - INTERVAL '7' DAY`
  const visitorsExpr = `ROUND(COUNT(DISTINCT blob4) * SUM(_sample_interval) / COUNT())`

  const [cur, prev, links, countries] = await Promise.all([
    q(`SELECT SUM(_sample_interval) AS visits, ${visitorsExpr} AS visitors FROM ${dataset} WHERE ${week}`),
    q(`SELECT SUM(_sample_interval) AS visits, ${visitorsExpr} AS visitors FROM ${dataset} WHERE ${prevWeek}`),
    q(`SELECT blob1 AS slug, SUM(_sample_interval) AS visits FROM ${dataset} WHERE ${week} GROUP BY slug ORDER BY visits DESC LIMIT 5`),
    q(`SELECT blob6 AS country, SUM(_sample_interval) AS visits FROM ${dataset} WHERE ${week} GROUP BY country ORDER BY visits DESC LIMIT 3`),
  ])

  return {
    visits: Number(cur[0]?.visits) || 0,
    visitors: Number(cur[0]?.visitors) || 0,
    prevVisits: Number(prev[0]?.visits) || 0,
    prevVisitors: Number(prev[0]?.visitors) || 0,
    topLinks: links.filter(r => r.slug).map(r => ({ slug: String(r.slug), visits: Number(r.visits) || 0 })),
    topCountries: countries.filter(r => r.country).map(r => ({ country: String(r.country), visits: Number(r.visits) || 0 })),
  }
}

function wowArrow(cur: number, prev: number): string {
  if (prev === 0)
    return cur > 0 ? ' (new)' : ''
  const pct = Math.round((cur - prev) / prev * 100)
  if (pct > 0)
    return `  ↑${pct}%`
  if (pct < 0)
    return `  ↓${Math.abs(pct)}%`
  return '  →0%'
}

export function formatDigest(data: DigestData): string {
  if (data.visits === 0)
    return '📊 Last 7 days — no visits.'

  const lines: string[] = ['📊 Last 7 days', '']
  lines.push(`Visits: ${data.visits}${wowArrow(data.visits, data.prevVisits)}`)
  lines.push(`Visitors: ${data.visitors}${wowArrow(data.visitors, data.prevVisitors)}`)

  if (data.topLinks.length) {
    lines.push('', 'Top links')
    data.topLinks.forEach((l, i) => lines.push(` ${i + 1}. ${l.slug} — ${l.visits}`))
  }

  if (data.topCountries.length) {
    lines.push('', 'Top countries')
    lines.push(` ${data.topCountries.map(c => `${c.country} ${c.visits}`).join(' · ')}`)
  }

  return lines.join('\n')
}

export async function postDigest(notifyUrl: string, title: string, body: string): Promise<void> {
  const response = await fetch(notifyUrl, {
    method: 'POST',
    body,
    headers: {
      'User-Agent': 'sink-weekly-digest/1.0',
      'X-Title': title,
    },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok)
    throw new Error(`digest endpoint responded ${response.status}`)
}

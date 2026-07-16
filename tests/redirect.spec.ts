import { afterAll, describe, expect, it } from 'vitest'
import { deleteStoredLinks, fetch, postJson } from './utils'

type CfRequestInit = RequestInit & { cf?: { country?: string } }

const createdSlugs: string[] = []

afterAll(async () => {
  await deleteStoredLinks(createdSlugs)
})

describe('/', () => {
  it('returns 200 for homepage request', async () => {
    const response = await fetch('/')
    expect(response.status).toBe(200)
  })

  it('redirects CriOS user agent to apple URL', async () => {
    const slug = `crios-apple-${crypto.randomUUID()}`
    const apple = 'https://apps.apple.com/app/sink-test'

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com',
      slug,
      apple,
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)
    const createData = await createResponse.json() as { link: { apple?: string } }
    expect(createData.link.apple).toBe(apple)

    const response = await fetch(`/${slug}`, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/147 Version/11.1.1 Safari/605.1.15',
      },
    })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(apple)
  })

  it('redirects to geo URL when cf.country matches', async () => {
    const slug = `geo-cn-${crypto.randomUUID()}`
    const cnUrl = 'https://cn.example.com/landing'

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/default',
      slug,
      geo: { CN: cnUrl },
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const options: CfRequestInit = { redirect: 'manual', cf: { country: 'CN' } }
    const response = await fetch(`/${slug}`, options as RequestInit)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(cnUrl)
  })

  it('redirects to default URL when cf.country does not match', async () => {
    const slug = `geo-default-${crypto.randomUUID()}`
    const defaultUrl = 'https://example.com/default'

    const createResponse = await postJson('/api/link/create', {
      url: defaultUrl,
      slug,
      geo: { CN: 'https://cn.example.com/landing' },
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const options: CfRequestInit = { redirect: 'manual', cf: { country: 'US' } }
    const response = await fetch(`/${slug}`, options as RequestInit)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(defaultUrl)
  })

  it('shows geo URL in unsafe warning', async () => {
    const slug = `unsafe-geo-${crypto.randomUUID()}`
    const cnUrl = 'https://cn.example.com/unsafe'

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/default',
      slug,
      unsafe: true,
      geo: { CN: cnUrl },
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const options: CfRequestInit = { redirect: 'manual', cf: { country: 'CN' } }
    const response = await fetch(`/${slug}`, options as RequestInit)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain(cnUrl)
  })

  it('adds viewport meta to cloaked links for mobile browsers (fixes #301)', async () => {
    const slug = `cloaking-viewport-${crypto.randomUUID()}`
    const targetUrl = 'https://example.com/mobile-target'

    const createResponse = await postJson('/api/link/create', {
      url: targetUrl,
      slug,
      cloaking: true,
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">')
    expect(html).toContain(`<iframe src="${targetUrl}"`)
    expect(html).toContain('allow-top-navigation-by-user-activation')
    expect(html).toContain('allow-downloads')
    expect(html).toContain('allow-modals')
  })

  it('prefers device redirect over geo redirect', async () => {
    const slug = `device-over-geo-${crypto.randomUUID()}`
    const apple = 'https://apps.apple.com/app/sink-test-priority'

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/default',
      slug,
      apple,
      geo: { CN: 'https://cn.example.com/landing' },
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const options: CfRequestInit = {
      redirect: 'manual',
      cf: { country: 'CN' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/147 Version/11.1.1 Mobile/15E148 Safari/604.1',
      },
    }
    const response = await fetch(`/${slug}`, options as RequestInit)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe(apple)
  })

  it('redirects to scheduled URL when cutoff is in the future', async () => {
    const slug = `schedule-future-${crypto.randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/photos',
      slug,
      schedule: [{ until: now + 86400, url: 'https://example.com/rsvp' }],
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/rsvp')
  })

  it('redirects to base URL when the only schedule cutoff is in the past', async () => {
    const slug = `schedule-past-${crypto.randomUUID()}`
    const now = Math.floor(Date.now() / 1000)

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/photos',
      slug,
      schedule: [{ until: now - 86400, url: 'https://example.com/rsvp' }],
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/photos')
  })

  it('redirects to base URL when there is no schedule', async () => {
    const slug = `schedule-none-${crypto.randomUUID()}`

    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/photos',
      slug,
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/photos')
  })

  it('serves only the variant URLs for a split link, never the base', async () => {
    const slug = `ab-serve-${crypto.randomUUID()}`
    const a = 'https://example.com/variant-a'
    const b = 'https://example.com/variant-b'
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/base',
      slug,
      variants: [{ url: a, weight: 1 }, { url: b, weight: 1 }],
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const response = await fetch(`/${slug}`, { redirect: 'manual' })
      expect(response.status).toBe(302)
      const location = response.headers.get('Location')
      // The base URL must never be served while variants are set.
      expect(location === a || location === b).toBe(true)
      if (location)
        seen.add(location)
    }
    // Over 40 even-weighted draws, both variants should appear (flake
    // probability 2 * 0.5^40, astronomically small).
    expect(seen.has(a) && seen.has(b)).toBe(true)
  })

  it('redirects a non-variant link exactly as before', async () => {
    const slug = `ab-none-${crypto.randomUUID()}`
    const createResponse = await postJson('/api/link/create', {
      url: 'https://example.com/plain',
      slug,
    })
    expect(createResponse.status).toBe(201)
    createdSlugs.push(slug)

    const response = await fetch(`/${slug}`, { redirect: 'manual' })
    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('https://example.com/plain')
  })

  it('rejects variants combined with geo routing', async () => {
    const response = await postJson('/api/link/create', {
      url: 'https://example.com',
      slug: `ab-reject-geo-${crypto.randomUUID()}`,
      variants: [{ url: 'https://example.com/a', weight: 1 }, { url: 'https://example.com/b', weight: 1 }],
      geo: { DE: 'https://example.com/de' },
    })
    expect(response.status).toBe(400)
  })
})

describe.sequential('password protected redirect', () => {
  it('shows password page without password, rejects wrong password, and redirects with correct password', async () => {
    const password = 'redirect-secret123'
    const payload = {
      url: 'https://example.com/redirect-target',
      slug: `redirect-password-${crypto.randomUUID()}`,
      password,
    }

    const createResponse = await postJson('/api/link/create', payload)
    expect(createResponse.status).toBe(201)
    createdSlugs.push(payload.slug)

    const passwordPageResponse = await fetch(`/${payload.slug}`, { redirect: 'manual' })
    expect(passwordPageResponse.status).toBe(200)
    expect(await passwordPageResponse.text()).toContain('Password Required')

    const wrongPasswordResponse = await fetch(`/${payload.slug}`, {
      redirect: 'manual',
      headers: { 'x-link-password': 'wrong-password' },
    })
    expect(wrongPasswordResponse.status).toBe(403)

    const correctPasswordResponse = await fetch(`/${payload.slug}`, {
      redirect: 'manual',
      headers: { 'x-link-password': password },
    })
    expect(correctPasswordResponse.status).toBeGreaterThanOrEqual(300)
    expect(correctPasswordResponse.status).toBeLessThan(400)
    expect(correctPasswordResponse.headers.get('location')).toBe(payload.url)
  })
})

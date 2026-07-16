import { isValidTimezone } from '#shared/utils/timezone'
import { customAlphabet } from 'nanoid'
import { z } from 'zod'
import { LINK_PASSWORD_MASK_PREFIX } from '../utils/link-password'

const { slugRegex } = useAppConfig()

const slugDefaultLength = +useRuntimeConfig().public.slugDefaultLength

export const nanoid = (length: number = slugDefaultLength) => customAlphabet('23456789abcdefghjkmnpqrstuvwxyz', length)

const GeoSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, url]) => [key.trim().toUpperCase(), url]),
  )
}, z.record(z.string().trim().regex(/^[A-Z]{2}$/), z.string().trim().url().max(2048)))

export const LinkPasswordSchema = z.string().trim().min(1).max(128).refine(
  password => !password.startsWith(LINK_PASSWORD_MASK_PREFIX),
  'masked password cannot be submitted',
)

export const EditLinkPasswordSchema = z.string().trim().max(128).refine(
  password => !password.startsWith(LINK_PASSWORD_MASK_PREFIX),
  'masked password cannot be submitted',
).optional()

export const BatchModeEnum = z.enum(['redirect', 'checkin'])

export const LinkTypeEnum = z.enum(['redirect', 'text'])

export const LinkSchema = z.object({
  id: z.string().trim().max(26).default(nanoid(10)),
  type: LinkTypeEnum.default('redirect'),
  url: z.string().trim().url().max(2048).optional(),
  content: z.string().trim().max(50000).optional(),
  slug: z.string().trim().max(2048).regex(new RegExp(slugRegex)).default(nanoid()),
  comment: z.string().trim().max(2048).optional(),
  createdAt: z.number().int().safe().default(() => Math.floor(Date.now() / 1000)),
  updatedAt: z.number().int().safe().default(() => Math.floor(Date.now() / 1000)),
  expiration: z.number().int().safe().refine(expiration => expiration > Math.floor(Date.now() / 1000), {
    message: 'expiration must be greater than current time',
    path: ['expiration'],
  }).optional(),
  title: z.string().trim().max(256).optional(),
  description: z.string().trim().max(2048).optional(),
  image: z.string().trim().max(128).optional(),
  apple: z.string().trim().url().max(2048).optional(),
  google: z.string().trim().url().max(2048).optional(),
  cloaking: z.boolean().optional(),
  redirectWithQuery: z.boolean().optional(),
  password: LinkPasswordSchema.optional(),
  unsafe: z.boolean().optional(),
  geo: GeoSchema.optional(),
  // Time-based destinations: each entry supplies the URL *until* its `until`
  // instant. Once every entry has passed, `url` (the final destination) is used.
  schedule: z.array(z.object({
    until: z.number().int().safe(),
    url: z.string().trim().url().max(2048),
  })).max(10).optional(),
  // Access fences. Both are gates: they decide whether the link works at all,
  // not where it points. An allowlist means "only these" — an unknown country
  // is therefore blocked, not admitted.
  allowedCountries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(50).optional(),
  // Daily window, start-inclusive and end-exclusive. start > end wraps
  // midnight; start === end means always active.
  activeHours: z.object({
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    tz: z.string().trim().min(1).max(64).refine(isValidTimezone, 'Invalid IANA timezone'),
  }).optional(),
  maxHits: z.number().int().positive().optional(),
  hitCount: z.number().int().nonnegative().default(0),
  viewExpireSeconds: z.number().int().positive().optional(),
  firstHitAt: z.number().int().safe().optional(),
  notifyUrl: z.string().trim().url().max(2048).optional(),
  notifyCooldownMinutes: z.number().int().nonnegative().max(1440).optional(),
  batchId: z.string().trim().max(26).optional(),
  batchSeq: z.number().int().positive().optional(),
  batchMode: BatchModeEnum.optional(),
  claimedAt: z.number().int().safe().optional(),
})

export type Link = z.infer<typeof LinkSchema>

// Validate that redirect links have a URL and text links have content.
// Applied at the API boundary (create/edit/upsert) rather than on LinkSchema
// itself, so LinkSchema stays a plain ZodObject and `.shape`/`.extend` keep working.
export function refineLinkContent(
  data: { type?: 'redirect' | 'text', url?: string, content?: string, batchMode?: 'redirect' | 'checkin' },
  ctx: z.RefinementCtx,
): void {
  // Check-in batch codes have no destination URL by design.
  if (data.batchMode === 'checkin')
    return
  const type = data.type ?? 'redirect'
  if (type === 'redirect' && !data.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'URL is required for redirect links', path: ['url'] })
  }
  if (type === 'text' && !data.content) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Content is required for text links', path: ['content'] })
  }
}

export interface ExportData {
  version: string
  exportedAt: string
  count: number
  links: Link[]
  cursor?: string
  list_complete: boolean
}

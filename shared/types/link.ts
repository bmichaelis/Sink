import type { Link } from '#shared/schemas/link'
import type { DateValue } from '@internationalized/date'
import type { AnyFieldApi } from '@tanstack/vue-form'

export type { Link }

export type LinkUpdateType = 'create' | 'edit' | 'delete'

export interface LinkSearchItem {
  slug: string
  url: string
  comment?: string
}

// Form data derived from Link, with DateValue for expiration and required strings for optional fields.
// hitCount/firstHitAt are internal counters managed server-side, so they are excluded from the form.
// Optional number fields are typed explicitly so `undefined` survives exactOptionalPropertyTypes.
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'schedule' | 'variants' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes' | 'batchId' | 'batchSeq' | 'batchMode' | 'claimedAt'> & {
  expiration: DateValue | undefined
  geo: { country: string, url: string }[]
  // A row being typed has a URL but not yet a time, so `until` is nullable here
  // even though the schema requires it.
  schedule: { until: number | undefined, url: string }[]
  // Always an array in the form; a row being typed may have a URL but no weight
  // yet, so weight is nullable here even though the schema requires it.
  variants: { url: string, weight: number | undefined }[]
  maxHits: number | undefined
  viewExpireSeconds: number | undefined
  notifyCooldownMinutes: number | undefined
}

export type LinkFormData = {
  [K in keyof LinkFormFields]-?: LinkFormFields[K] extends string | undefined ? string : LinkFormFields[K]
}

export type { AnyFieldApi }

export interface LinkListResponse {
  links: Link[]
  cursor: string
  list_complete: boolean
}

export type LinkSortBy = 'newest' | 'oldest' | 'az' | 'za'

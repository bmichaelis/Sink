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
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'schedule' | 'allowedCountries' | 'activeHours' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes' | 'batchId' | 'batchSeq' | 'batchMode' | 'claimedAt'> & {
  expiration: DateValue | undefined
  geo: { country: string, url: string }[]
  // A row being typed has a URL but not yet a time, so `until` is nullable here
  // even though the schema requires it.
  schedule: { until: number | undefined, url: string }[]
  // Always an array in the form; empty means "no restriction".
  allowedCountries: string[]
  // Always an object in the form. Empty strings mean "unset" — a half-filled
  // window (start typed, end not) must not fail schema validation mid-edit.
  activeHours: { start: string, end: string, tz: string }
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

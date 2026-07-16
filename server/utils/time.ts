import type { H3Event } from 'h3'
import { isValidTimezone } from '#shared/utils/timezone'

export function getExpiration(event: H3Event, expiration: number | undefined) {
  const { previewMode } = useRuntimeConfig(event).public
  if (previewMode) {
    const { previewTTL } = useAppConfig()
    const previewExpiration = Math.floor(Date.now() / 1000) + previewTTL
    if (!expiration || expiration > previewExpiration)
      expiration = Math.floor(Date.now() / 1000) + previewTTL
  }

  return expiration
}

export function getSafeTimezone(tz: string): string {
  return isValidTimezone(tz) ? tz : 'Etc/UTC'
}

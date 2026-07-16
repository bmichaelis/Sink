// Structural rather than importing `Link`, mirroring server/utils/schedule.ts:
// it keeps this module trivially unit-testable, and TypeScript still checks a
// real Link against it at the call site.
interface FenceableLink {
  allowedCountries?: string[]
  activeHours?: { start: string, end: string, tz: string }
}

export type FenceReason = 'geo' | 'hours'

function hhmmToMinutes(value: string): number {
  const [h, m] = value.split(':')
  return Number(h) * 60 + Number(m)
}

// Minutes since midnight in `tz` for the given instant. `hourCycle: 'h23'`
// rather than `hour12: false`: the latter has historically reported midnight
// as "24" under some ICU builds, which would invert every overnight window.
function minutesInZone(nowMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(nowMs))
  const hour = Number(parts.find(p => p.type === 'hour')?.value)
  const minute = Number(parts.find(p => p.type === 'minute')?.value)
  return hour * 60 + minute
}

// Does this visitor get through the link's access fences at all? Returns the
// reason they were turned away, or null if they pass. Runs in the redirect hot
// path and must never throw.
export function evaluateFence(link: FenceableLink, country: string | undefined, nowMs: number): FenceReason | null {
  const allowed = link.allowedCountries
  if (allowed?.length) {
    // An allowlist means "only these", so a country we cannot determine is
    // turned away rather than admitted.
    if (!country || !allowed.includes(country.toUpperCase()))
      return 'geo'
  }

  const hours = link.activeHours
  if (hours) {
    const start = hhmmToMinutes(hours.start)
    const end = hhmmToMinutes(hours.end)
    // A zero-width window is meaningless; treat it as always active so a typo
    // cannot silently kill a link. A malformed "HH:MM" (unreachable via the
    // Zod schema, but a corrupt stored value must never be trusted) yields
    // NaN, which fails every comparison below and would otherwise block the
    // link forever with no diagnostic. Treat that the same as start === end:
    // ignore the window rather than silently bricking the link.
    if (start !== end && Number.isFinite(start) && Number.isFinite(end)) {
      let current: number
      try {
        current = minutesInZone(nowMs, hours.tz)
      }
      catch {
        // Validation rejects bad zones at the API boundary; if one somehow
        // reaches here, fall back to UTC rather than throwing mid-redirect.
        current = minutesInZone(nowMs, 'Etc/UTC')
      }
      const active = start < end
        ? current >= start && current < end
        : current >= start || current < end // wraps midnight
      if (!active)
        return 'hours'
    }
  }

  return null
}

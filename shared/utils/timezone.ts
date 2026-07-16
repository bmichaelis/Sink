// Lives in shared/ because both the Zod schema (shared/) and the stats
// endpoints (server/) validate timezones, and shared/ cannot import server/.
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  }
  catch {
    return false
  }
}

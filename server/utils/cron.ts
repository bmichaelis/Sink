// Determine whether the currently-firing Cloudflare scheduled event corresponds
// to a given cron. Prefers the controller's `cron` field when the runtime
// exposes it; otherwise falls back to matching the current UTC hour (and day),
// which is unambiguous here because our two crons run at different hours.
export function cronFired(event: unknown, cronExpr: string, utcHour: number, utcDay?: number): boolean {
  const cron = (event as { controller?: { cron?: unknown } })?.controller?.cron
  if (typeof cron === 'string')
    return cron === cronExpr
  const now = new Date()
  return now.getUTCHours() === utcHour && (utcDay === undefined || now.getUTCDay() === utcDay)
}

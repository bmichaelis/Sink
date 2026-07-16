import { describe, expect, it } from 'vitest'
import { evaluateFence } from '../../server/utils/fencing'

// A fixed instant: 2026-07-15T18:30:00Z == 12:30 in America/Denver (UTC-6 in July).
const NOON_MST = Date.UTC(2026, 6, 15, 18, 30)

describe('evaluateFence', () => {
  it('returns null when the link has no fence', () => {
    expect(evaluateFence({}, 'US', NOON_MST)).toBe(null)
  })

  it('returns null when the country is allowed', () => {
    expect(evaluateFence({ allowedCountries: ['US', 'CA'] }, 'US', NOON_MST)).toBe(null)
  })

  it('matches the country case-insensitively', () => {
    expect(evaluateFence({ allowedCountries: ['US'] }, 'us', NOON_MST)).toBe(null)
  })

  it('blocks a country outside the allowlist', () => {
    expect(evaluateFence({ allowedCountries: ['US'] }, 'DE', NOON_MST)).toBe('geo')
  })

  it('blocks an unknown country when an allowlist is set (fail-closed)', () => {
    expect(evaluateFence({ allowedCountries: ['US'] }, undefined, NOON_MST)).toBe('geo')
  })

  it('ignores an empty allowlist', () => {
    expect(evaluateFence({ allowedCountries: [] }, undefined, NOON_MST)).toBe(null)
  })

  it('returns null inside the active window', () => {
    expect(evaluateFence({ activeHours: { start: '09:00', end: '17:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('blocks outside the active window', () => {
    expect(evaluateFence({ activeHours: { start: '13:00', end: '17:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('treats start as inclusive', () => {
    // 12:30 MST exactly at start
    expect(evaluateFence({ activeHours: { start: '12:30', end: '17:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('treats end as exclusive', () => {
    // 12:30 MST exactly at end
    expect(evaluateFence({ activeHours: { start: '09:00', end: '12:30', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('handles an overnight window that is currently closed', () => {
    // 22:00 -> 06:00 does not include 12:30
    expect(evaluateFence({ activeHours: { start: '22:00', end: '06:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('handles an overnight window that is currently open', () => {
    // 06:00 -> 01:00 wraps midnight and includes 12:30
    expect(evaluateFence({ activeHours: { start: '06:00', end: '01:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('treats start === end as always active', () => {
    expect(evaluateFence({ activeHours: { start: '09:00', end: '09:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe(null)
  })

  it('respects the timezone (same instant, different zone)', () => {
    // 18:30 UTC is inside 17:00-19:00 UTC but outside it in Denver (12:30)
    expect(evaluateFence({ activeHours: { start: '17:00', end: '19:00', tz: 'Etc/UTC' } }, 'US', NOON_MST)).toBe(null)
    expect(evaluateFence({ activeHours: { start: '17:00', end: '19:00', tz: 'America/Denver' } }, 'US', NOON_MST)).toBe('hours')
  })

  it('reads midnight as 00:00, not 24:00', () => {
    // 2026-01-01T07:00Z == 00:00 America/Denver (UTC-7 in January).
    const midnightMST = Date.UTC(2026, 0, 1, 7, 0)
    // A 00:00-08:00 window must include midnight itself.
    expect(evaluateFence({ activeHours: { start: '00:00', end: '08:00', tz: 'America/Denver' } }, 'US', midnightMST)).toBe(null)
  })

  it('checks geo before hours when both would block', () => {
    expect(evaluateFence(
      { allowedCountries: ['US'], activeHours: { start: '13:00', end: '17:00', tz: 'America/Denver' } },
      'DE',
      NOON_MST,
    )).toBe('geo')
  })

  it('does not throw on an invalid timezone', () => {
    expect(() => evaluateFence({ activeHours: { start: '09:00', end: '17:00', tz: 'Mars/Olympus' } }, 'US', NOON_MST)).not.toThrow()
  })

  it('ignores a malformed window rather than blocking forever', () => {
    // Unreachable via the schema, but a corrupt value must fail open, matching
    // the start === end rule — never silently brick a link.
    expect(evaluateFence({ activeHours: { start: 'aa:bb', end: '17:00', tz: 'Etc/UTC' } }, 'US', NOON_MST)).toBe(null)
    expect(evaluateFence({ activeHours: { start: '', end: '', tz: 'Etc/UTC' } }, 'US', NOON_MST)).toBe(null)
    expect(evaluateFence({ activeHours: { start: '9', end: '17:00', tz: 'Etc/UTC' } }, 'US', NOON_MST)).toBe(null)
  })
})

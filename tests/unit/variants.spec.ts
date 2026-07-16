import { describe, expect, it } from 'vitest'
import { selectVariant } from '../../server/utils/variants'

const AB = [{ url: 'https://a', weight: 3 }, { url: 'https://b', weight: 1 }]

describe('selectVariant', () => {
  it('returns null for an empty list', () => {
    expect(selectVariant([], 0.5)).toBe(null)
  })

  it('returns the sole element for a one-item list', () => {
    expect(selectVariant([{ url: 'https://only', weight: 1 }], 0.99)).toEqual({ url: 'https://only', index: 0 })
  })

  it('selects the first variant at rand = 0', () => {
    expect(selectVariant(AB, 0)).toEqual({ url: 'https://a', index: 0 })
  })

  it('selects the first variant just below its cumulative boundary', () => {
    // weights [3,1], total 4; index 0 covers [0, 0.75)
    expect(selectVariant(AB, 0.7499)).toEqual({ url: 'https://a', index: 0 })
  })

  it('selects the second variant at its boundary', () => {
    // index 1 covers [0.75, 1)
    expect(selectVariant(AB, 0.75)).toEqual({ url: 'https://b', index: 1 })
  })

  it('selects the last variant just below rand = 1', () => {
    expect(selectVariant(AB, 0.9999)).toEqual({ url: 'https://b', index: 1 })
  })

  it('splits evenly for equal weights', () => {
    const even = [{ url: 'https://x', weight: 1 }, { url: 'https://y', weight: 1 }]
    expect(selectVariant(even, 0.49)).toEqual({ url: 'https://x', index: 0 })
    expect(selectVariant(even, 0.5)).toEqual({ url: 'https://y', index: 1 })
  })

  it('honors the weighted distribution over a deterministic sweep', () => {
    // 1000 evenly spaced rand values; index 0 (weight 3/4) should win ~750.
    let zero = 0
    for (let i = 0; i < 1000; i++) {
      if (selectVariant(AB, i / 1000)!.index === 0)
        zero++
    }
    expect(zero).toBe(750)
  })

  it('never returns an out-of-range index for rand at the very top', () => {
    // Guard against floating-point overrun landing past the last bucket.
    const result = selectVariant(AB, 0.999999999999)
    expect(result).not.toBe(null)
    expect(result!.index).toBeLessThan(AB.length)
  })
})

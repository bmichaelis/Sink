// Structural rather than importing `Link`, mirroring server/utils/schedule.ts
// and fencing.ts: keeps this trivially unit-testable, and TypeScript still
// checks a real Link against it at the call site.
interface Variant {
  url: string
  weight: number
}

// Weighted pick over cumulative weights. `rand` is a caller-supplied [0, 1)
// value (injected, not Math.random() here) so the distribution is
// deterministically testable. Returns null for an empty/unusable list, letting
// the caller fall back to link.url. Runs in the redirect hot path; never throws.
export function selectVariant(variants: Variant[], rand: number): { url: string, index: number } | null {
  if (!variants.length)
    return null
  const total = variants.reduce((sum, v) => sum + v.weight, 0)
  if (total <= 0)
    return null
  const threshold = rand * total
  let cumulative = 0
  for (let i = 0; i < variants.length; i++) {
    cumulative += variants[i]!.weight
    if (threshold < cumulative)
      return { url: variants[i]!.url, index: i }
  }
  // Floating-point overrun (rand extremely close to 1): fall back to the last.
  const last = variants.length - 1
  return { url: variants[last]!.url, index: last }
}

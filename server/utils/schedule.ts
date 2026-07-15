// Structural, rather than importing `Link` from '#shared/schemas/link': it keeps
// this module importable by a plain tsx runner (no Nuxt alias resolution), and
// TypeScript still checks a real Link against it at the call site.
interface ScheduledLink {
  url?: string
  schedule?: { until: number, url: string }[]
}

// Which destination does this link point at right now? Each entry supplies the
// URL *until* its `until` instant, so the earliest cutoff still in the future
// wins. Once every cutoff has passed, `link.url` is the final destination.
//
// Total by construction: any missing, empty, or exhausted schedule degrades to
// `link.url`. This runs in the redirect hot path and must never throw.
export function resolveScheduledUrl(link: ScheduledLink, nowUnix: number): string {
  const schedule = link.schedule
  if (!schedule?.length)
    return link.url ?? ''

  // Copy before sorting — the caller's link object is shared with the rest of
  // the request (analytics, notifications) and must not be reordered.
  const current = [...schedule]
    .sort((a, b) => a.until - b.until)
    .find(entry => entry.until > nowUnix)

  return current?.url ?? link.url ?? ''
}

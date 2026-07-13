# Scan Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a notification (ntfy phone push, Discord webhook, or generic JSON webhook) when someone scans/visits a link, with per-link opt-in and a cooldown that batches scan counts.

**Architecture:** A new `server/utils/scan-notify.ts` util holds all notification logic (bot check, cooldown state in a `notify:<slug>` KV key, payload formatting, outbound POST). The redirect middleware calls it fire-and-forget via nitro's `event.waitUntil` at the two existing `useAccessLog` call sites. Two new optional schema fields (`notifyUrl`, `notifyCooldownMinutes`) flow through the existing editor patterns.

**Tech Stack:** Nuxt 4 (layers), Nitro on Cloudflare Workers (`cloudflare-module` preset), Workers KV, Zod, @tanstack/vue-form, vue-i18n (10 locales).

**Spec:** `docs/superpowers/specs/2026-07-13-scan-notifications-design.md`

## Global Constraints

- Package manager is **pnpm**. Node 22+.
- **NEVER build or run dev with `CI=true`** — it silently switches the Nitro preset from `cloudflare-module` to node-server and breaks the Worker build. (`CI=true pnpm install` is fine; `CI=true pnpm types:check` is fine.)
- Dev server: `NUXT_SITE_TOKEN=devtoken12345 pnpm dev` → `http://localhost:7465`, real local Cloudflare bindings. Start it in the background; first boot takes ~60s.
- All documentation and comments in English. 2-space indent, single quotes, no semicolons (`@antfu/eslint-config`; pre-commit runs `eslint --fix` via lint-staged).
- Never edit `app/components/ui/**` (generated shadcn-vue components).
- Conventional Commits. Every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- The repo's vitest workers-pool suite does not initialize in this environment (upstream dep resolution failure). Verification is: `pnpm types:check`, `pnpm lint`, and **executable end-to-end scripts against the dev server** (write the script first, watch it fail, implement, watch it pass).
- Scratch scripts go in `/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/notify-tests/` (referred to as `$SCRATCH` below). `export SCRATCH=/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/notify-tests` at the top of every shell session and `mkdir -p "$SCRATCH"`.
- Known pre-existing failures to IGNORE (present on clean master): `types:check` errors in `layers/dashboard/app/components/dashboard/links/Search.vue` (`Cannot find module 'pinia'` and cascading `link.item` unknowns). Any OTHER type error is yours.

---

### Task 1: Schema fields + form-data types + editable fields + Form.vue wiring

The schema fields and `Form.vue` wiring must land together: `Form.vue`'s
`defaultValues` object is checked with `satisfies LinkFormData`, and
`LinkFormData` is a mapped type over `Link` that makes every key required —
adding fields to the schema without adding them to `defaultValues` breaks
`types:check`.

**Files:**

- Modify: `shared/schemas/link.ts` (~line 50, end of the `LinkSchema` object)
- Modify: `shared/types/link.ts` (~lines 16-23, `LinkFormFields` / `LinkFormData`)
- Modify: `server/utils/link-processing.ts` (~lines 4-19, `editableOptionalLinkFields`)
- Modify: `layers/dashboard/app/components/dashboard/links/editor/Form.vue` (defaultValues ~line 41, onSubmit linkData ~line 69)

**Interfaces:**

- Consumes: existing `LinkSchema`, `LinkFormData`, `editableOptionalLinkFields` patterns (the `maxHits`/`viewExpireSeconds` fields added by the previous feature are the exact template).
- Produces: `Link.notifyUrl?: string`, `Link.notifyCooldownMinutes?: number` — every later task relies on these names. Form submits `notifyUrl` (empty string → `undefined`) and `notifyCooldownMinutes` (`number | undefined`, `0` preserved).

- [ ] **Step 1: Add the two fields to `LinkSchema`**

In `shared/schemas/link.ts`, the `LinkSchema` object currently ends:

```ts
  maxHits: z.number().int().positive().optional(),
  hitCount: z.number().int().nonnegative().default(0),
  viewExpireSeconds: z.number().int().positive().optional(),
  firstHitAt: z.number().int().safe().optional(),
})
```

Change to:

```ts
  maxHits: z.number().int().positive().optional(),
  hitCount: z.number().int().nonnegative().default(0),
  viewExpireSeconds: z.number().int().positive().optional(),
  firstHitAt: z.number().int().safe().optional(),
  notifyUrl: z.string().trim().url().max(2048).optional(),
  notifyCooldownMinutes: z.number().int().nonnegative().max(1440).optional(),
})
```

- [ ] **Step 2: Update `LinkFormData`**

In `shared/types/link.ts`, replace:

```ts
// Form data derived from Link, with DateValue for expiration and required strings for optional fields.
// hitCount/firstHitAt are internal counters managed server-side, so they are excluded from the form.
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds'> & {
  expiration: DateValue | undefined
  geo: { country: string, url: string }[]
  maxHits: number | undefined
  viewExpireSeconds: number | undefined
}
```

with:

```ts
// Form data derived from Link, with DateValue for expiration and required strings for optional fields.
// hitCount/firstHitAt are internal counters managed server-side, so they are excluded from the form.
// Optional number fields are typed explicitly so `undefined` survives exactOptionalPropertyTypes.
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes'> & {
  expiration: DateValue | undefined
  geo: { country: string, url: string }[]
  maxHits: number | undefined
  viewExpireSeconds: number | undefined
  notifyCooldownMinutes: number | undefined
}
```

(`notifyUrl` is a plain optional string, so the existing mapped type turns it
into a required `string` automatically — no explicit entry needed.)

- [ ] **Step 3: Make the fields editable**

In `server/utils/link-processing.ts`, extend `editableOptionalLinkFields`:

```ts
const editableOptionalLinkFields = [
  'comment',
  'title',
  'description',
  'image',
  'apple',
  'google',
  'cloaking',
  'redirectWithQuery',
  'expiration',
  'unsafe',
  'geo',
  'content',
  'maxHits',
  'viewExpireSeconds',
  'notifyUrl',
  'notifyCooldownMinutes',
] as const satisfies readonly (keyof Link)[]
```

- [ ] **Step 4: Wire `Form.vue` defaults and submit**

In `layers/dashboard/app/components/dashboard/links/editor/Form.vue`, inside
`defaultValues` (after the `viewExpireSeconds` line):

```ts
    maxHits: props.link.maxHits ?? undefined,
    viewExpireSeconds: props.link.viewExpireSeconds ?? undefined,
    notifyUrl: props.link.notifyUrl ?? '',
    notifyCooldownMinutes: props.link.notifyCooldownMinutes ?? undefined,
```

Inside `onSubmit`'s `linkData` object (after the `viewExpireSeconds` line):

```ts
        maxHits: value.maxHits || undefined,
        viewExpireSeconds: isText ? (value.viewExpireSeconds || undefined) : undefined,
        notifyUrl: value.notifyUrl || undefined,
        notifyCooldownMinutes: value.notifyUrl ? value.notifyCooldownMinutes : undefined,
```

Note `notifyCooldownMinutes` uses a ternary, NOT `||` — `0` is meaningful
(notify on every scan) and `0 || undefined` would drop it. The field-level
input (Task 5) converts empty string to `undefined`, so the value here is
already `number | undefined`.

- [ ] **Step 5: Run type check**

Run: `CI=true pnpm types:check 2>&1 | grep -vE "Search.vue" | grep "error TS" ; echo "exit: $?"`
Expected: no output lines before `exit: 1` (grep finding nothing exits 1 — that means only the known pre-existing Search.vue errors remain).

- [ ] **Step 6: Verify persistence via the dev API**

Start the dev server if not running (background):
`NUXT_SITE_TOKEN=devtoken12345 pnpm dev` (wait for `http://localhost:7465/` to return 200).

```bash
AUTH="Authorization: Bearer devtoken12345"
# valid create with both fields
curl -s -X POST http://localhost:7465/api/link/create -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","slug":"t1-notify","notifyUrl":"https://ntfy.sh/demo-topic","notifyCooldownMinutes":0}' | head -c 400
# invalid notifyUrl must 400
curl -s -o /dev/null -w "invalid-url -> %{http_code}\n" -X POST http://localhost:7465/api/link/create -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","slug":"t1-bad","notifyUrl":"not-a-url"}'
# cleanup
curl -s -X POST http://localhost:7465/api/link/delete -H "$AUTH" -H "Content-Type: application/json" -d '{"slug":"t1-notify"}' -o /dev/null
```

Expected: create response echoes `"notifyUrl":"https://ntfy.sh/demo-topic"` and `"notifyCooldownMinutes":0`; invalid URL returns `400`.

- [ ] **Step 7: Commit**

```bash
git add shared/schemas/link.ts shared/types/link.ts server/utils/link-processing.ts layers/dashboard/app/components/dashboard/links/editor/Form.vue
git commit -m "feat: add notifyUrl and notifyCooldownMinutes link fields

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 2: scan-notify util + middleware hooks (end-to-end: ntfy push)

**Files:**

- Create: `server/utils/scan-notify.ts`
- Modify: `server/middleware/1.redirect.ts` (two insertion points, after each `useAccessLog` try/catch)
- Test script: `$SCRATCH/e2e-notify.sh`

**Interfaces:**

- Consumes: `Link` type (`#shared/schemas/link`, auto-imported in server code), `link.notifyUrl` / `link.notifyCooldownMinutes` from Task 1, `buildShortLink(event, slug)` (existing auto-imported server util).
- Produces:
  - `queueScanNotification(event: H3Event, link: Link): void` — the ONLY function middleware calls; fire-and-forget, never throws.
  - `notifyStateKey(slug: string): string` — returns `notify:<slug>`; Task 3 uses it in `deleteLink`.
  - KV state shape `NotifyState = { lastNotifiedAt: number, pending: number, total: number }`.

- [ ] **Step 1: Write the failing e2e test script**

Write `$SCRATCH/e2e-notify.sh`:

```bash
#!/usr/bin/env bash
# End-to-end: scanning a link with notifyUrl delivers an ntfy push with correct counts.
set -u
BASE=http://localhost:7465
AUTH="Authorization: Bearer devtoken12345"
TOPIC="sink-e2e-$RANDOM$RANDOM"
SLUG="e2e-notify-$RANDOM"
FAIL=0

check() { # $1 label, $2 expected, $3 actual
  if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected '$2', got '$3')"; FAIL=1; fi
}

msgs() { # print ntfy messages for the topic, one per line
  curl -s "https://ntfy.sh/$TOPIC/json?poll=1" | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    if d.get("event") == "message":
        print(d.get("message", ""))'
}

echo "topic: $TOPIC  slug: $SLUG"

# create link, cooldown 0 = notify every scan
curl -s -X POST "$BASE/api/link/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://example.com/\",\"slug\":\"$SLUG\",\"notifyUrl\":\"https://ntfy.sh/$TOPIC\",\"notifyCooldownMinutes\":0}" -o /dev/null

# scan once (human UA)
curl -s -o /dev/null -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" "$BASE/$SLUG"
sleep 3
M1=$(msgs | tail -1)
check "first scan pushed" "yes" "$(echo "$M1" | grep -q "$SLUG" && echo yes || echo no)"
check "first scan count" "yes" "$(echo "$M1" | grep -q "1 scan since last ping · 1 total" && echo yes || echo no)"

# bot scan must NOT push and must NOT count
curl -s -o /dev/null -H "User-Agent: Mozilla/5.0 (compatible; Googlebot/2.1)" "$BASE/$SLUG"
sleep 3
N_AFTER_BOT=$(msgs | wc -l | tr -d ' ')
check "bot scan silent" "1" "$N_AFTER_BOT"

# second human scan on cooldown-0 link: pushes again, total=2 (bot didn't count)
curl -s -o /dev/null -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" "$BASE/$SLUG"
sleep 3
M3=$(msgs | tail -1)
check "second scan pushed with total 2" "yes" "$(echo "$M3" | grep -q "1 scan since last ping · 2 total" && echo yes || echo no)"

# cooldown batching: new link with 5-min cooldown
SLUG2="e2e-cool-$RANDOM"
TOPIC2="sink-e2e-$RANDOM$RANDOM"
curl -s -X POST "$BASE/api/link/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://example.com/\",\"slug\":\"$SLUG2\",\"notifyUrl\":\"https://ntfy.sh/$TOPIC2\",\"notifyCooldownMinutes\":5}" -o /dev/null
for i in 1 2 3; do
  curl -s -o /dev/null -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" "$BASE/$SLUG2"
  sleep 1
done
sleep 3
TOPIC=$TOPIC2
N2=$(msgs | wc -l | tr -d ' ')
check "cooldown: only first of 3 rapid scans pushes" "1" "$N2"

# cleanup
curl -s -X POST "$BASE/api/link/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"slug\":\"$SLUG\"}" -o /dev/null
curl -s -X POST "$BASE/api/link/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"slug\":\"$SLUG2\"}" -o /dev/null

[ "$FAIL" = "0" ] && echo "ALL PASS" || echo "FAILURES"
exit $FAIL
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash $SCRATCH/e2e-notify.sh` (dev server must be running).
Expected: `FAIL: first scan pushed` (no notification code exists yet), exit 1.

- [ ] **Step 3: Create `server/utils/scan-notify.ts`**

Complete file:

```ts
import type { Link } from '#shared/schemas/link'
import type { H3Event } from 'h3'

const DEFAULT_COOLDOWN_MINUTES = 5
const FETCH_TIMEOUT_MS = 5000
const BOT_UA_MARKERS = ['bot', 'crawler', 'spider', 'preview']

export interface NotifyState {
  lastNotifiedAt: number
  pending: number
  total: number
}

export function notifyStateKey(slug: string): string {
  return `notify:${slug}`
}

function isBotScan(event: H3Event): boolean {
  const cf = event.context.cloudflare?.request?.cf
  if (cf?.botManagement?.verifiedBot)
    return true

  const ua = (getHeader(event, 'user-agent') || '').toLowerCase()
  return BOT_UA_MARKERS.some(marker => ua.includes(marker))
}

function uaBrowser(ua: string): string {
  if (ua.includes('Edg/'))
    return 'Edge'
  if (ua.includes('OPR/'))
    return 'Opera'
  if (ua.includes('CriOS'))
    return 'Chrome'
  if (ua.includes('FxiOS') || ua.includes('Firefox/'))
    return 'Firefox'
  if (ua.includes('Chrome/'))
    return 'Chrome'
  if (ua.includes('Safari/'))
    return 'Safari'
  if (ua.includes('curl/'))
    return 'curl'
  return ''
}

function uaOs(ua: string): string {
  if (ua.includes('iPhone') || ua.includes('iPad'))
    return 'iOS'
  if (ua.includes('Android'))
    return 'Android'
  if (ua.includes('Mac OS X'))
    return 'macOS'
  if (ua.includes('Windows'))
    return 'Windows'
  if (ua.includes('Linux'))
    return 'Linux'
  return ''
}

type NotifyChannel = 'ntfy' | 'discord' | 'generic'

export function detectChannel(notifyUrl: string): NotifyChannel {
  try {
    const { hostname, pathname } = new URL(notifyUrl)
    if (hostname === 'ntfy.sh')
      return 'ntfy'
    if ((hostname === 'discord.com' || hostname === 'discordapp.com') && pathname.includes('/api/webhooks/'))
      return 'discord'
  }
  catch {
    // fall through to generic; the URL already passed schema validation
  }
  return 'generic'
}

export function formatScanMessage(slug: string, location: string, device: string, count: number, total: number): string {
  const scans = count === 1 ? '1 scan' : `${count} scans`
  let message = `🔗 ${slug} scanned`
  if (location)
    message += ` from ${location}`
  if (device)
    message += ` (${device})`
  message += ` — ${scans} since last ping · ${total} total`
  return message
}

async function postNotification(event: H3Event, link: Link, count: number, total: number): Promise<void> {
  const notifyUrl = link.notifyUrl!
  const channel = detectChannel(notifyUrl)
  const cf = event.context.cloudflare?.request?.cf
  const ua = getHeader(event, 'user-agent') || ''
  const browser = uaBrowser(ua)
  const os = uaOs(ua)
  const location = [cf?.city, cf?.country].filter(Boolean).join(', ')
  const device = [browser, os].filter(Boolean).join('/')
  const message = formatScanMessage(link.slug, location, device, count, total)
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)

  if (channel === 'ntfy') {
    await fetch(notifyUrl, {
      method: 'POST',
      body: message,
      headers: { 'X-Title': `Scan: ${link.slug}` },
      signal,
    })
    return
  }

  if (channel === 'discord') {
    await fetch(notifyUrl, {
      method: 'POST',
      body: JSON.stringify({ content: message }),
      headers: { 'Content-Type': 'application/json' },
      signal,
    })
    return
  }

  await fetch(notifyUrl, {
    method: 'POST',
    body: JSON.stringify({
      slug: link.slug,
      shortLink: buildShortLink(event, link.slug),
      count,
      total,
      country: cf?.country ?? null,
      city: cf?.city ?? null,
      device: os || null,
      browser: browser || null,
      referer: getHeader(event, 'referer') || null,
      timestamp: new Date().toISOString(),
    }),
    headers: { 'Content-Type': 'application/json' },
    signal,
  })
}

async function sendScanNotification(event: H3Event, link: Link): Promise<void> {
  try {
    if (!link.notifyUrl || isBotScan(event))
      return

    const { cloudflare } = event.context
    const { KV } = cloudflare.env
    const key = notifyStateKey(link.slug)
    const raw = await KV.get(key, { type: 'json' }) as Partial<NotifyState> | null
    const lastNotifiedAt = Number(raw?.lastNotifiedAt) || 0
    const pending = Number(raw?.pending) || 0
    const total = (Number(raw?.total) || 0) + 1

    const cooldownSeconds = (link.notifyCooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES) * 60
    const now = Math.floor(Date.now() / 1000)

    if (now - lastNotifiedAt >= cooldownSeconds) {
      await postNotification(event, link, pending + 1, total)
      await KV.put(key, JSON.stringify({ lastNotifiedAt: now, pending: 0, total } satisfies NotifyState))
    }
    else {
      await KV.put(key, JSON.stringify({ lastNotifiedAt, pending: pending + 1, total } satisfies NotifyState))
    }
  }
  catch (error) {
    console.error('[scan-notify] Failed to send notification:', error)
  }
}

export function queueScanNotification(event: H3Event, link: Link): void {
  const promise = sendScanNotification(event, link)
  // Nitro assigns event.waitUntil at runtime (forwards to the Workers
  // ExecutionContext), but h3 1.x does not declare it — hence the cast.
  const waitUntil = (event as unknown as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil
  waitUntil?.(promise)
}
```

- [ ] **Step 4: Hook the middleware (two sites)**

In `server/middleware/1.redirect.ts`, **text-link path** — find:

```ts
event.context.link = link
try {
  await useAccessLog(event)
}
catch (error) {
  console.error('Failed write access log:', error)
}
if (link.viewExpireSeconds)
  return sendNoStoreHtml(renderTextPage(link))
```

Replace with:

```ts
event.context.link = link
try {
  await useAccessLog(event)
}
catch (error) {
  console.error('Failed write access log:', error)
}
if (link.notifyUrl)
  queueScanNotification(event, link)
if (link.viewExpireSeconds)
  return sendNoStoreHtml(renderTextPage(link))
```

**Redirect path** — find:

```ts
      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }

      if (deviceRedirectUrl) {
```

Replace with:

```ts
      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }

      if (link.notifyUrl)
        queueScanNotification(event, link)

      if (deviceRedirectUrl) {
```

(`queueScanNotification` is auto-imported — it lives in `server/utils/`.)

- [ ] **Step 5: Run the e2e script to verify it passes**

The dev server hot-reloads server code; give it a few seconds after saving, then:
Run: `bash $SCRATCH/e2e-notify.sh`
Expected: `ALL PASS`, exit 0. If a check fails, debug before proceeding — do not weaken the script.

- [ ] **Step 6: Verify the generic-webhook JSON payload against a local echo server**

In dev the server code runs in Node, so it can reach localhost. Write
`$SCRATCH/echo-server.py`:

```python
import http.server
import sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        with open(sys.argv[2], 'ab') as f:
            f.write(body + b'\n')
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass

http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), Handler).serve_forever()
```

Then:

```bash
rm -f $SCRATCH/hook.log
python3 $SCRATCH/echo-server.py 9977 $SCRATCH/hook.log &
ECHO_PID=$!
AUTH="Authorization: Bearer devtoken12345"
curl -s -X POST http://localhost:7465/api/link/create -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","slug":"e2e-hook","notifyUrl":"http://127.0.0.1:9977/hook","notifyCooldownMinutes":0}' -o /dev/null
curl -s -o /dev/null -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" http://localhost:7465/e2e-hook
sleep 3
kill $ECHO_PID
python3 -c "
import json
line = open('$SCRATCH/hook.log').read().strip().splitlines()[-1]
d = json.loads(line)
required = ['slug', 'shortLink', 'count', 'total', 'country', 'city', 'device', 'browser', 'referer', 'timestamp']
missing = [k for k in required if k not in d]
assert not missing, f'missing keys: {missing}'
assert d['slug'] == 'e2e-hook' and d['count'] == 1 and d['total'] == 1, d
print('GENERIC WEBHOOK PAYLOAD OK:', {k: d[k] for k in ['slug', 'count', 'total']})
"
curl -s -X POST http://localhost:7465/api/link/delete -H "$AUTH" -H "Content-Type: application/json" -d '{"slug":"e2e-hook"}' -o /dev/null
```

Expected: `GENERIC WEBHOOK PAYLOAD OK: {'slug': 'e2e-hook', 'count': 1, 'total': 1}`.

- [ ] **Step 7: Static checks**

Run: `CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → expect empty.
Run: `pnpm lint:fix && pnpm lint` → expect 0 errors.

- [ ] **Step 8: Commit**

```bash
git add server/utils/scan-notify.ts server/middleware/1.redirect.ts
git commit -m "feat: send scan notifications via ntfy/Discord/webhook with cooldown batching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 3: Clean up notification state when a link is deleted

The spec places cleanup in the delete endpoint; implementing it inside
`deleteLink()` (which the endpoint already calls) covers every deletion path
in one place — same behavior, better location.

**Files:**

- Modify: `server/utils/link-store.ts` (`deleteLink`, lines 50-54)
- Test script: `$SCRATCH/e2e-delete-cleanup.sh`

**Interfaces:**

- Consumes: `notifyStateKey(slug)` from Task 2 (auto-imported).
- Produces: no new interfaces; `deleteLink` behavior now includes notify-state removal.

- [ ] **Step 1: Write the failing test script**

The notify state is not directly readable from outside, so the test observes
it behaviorally: put a link into cooldown, delete it, recreate the same slug,
and scan — a wiped state notifies immediately with fresh counters; a stale
state stays silent (cooldown) or reports inflated counts.

Write `$SCRATCH/e2e-delete-cleanup.sh`:

```bash
#!/usr/bin/env bash
set -u
BASE=http://localhost:7465
AUTH="Authorization: Bearer devtoken12345"
UA="User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15"
TOPIC="sink-del-$RANDOM$RANDOM"
SLUG="e2e-del-$RANDOM"
FAIL=0

create() {
  curl -s -X POST "$BASE/api/link/create" -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"url\":\"https://example.com/\",\"slug\":\"$SLUG\",\"notifyUrl\":\"https://ntfy.sh/$TOPIC\",\"notifyCooldownMinutes\":60}" -o /dev/null
}
delete() {
  curl -s -X POST "$BASE/api/link/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"slug\":\"$SLUG\"}" -o /dev/null
}
scan() { curl -s -o /dev/null -H "$UA" "$BASE/$SLUG"; sleep 3; }
msgs() {
  curl -s "https://ntfy.sh/$TOPIC/json?poll=1" | python3 -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    if d.get("event") == "message":
        print(d.get("message", ""))'
}

create
scan          # push #1, enters 60-min cooldown
scan          # silent, pending=1
delete
create        # same slug, fresh link
scan          # if state was wiped: immediate push "1 scan · 1 total"

LAST=$(msgs | tail -1)
COUNT=$(msgs | wc -l | tr -d ' ')
if [ "$COUNT" = "2" ] && echo "$LAST" | grep -q "1 scan since last ping · 1 total"; then
  echo "PASS: delete wiped notify state"
else
  echo "FAIL: expected 2 messages ending in fresh '1 scan · 1 total', got $COUNT messages, last: $LAST"
  FAIL=1
fi

delete
exit $FAIL
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash $SCRATCH/e2e-delete-cleanup.sh`
Expected: `FAIL` — with stale state the post-recreate scan is inside the
60-minute cooldown, so only 1 message ever arrives. Exit 1.

- [ ] **Step 3: Implement cleanup in `deleteLink`**

In `server/utils/link-store.ts`, replace:

```ts
export async function deleteLink(event: H3Event, slug: string): Promise<void> {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  await KV.delete(`link:${slug}`)
}
```

with:

```ts
export async function deleteLink(event: H3Event, slug: string): Promise<void> {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  await KV.delete(`link:${slug}`)
  await KV.delete(notifyStateKey(slug))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bash $SCRATCH/e2e-delete-cleanup.sh`
Expected: `PASS: delete wiped notify state`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/utils/link-store.ts
git commit -m "feat: wipe notification state when a link is deleted

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 4: i18n — notification keys (all 10 locales) + backfill of earlier feature keys (5 locales)

The 5 locales upstream added after the fork's features were ported (de-DE,
id-ID, it-IT, pt-BR, pt-PT) are missing the text-mode/hit-limit/self-destruct
keys and currently fall back to English. Backfill them here since we're
touching every locale file anyway.

**Files:**

- Modify: all 10 of `i18n/locales/{en-US,de-DE,fr-FR,id-ID,it-IT,pt-BR,pt-PT,vi-VN,zh-CN,zh-TW}.json` (via script)
- Script: `$SCRATCH/i18n_notify.py`

**Interfaces:**

- Consumes: existing JSON structure — new form keys go under `links.form`, others under `links`.
- Produces: keys Task 5/6 templates reference: `links.form.notifications`, `links.form.notify_url`, `links.form.notify_url_description`, `links.form.notify_url_placeholder`, `links.form.notify_cooldown`, `links.form.notify_cooldown_description`, `links.form.notify_cooldown_placeholder`, `links.notifications_on`.

- [ ] **Step 1: Write the injection script**

Write `$SCRATCH/i18n_notify.py` (complete file):

```python
import json

BASE = "/home/ubuntu/repos/Sink/i18n/locales"
ALL = ["en-US", "de-DE", "fr-FR", "id-ID", "it-IT", "pt-BR", "pt-PT", "vi-VN", "zh-CN", "zh-TW"]
BACKFILL = ["de-DE", "id-ID", "it-IT", "pt-BR", "pt-PT"]

# --- New notification keys, all 10 locales ---

notify_form = {
    "notifications": {
        "en-US": "Notifications", "de-DE": "Benachrichtigungen", "fr-FR": "Notifications",
        "id-ID": "Notifikasi", "it-IT": "Notifiche", "pt-BR": "Notificações",
        "pt-PT": "Notificações", "vi-VN": "Thông báo", "zh-CN": "通知", "zh-TW": "通知",
    },
    "notify_url": {
        "en-US": "Notify URL", "de-DE": "Benachrichtigungs-URL", "fr-FR": "URL de notification",
        "id-ID": "URL notifikasi", "it-IT": "URL di notifica", "pt-BR": "URL de notificação",
        "pt-PT": "URL de notificação", "vi-VN": "URL thông báo", "zh-CN": "通知 URL", "zh-TW": "通知 URL",
    },
    "notify_url_description": {
        "en-US": "Get a push when this link is visited. Accepts an ntfy.sh topic URL, a Discord webhook, or any webhook URL (JSON POST).",
        "de-DE": "Erhalte eine Push-Nachricht, wenn dieser Link besucht wird. Unterstützt ntfy.sh-Topic-URLs, Discord-Webhooks oder beliebige Webhook-URLs (JSON POST).",
        "fr-FR": "Recevez une notification quand ce lien est visité. Accepte une URL de sujet ntfy.sh, un webhook Discord ou toute URL de webhook (JSON POST).",
        "id-ID": "Dapatkan notifikasi saat tautan ini dikunjungi. Menerima URL topik ntfy.sh, webhook Discord, atau URL webhook apa pun (JSON POST).",
        "it-IT": "Ricevi una notifica quando questo link viene visitato. Accetta un URL di topic ntfy.sh, un webhook Discord o qualsiasi URL webhook (JSON POST).",
        "pt-BR": "Receba uma notificação quando este link for visitado. Aceita uma URL de tópico ntfy.sh, um webhook do Discord ou qualquer URL de webhook (JSON POST).",
        "pt-PT": "Receba uma notificação quando esta ligação for visitada. Aceita um URL de tópico ntfy.sh, um webhook do Discord ou qualquer URL de webhook (JSON POST).",
        "vi-VN": "Nhận thông báo đẩy khi liên kết này được truy cập. Chấp nhận URL chủ đề ntfy.sh, webhook Discord hoặc bất kỳ URL webhook nào (JSON POST).",
        "zh-CN": "当此链接被访问时收到推送通知。支持 ntfy.sh 主题 URL、Discord Webhook 或任意 Webhook URL（JSON POST）。",
        "zh-TW": "當此連結被訪問時收到推送通知。支援 ntfy.sh 主題 URL、Discord Webhook 或任意 Webhook URL（JSON POST）。",
    },
    "notify_url_placeholder": {loc: "https://ntfy.sh/your-topic" for loc in ALL},
    "notify_cooldown": {
        "en-US": "Notification cooldown (minutes)", "de-DE": "Benachrichtigungs-Pause (Minuten)",
        "fr-FR": "Délai entre notifications (minutes)", "id-ID": "Jeda notifikasi (menit)",
        "it-IT": "Pausa tra notifiche (minuti)", "pt-BR": "Intervalo entre notificações (minutos)",
        "pt-PT": "Intervalo entre notificações (minutos)", "vi-VN": "Thời gian chờ thông báo (phút)",
        "zh-CN": "通知冷却时间（分钟）", "zh-TW": "通知冷卻時間（分鐘）",
    },
    "notify_cooldown_description": {
        "en-US": "Quiet window between pushes; scans during it are batched into the next notification. 0 notifies on every scan.",
        "de-DE": "Ruhefenster zwischen Push-Nachrichten; Scans in dieser Zeit werden in der nächsten Benachrichtigung gebündelt. 0 benachrichtigt bei jedem Scan.",
        "fr-FR": "Fenêtre de silence entre les notifications ; les visites pendant cette période sont regroupées dans la suivante. 0 notifie à chaque visite.",
        "id-ID": "Jendela tenang antar notifikasi; kunjungan selama periode ini digabungkan ke notifikasi berikutnya. 0 memberi tahu setiap kunjungan.",
        "it-IT": "Finestra di silenzio tra le notifiche; le visite durante questo periodo vengono raggruppate nella successiva. 0 notifica ogni visita.",
        "pt-BR": "Janela de silêncio entre notificações; visitas durante esse período são agrupadas na próxima. 0 notifica a cada visita.",
        "pt-PT": "Janela de silêncio entre notificações; visitas durante esse período são agrupadas na seguinte. 0 notifica a cada visita.",
        "vi-VN": "Khoảng lặng giữa các thông báo; lượt truy cập trong thời gian này được gộp vào thông báo tiếp theo. 0 = thông báo mỗi lượt.",
        "zh-CN": "两次推送之间的静默窗口；期间的访问将合并到下一次通知中。0 表示每次访问都通知。",
        "zh-TW": "兩次推送之間的靜默窗口；期間的訪問將合併到下一次通知中。0 表示每次訪問都通知。",
    },
    "notify_cooldown_placeholder": {loc: "5" for loc in ALL},
}

notify_links = {
    "notifications_on": {
        "en-US": "Notifications on", "de-DE": "Benachrichtigungen aktiv", "fr-FR": "Notifications activées",
        "id-ID": "Notifikasi aktif", "it-IT": "Notifiche attive", "pt-BR": "Notificações ativadas",
        "pt-PT": "Notificações ativadas", "vi-VN": "Đã bật thông báo", "zh-CN": "通知已开启", "zh-TW": "通知已開啟",
    },
}

# --- Backfill: earlier feature keys missing from the 5 newer locales ---

backfill_form = {
    "type": {"de-DE": "Link-Typ", "id-ID": "Jenis tautan", "it-IT": "Tipo di link", "pt-BR": "Tipo de link", "pt-PT": "Tipo de ligação"},
    "type_redirect": {"de-DE": "Weiterleitung", "id-ID": "Pengalihan", "it-IT": "Reindirizzamento", "pt-BR": "Redirecionamento", "pt-PT": "Redirecionamento"},
    "type_text": {"de-DE": "Text", "id-ID": "Teks", "it-IT": "Testo", "pt-BR": "Texto", "pt-PT": "Texto"},
    "content": {"de-DE": "Inhalt", "id-ID": "Konten", "it-IT": "Contenuto", "pt-BR": "Conteúdo", "pt-PT": "Conteúdo"},
    "content_placeholder": {"de-DE": "Markdown-Inhalt eingeben...", "id-ID": "Masukkan konten markdown...", "it-IT": "Inserisci contenuto markdown...", "pt-BR": "Digite o conteúdo markdown...", "pt-PT": "Introduza o conteúdo markdown..."},
    "content_description": {"de-DE": "Markdown wird unterstützt.", "id-ID": "Mendukung markdown.", "it-IT": "Markdown è supportato.", "pt-BR": "Markdown é suportado.", "pt-PT": "Markdown é suportado."},
    "max_hits": {"de-DE": "Aufruf-Limit", "id-ID": "Batas kunjungan", "it-IT": "Limite di visite", "pt-BR": "Limite de acessos", "pt-PT": "Limite de acessos"},
    "max_hits_placeholder": {"de-DE": "Unbegrenzt", "id-ID": "Tak terbatas", "it-IT": "Illimitato", "pt-BR": "Ilimitado", "pt-PT": "Ilimitado"},
    "max_hits_description": {"de-DE": "Maximale Anzahl an Aufrufen, bevor der Link abläuft.", "id-ID": "Jumlah kunjungan maksimum sebelum tautan kedaluwarsa.", "it-IT": "Numero massimo di visite prima della scadenza del link.", "pt-BR": "Número máximo de visitas antes de o link expirar.", "pt-PT": "Número máximo de visitas antes de a ligação expirar."},
    "view_expire_seconds": {"de-DE": "Selbstzerstörungs-Timer (Sekunden)", "id-ID": "Penghitung waktu penghancuran otomatis (detik)", "it-IT": "Timer di autodistruzione (secondi)", "pt-BR": "Temporizador de autodestruição (segundos)", "pt-PT": "Temporizador de autodestruição (segundos)"},
    "view_expire_placeholder": {"de-DE": "Keine Selbstzerstörung", "id-ID": "Tanpa penghancuran otomatis", "it-IT": "Nessuna autodistruzione", "pt-BR": "Sem autodestruição", "pt-PT": "Sem autodestruição"},
    "view_expire_description": {"de-DE": "Sekunden nach dem ersten Aufruf, bis der Inhalt sich selbst zerstört.", "id-ID": "Detik setelah tampilan pertama sebelum konten dihancurkan.", "it-IT": "Secondi dopo la prima visualizzazione prima che il contenuto si autodistrugga.", "pt-BR": "Segundos após a primeira visualização até o conteúdo se autodestruir.", "pt-PT": "Segundos após a primeira visualização até o conteúdo se autodestruir."},
}

backfill_links = {
    "hit_limit_reached": {"de-DE": "Aufruf-Limit erreicht - Link abgelaufen", "id-ID": "Batas kunjungan tercapai - tautan kedaluwarsa", "it-IT": "Limite di visite raggiunto - link scaduto", "pt-BR": "Limite de acessos atingido - link expirado", "pt-PT": "Limite de acessos atingido - ligação expirada"},
    "hits_used": {"de-DE": "Aufrufe verwendet", "id-ID": "kunjungan digunakan", "it-IT": "visite utilizzate", "pt-BR": "acessos usados", "pt-PT": "acessos usados"},
    "first_viewed_at": {"de-DE": "Zuerst angesehen", "id-ID": "Pertama dilihat", "it-IT": "Prima visualizzazione", "pt-BR": "Primeira visualização", "pt-PT": "Primeira visualização"},
    "self_destructed": {"de-DE": "Selbstzerstört", "id-ID": "Hancur otomatis", "it-IT": "Autodistrutto", "pt-BR": "Autodestruído", "pt-PT": "Autodestruído"},
    "self_destructs_at": {"de-DE": "Selbstzerstörung am", "id-ID": "Hancur otomatis pada", "it-IT": "Autodistruzione alle", "pt-BR": "Autodestruição em", "pt-PT": "Autodestruição em"},
    "reset": {"de-DE": "Zurücksetzen", "id-ID": "Atur ulang", "it-IT": "Reimposta", "pt-BR": "Redefinir", "pt-PT": "Repor"},
    "reset_confirm_title": {"de-DE": "Diesen Link zurücksetzen?", "id-ID": "Atur ulang tautan ini?", "it-IT": "Reimpostare questo link?", "pt-BR": "Redefinir este link?", "pt-PT": "Repor esta ligação?"},
    "reset_confirm_desc": {"de-DE": "Dies setzt den Aufrufzähler und den Selbstzerstörungs-Timer zurück, sodass der Link wieder angesehen werden kann.", "id-ID": "Ini akan mengatur ulang jumlah kunjungan dan penghitung penghancuran otomatis, sehingga tautan dapat dilihat kembali.", "it-IT": "Reimposterà il conteggio delle visite e il timer di autodistruzione, permettendo di visualizzare nuovamente il link.", "pt-BR": "Isso redefinirá a contagem de acessos e o temporizador de autodestruição, permitindo que o link seja visualizado novamente.", "pt-PT": "Isto irá repor a contagem de acessos e o temporizador de autodestruição, permitindo que a ligação seja visualizada novamente."},
    "reset_success": {"de-DE": "Link erfolgreich zurückgesetzt", "id-ID": "Tautan berhasil diatur ulang", "it-IT": "Link reimpostato con successo", "pt-BR": "Link redefinido com sucesso", "pt-PT": "Ligação reposta com sucesso"},
    "reset_failed": {"de-DE": "Zurücksetzen des Links fehlgeschlagen", "id-ID": "Gagal mengatur ulang tautan", "it-IT": "Reimpostazione del link non riuscita", "pt-BR": "Falha ao redefinir o link", "pt-PT": "Falha ao repor a ligação"},
}

for loc in ALL:
    path = f"{BASE}/{loc}.json"
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    links = d.setdefault("links", {})
    form = links.setdefault("form", {})
    for k, tr in notify_form.items():
        form.setdefault(k, tr[loc])
    for k, tr in notify_links.items():
        links.setdefault(k, tr[loc])
    if loc in BACKFILL:
        for k, tr in backfill_form.items():
            form.setdefault(k, tr[loc])
        for k, tr in backfill_links.items():
            links.setdefault(k, tr[loc])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"updated {loc}")

# Verify: every locale has every key
missing = []
for loc in ALL:
    with open(f"{BASE}/{loc}.json", encoding="utf-8") as f:
        d = json.load(f)
    for k in list(notify_form) + list(backfill_form):
        if k not in d["links"]["form"]:
            missing.append(f"{loc}: form.{k}")
    for k in list(notify_links) + list(backfill_links):
        if k not in d["links"]:
            missing.append(f"{loc}: links.{k}")
print("MISSING:", missing if missing else "none — ALL KEYS PRESENT")
```

- [ ] **Step 2: Run it**

Run: `python3 $SCRATCH/i18n_notify.py`
Expected: `updated <locale>` ×10, then `MISSING: none — ALL KEYS PRESENT`.

- [ ] **Step 3: Sanity-check one locale diff**

Run: `git diff --stat i18n/ && python3 -c "import json; d=json.load(open('i18n/locales/de-DE.json')); print(d['links']['form']['notify_url'], '|', d['links']['form']['max_hits'])"`
Expected: 10 files changed; prints `Benachrichtigungs-URL | Aufruf-Limit`.

- [ ] **Step 4: Commit**

```bash
git add i18n/locales/
git commit -m "feat: add notification i18n keys and backfill missing feature keys in newer locales

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 5: Editor UI — "Notifications" accordion section

**Files:**

- Modify: `layers/dashboard/app/components/dashboard/links/editor/Advanced.vue` (add accordion item after the `geo` item, ~line 357; extend `defaultOpenItems`, ~lines 47-63)

**Interfaces:**

- Consumes: form fields `notifyUrl` / `notifyCooldownMinutes` (Task 1), i18n keys (Task 4), existing props `validateOptionalUrl`, `isInvalid`, `getAriaInvalid`, `formatErrors` (already passed to `Advanced.vue`).
- Produces: user-visible editor section; no code interfaces.

- [ ] **Step 1: Extend `defaultOpenItems`**

In `Advanced.vue`, find:

```ts
const geoVal = props.form.getFieldValue('geo')
if (Array.isArray(geoVal) && geoVal.length > 0) {
  items.push('geo')
}
return items
```

Replace with:

```ts
const geoVal = props.form.getFieldValue('geo')
if (Array.isArray(geoVal) && geoVal.length > 0) {
  items.push('geo')
}
if (props.form.getFieldValue('notifyUrl')) {
  items.push('notifications')
}
return items
```

- [ ] **Step 2: Add the accordion section**

In `Advanced.vue`'s template, the last accordion item ends:

```vue
    <AccordionItem value="geo">
```

…(its full block)…

```vue
    </AccordionItem>
  </Accordion>
</template>
```

Insert a new item between the closing `</AccordionItem>` of the geo block and `</Accordion>`:

```vue
    <AccordionItem value="notifications">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.notifications') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field
            v-slot="{ field }"
            name="notifyUrl"
            :validators="{ onBlur: validateOptionalUrl }"
          >
            <Field :data-invalid="isInvalid(field)">
              <FieldLabel :for="field.name">
                {{ $t('links.form.notify_url') }}
              </FieldLabel>
              <FieldDescription class="text-xs">
                {{ $t('links.form.notify_url_description') }}
              </FieldDescription>
              <Input
                :id="field.name"
                :name="field.name"
                :model-value="field.state.value"
                :aria-invalid="getAriaInvalid(field)"
                :placeholder="$t('links.form.notify_url_placeholder')"
                autocomplete="off"
                @blur="field.handleBlur"
                @input="field.handleChange(($event.target as HTMLInputElement).value)"
              />
              <FieldError
                v-if="isInvalid(field)"
                :errors="formatErrors(field.state.meta.errors)"
              />
            </Field>
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="notifyCooldownMinutes">
            <Field>
              <FieldLabel :for="field.name">
                {{ $t('links.form.notify_cooldown') }}
              </FieldLabel>
              <FieldDescription class="text-xs">
                {{ $t('links.form.notify_cooldown_description') }}
              </FieldDescription>
              <Input
                :id="field.name"
                :name="field.name"
                type="number"
                min="0"
                :model-value="field.state.value"
                :placeholder="$t('links.form.notify_cooldown_placeholder')"
                @blur="field.handleBlur"
                @input="field.handleChange(($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"
              />
            </Field>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>
```

- [ ] **Step 3: Static checks**

Run: `CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → expect empty.
Run: `pnpm lint:fix && pnpm lint` → expect 0 errors.

- [ ] **Step 4: Verify round-trip through the real editor API path**

With the dev server running:

```bash
AUTH="Authorization: Bearer devtoken12345"
curl -s -X POST http://localhost:7465/api/link/create -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","slug":"t5-ui","notifyUrl":"https://ntfy.sh/t5-topic","notifyCooldownMinutes":0}' -o /dev/null
curl -s "http://localhost:7465/api/link/query?slug=t5-ui" -H "$AUTH" | python3 -c "import sys,json; d=json.load(sys.stdin); l=d.get('link') or d; print('notifyUrl:', l.get('notifyUrl'), '| cooldown:', l.get('notifyCooldownMinutes'))"
curl -s -X POST http://localhost:7465/api/link/delete -H "$AUTH" -H "Content-Type: application/json" -d '{"slug":"t5-ui"}' -o /dev/null
```

Expected: `notifyUrl: https://ntfy.sh/t5-topic | cooldown: 0` (note `0` survives).

(Full browser verification of the rendered section happens in Task 7's
walkthrough; this task's gate is types + lint + persistence.)

- [ ] **Step 5: Commit**

```bash
git add layers/dashboard/app/components/dashboard/links/editor/Advanced.vue
git commit -m "feat: add notifications section to the link editor

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 6: Bell indicator on the link card

**Files:**

- Modify: `layers/dashboard/app/components/dashboard/links/Link.vue` (lucide import ~line 4; meta row template, before the final `<Separator orientation="vertical" />` + truncate span)

**Interfaces:**

- Consumes: `link.notifyUrl` (Task 1), i18n key `links.notifications_on` (Task 4).
- Produces: user-visible badge; no code interfaces.

- [ ] **Step 1: Add `Bell` to the lucide import**

In `Link.vue`, the import currently begins:

```ts
import { CalendarPlus2, Copy, CopyCheck, Eraser, Eye, FileText, Flame, Gauge, Hourglass, Link as LinkIcon, MousePointerClick, QrCode, RotateCcw, ShieldAlert, SquareChevronDown, SquarePen, Timer, Users } from 'lucide-vue-next'
```

Change to:

```ts
import { Bell, CalendarPlus2, Copy, CopyCheck, Eraser, Eye, FileText, Flame, Gauge, Hourglass, Link as LinkIcon, MousePointerClick, QrCode, RotateCcw, ShieldAlert, SquareChevronDown, SquarePen, Timer, Users } from 'lucide-vue-next'
```

- [ ] **Step 2: Add the badge to the meta row**

Find (end of the meta row, after the self-destruct template block):

```vue
            <Separator orientation="vertical" />

            <span class="truncate">
{{ isTextLink ? contentPreview : link.url }}
</span>
          </div>
```

Replace with:

```vue
<template v-if="link.notifyUrl">
  <Separator orientation="vertical" />
  <TooltipProvider>
    <Tooltip>
      <TooltipTrigger as-child>
        <span
          class="inline-flex items-center leading-5 whitespace-nowrap"
        >
          <Bell aria-hidden="true" class="h-4 w-4" />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{{ $t('links.notifications_on') }}</p>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

            <Separator orientation="vertical" />

            <span class="truncate">
{{ isTextLink ? contentPreview : link.url }}
</span>
          </div>
```

- [ ] **Step 3: Static checks**

Run: `CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → expect empty.
Run: `pnpm lint:fix && pnpm lint` → expect 0 errors (lint:fix may rewrap Tailwind classes — that's fine, keep its output).

- [ ] **Step 4: Commit**

```bash
git add layers/dashboard/app/components/dashboard/links/Link.vue
git commit -m "feat: show bell indicator on cards for links with notifications

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 7: Full verification, browser walkthrough, push

**Files:**

- Create: `$SCRATCH/ui-walk.mjs` (browser check; scratch only, not committed)
- No repo files modified unless fixes are needed.

**Interfaces:**

- Consumes: everything from Tasks 1-6.
- Produces: verified feature; branch pushed.

- [ ] **Step 1: Full static + build gate**

```bash
CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"   # expect empty
pnpm lint                                                                 # expect 0 errors
pnpm build                                                                # NO CI=true! expect exit 0
```

- [ ] **Step 2: Re-run both e2e scripts against dev**

Restart the dev server if it was stopped, then:

```bash
bash $SCRATCH/e2e-notify.sh          # expect ALL PASS
bash $SCRATCH/e2e-delete-cleanup.sh  # expect PASS
```

- [ ] **Step 3: Browser walkthrough of the editor section and bell**

Playwright-core is already installed at
`/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/uitest/node_modules`
with chromium at
`/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`.

Write `$SCRATCH/ui-walk.mjs`:

```js
import { createRequire } from 'node:module'

const require = createRequire('/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/uitest/package.json')
const { chromium } = require('playwright-core')

const EXE = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome'
const BASE = 'http://localhost:7465'
const TOKEN = 'devtoken12345'
const SHOT = '/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/notify-tests'

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1200, height: 1400 } })).newPage()
try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(t => localStorage.setItem('SinkSiteToken', t), TOKEN)
  await page.goto(`${BASE}/dashboard/links`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(2500)

  await page.getByRole('button', { name: /Create Link/i }).first().click()
  await page.waitForTimeout(1500)

  // open the Notifications accordion section
  await page.getByText('Notifications', { exact: true }).first().click()
  await page.waitForTimeout(600)
  const urlField = await page.locator('#notifyUrl').count()
  const cooldownField = await page.locator('#notifyCooldownMinutes').count()
  console.log('notifyUrl field:', urlField, '| cooldown field:', cooldownField)

  // fill and save
  const slug = `ui-notify-${Math.floor(Math.random() * 9000 + 1000)}`
  await page.locator('#url').fill('https://example.com/')
  await page.locator('#slug').fill(slug)
  await page.locator('#notifyUrl').fill('https://ntfy.sh/ui-walk-topic')
  await page.screenshot({ path: `${SHOT}/notify-editor.png` })
  await page.getByRole('button', { name: /^Save$/ }).first().click()
  await page.waitForTimeout(3000)
  await page.screenshot({ path: `${SHOT}/notify-card.png`, fullPage: true })

  // bell visible on the new card?
  const bell = await page.locator('svg.lucide-bell').count()
  console.log('bell icons on page:', bell)
  console.log(urlField === 1 && cooldownField === 1 && bell >= 1 ? 'UI_WALK_OK' : 'UI_WALK_FAIL')
  console.log(`CLEANUP_SLUG=${slug}`)
}
catch (e) {
  console.log('UI_WALK_ERROR:', e.message)
  await page.screenshot({ path: `${SHOT}/notify-error.png`, fullPage: true }).catch(() => {})
}
finally {
  await browser.close()
}
```

Run: `node $SCRATCH/ui-walk.mjs`
Expected: `notifyUrl field: 1 | cooldown field: 1`, `bell icons on page: 1` (or more), `UI_WALK_OK`.
**Open and LOOK at both screenshots** (`notify-editor.png`, `notify-card.png`) — confirm the section renders with label + description text and the bell shows on the card. A blank or broken layout is a failure even if the counts pass.
Then delete the test link:
`curl -s -X POST http://localhost:7465/api/link/delete -H "Authorization: Bearer devtoken12345" -H "Content-Type: application/json" -d '{"slug":"<CLEANUP_SLUG value>"}' -o /dev/null`

- [ ] **Step 4: Push**

```bash
git push origin master
```

- [ ] **Step 5: Report deploy readiness (do NOT deploy)**

Deploying to `scan.flippinflops.com` publishes the feature. Do not run it —
report to the user that the feature is verified and the deploy commands are:

```bash
pnpm build && npx wrangler deploy
```

followed by a live smoke test (create a link with a real ntfy topic on the
production domain, scan it, confirm the phone push). The user decides when.

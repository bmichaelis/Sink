# Batch Single-Use Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create batches of 1–100 unique single-use QR codes (redirect vouchers or check-in tickets) with a dashboard for claimed/unclaimed status, printable QR sheets, PNG ZIP export, and per-code reset.

**Architecture:** Each code is an ordinary link with four new optional fields (`batchId`, `batchSeq`, `batchMode`, `claimedAt`); one `batch:<id>` KV record holds batch metadata and the ordered slug list. Redirect-mode codes reuse `maxHits: 1` untouched; check-in codes get one middleware branch (GET = read-only status page, confirm-button POST = awaited claim). A new Batches dashboard page manages everything.

**Tech Stack:** Nuxt 4 (layers) + Nitro on Cloudflare Workers, Workers KV, Zod, `qr-code-styling` (already present), `client-zip` (new, only new dependency).

**Spec:** `docs/superpowers/specs/2026-07-14-batch-single-use-codes-design.md`
**Issue:** #6 — the final PR body must contain `Closes #6`.

## Global Constraints

- Work in the worktree `/home/ubuntu/repos/Sink/.claude/worktrees/6-batch-single-use-codes` on branch `worktree-6-batch-single-use-codes`. **Never commit to master; never push master.** The feature ships as a PR.
- Package manager is **pnpm**. **NEVER build or run dev with `CI=true`** (breaks the cloudflare-module preset; `CI=true` is fine for `pnpm types:check` and `pnpm install`).
- Dev server: `NUXT_SITE_TOKEN=devtoken12345 pnpm dev` → `http://localhost:7465` with real local bindings. Start once in the background; do not start a second one.
  ⚠️ The main checkout and other worktrees share the same local KV state dir per-worktree — this worktree gets its own `.wrangler` state; run `pnpm install` in the worktree first (fresh worktrees have no `node_modules`).
- Code slugs within a batch are **random nanoid(10)** — never sequential, never derived from `batchSeq`.
- Check-in GETs must never mutate state. The claim happens only on `POST` with form field `checkin=true`, and the claim KV write is **awaited** before responding.
- `LinkSchema` stays a flat `z.object` (`.shape` consumers). Server-rendered guest/staff pages are English (existing precedent); all dashboard strings go through i18n in **all 10 locales**.
- Style: 2-space, single quotes, no semicolons; lint-staged pre-commit hook runs eslint --fix automatically. Never edit `app/components/ui/**`.
- Every commit message references the issue (e.g. `feat: ... (#6)`) and ends with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- Known pre-existing failures to IGNORE: `types:check` errors in `layers/dashboard/app/components/dashboard/links/Search.vue` (pinia module + cascading unknowns). The repo vitest pool does not initialize in this environment — verification is types:check, lint, and executable dev-server e2e scripts (write script → watch fail → implement → watch pass).
- Scratch scripts: `export SCRATCH=/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/batch-tests && mkdir -p "$SCRATCH"`.
- e2e scripts use `AUTH="Authorization: Bearer devtoken12345"` and `BASE=http://localhost:7465`.

---

### Task 1: Schema foundation — link fields, batch schema, form-type exclusions, server-managed preservation, reset

**Files:**
- Modify: `shared/schemas/link.ts` (LinkSchema fields ~line 50; `refineLinkContent` ~line 68)
- Create: `shared/schemas/batch.ts`
- Modify: `shared/types/link.ts` (`LinkFormFields` Omit list, ~line 16)
- Modify: `server/utils/link-processing.ts` (`mergeEditableLink`, ~line 55)
- Modify: `server/api/link/reset.post.ts` (~line 50)

**Interfaces:**
- Produces: `Link.batchId?: string`, `Link.batchSeq?: number`, `Link.batchMode?: 'redirect' | 'checkin'`, `Link.claimedAt?: number`; `BatchModeEnum` (zod enum) exported from `shared/schemas/link.ts`; `CreateBatchSchema` and `interface BatchRecord { id, name, mode, url?, count, createdAt, slugs }` exported from `shared/schemas/batch.ts`. Later tasks rely on these exact names.
- Consumes: existing `nanoid`, `LinkSchema` patterns.

- [ ] **Step 1: Add fields + enum to `shared/schemas/link.ts`**

The `LinkSchema` object currently ends:

```ts
  notifyUrl: z.string().trim().url().max(2048).optional(),
  notifyCooldownMinutes: z.number().int().nonnegative().max(1440).optional(),
})
```

Change to:

```ts
  notifyUrl: z.string().trim().url().max(2048).optional(),
  notifyCooldownMinutes: z.number().int().nonnegative().max(1440).optional(),
  batchId: z.string().trim().max(26).optional(),
  batchSeq: z.number().int().positive().optional(),
  batchMode: BatchModeEnum.optional(),
  claimedAt: z.number().int().safe().optional(),
})
```

And directly above the `export const LinkTypeEnum = ...` line add:

```ts
export const BatchModeEnum = z.enum(['redirect', 'checkin'])
```

- [ ] **Step 2: `refineLinkContent` early return for check-in codes**

Replace the current function signature/body start:

```ts
export function refineLinkContent(
  data: { type?: 'redirect' | 'text', url?: string, content?: string },
  ctx: z.RefinementCtx,
): void {
  const type = data.type ?? 'redirect'
```

with:

```ts
export function refineLinkContent(
  data: { type?: 'redirect' | 'text', url?: string, content?: string, batchMode?: 'redirect' | 'checkin' },
  ctx: z.RefinementCtx,
): void {
  // Check-in batch codes have no destination URL by design.
  if (data.batchMode === 'checkin')
    return
  const type = data.type ?? 'redirect'
```

(The rest of the function is unchanged.)

- [ ] **Step 3: Create `shared/schemas/batch.ts`**

```ts
import { z } from 'zod'
import { BatchModeEnum } from './link'

export const CreateBatchSchema = z.object({
  name: z.string().trim().min(1).max(128),
  mode: BatchModeEnum,
  url: z.string().trim().url().max(2048).optional(),
  count: z.number().int().min(1).max(100),
}).superRefine((data, ctx) => {
  if (data.mode === 'redirect' && !data.url) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'URL is required for redirect batches', path: ['url'] })
  }
})

export type CreateBatch = z.infer<typeof CreateBatchSchema>

export type BatchMode = z.infer<typeof BatchModeEnum>

export interface BatchRecord {
  id: string
  name: string
  mode: BatchMode
  url?: string
  count: number
  createdAt: number
  slugs: string[]
}

export interface BatchCodeStatus {
  slug: string
  seq: number
  missing: boolean
  claimed: boolean
  claimedAt: number | null
  hitCount: number
}
```

- [ ] **Step 4: Exclude the four fields from `LinkFormData`**

In `shared/types/link.ts`, the `Omit` currently reads:

```ts
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes'> & {
```

Change to:

```ts
type LinkFormFields = Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'expiration' | 'geo' | 'hitCount' | 'firstHitAt' | 'maxHits' | 'viewExpireSeconds' | 'notifyCooldownMinutes' | 'batchId' | 'batchSeq' | 'batchMode' | 'claimedAt'> & {
```

(Batch fields are server-managed; the editor never touches them.)

- [ ] **Step 5: Preserve server-managed batch fields in `mergeEditableLink`**

In `server/utils/link-processing.ts`, the merge currently includes:

```ts
    // Preserve server-managed hit counters (never edited from the form).
    hitCount: existingLink.hitCount ?? 0,
    firstHitAt: existingLink.firstHitAt,
```

Change to:

```ts
    // Preserve server-managed hit counters and batch state (never edited from the form).
    hitCount: existingLink.hitCount ?? 0,
    firstHitAt: existingLink.firstHitAt,
    batchId: existingLink.batchId,
    batchSeq: existingLink.batchSeq,
    batchMode: existingLink.batchMode,
    claimedAt: existingLink.claimedAt,
```

- [ ] **Step 6: Reset clears `claimedAt`**

In `server/api/link/reset.post.ts`:

```ts
  const newLink: Link = {
    ...existingLink,
    hitCount: 0,
    firstHitAt: undefined,
    updatedAt: Math.floor(Date.now() / 1000),
  }
```

becomes:

```ts
  const newLink: Link = {
    ...existingLink,
    hitCount: 0,
    firstHitAt: undefined,
    claimedAt: undefined,
    updatedAt: Math.floor(Date.now() / 1000),
  }
```

- [ ] **Step 7: Static checks + dev API sanity**

Run: `CI=true pnpm install` (fresh worktree), then
`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → expect empty.
`pnpm lint:fix && pnpm lint` → 0 errors.

Start the dev server in the background (`NUXT_SITE_TOKEN=devtoken12345 pnpm dev`, wait for 200), then verify a check-in-shaped link is accepted without a URL:

```bash
AUTH="Authorization: Bearer devtoken12345"; BASE=http://localhost:7465
curl -s -X POST "$BASE/api/link/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"slug":"t1-checkin","batchId":"testbatch1","batchSeq":1,"batchMode":"checkin"}' -w "\n[%{http_code}]\n" | tail -2
curl -s -X POST "$BASE/api/link/delete" -H "$AUTH" -H "Content-Type: application/json" -d '{"slug":"t1-checkin"}' -o /dev/null
```

Expected: `[201]` (no `url` required when `batchMode` is `checkin`).

- [ ] **Step 8: Commit**

```bash
git add shared/schemas/link.ts shared/schemas/batch.ts shared/types/link.ts server/utils/link-processing.ts server/api/link/reset.post.ts
git commit -m "feat: add batch code fields and batch schema (#6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 2: Batch store util + API endpoints (create / list / detail / delete)

**Files:**
- Create: `server/utils/batch-store.ts`
- Create: `server/api/batch/create.post.ts`
- Create: `server/api/batch/list.get.ts`
- Create: `server/api/batch/detail.get.ts`
- Create: `server/api/batch/delete.post.ts`
- Test script: `$SCRATCH/e2e-batch-api.sh`

**Interfaces:**
- Consumes: `CreateBatchSchema`, `BatchRecord`, `BatchCodeStatus` (Task 1); existing auto-imported `putLink`, `getLink`, `deleteLink`, `nanoid`.
- Produces (auto-imported server utils): `batchKey(id): string` (`batch:<id>`), `getBatch(event, id): Promise<BatchRecord | null>`, `putBatch(event, batch): Promise<void>`, `deleteBatchRecord(event, id): Promise<void>`, `listBatches(event): Promise<BatchRecord[]>`.
- API responses: create → `{ batch: BatchRecord }` (201); list → `{ batches: BatchRecord[] }`; detail → `{ batch, codes: BatchCodeStatus[], claimedCount: number }`; delete → `{ success: true }`.

- [ ] **Step 1: Write the failing e2e script**

Write `$SCRATCH/e2e-batch-api.sh`:

```bash
#!/usr/bin/env bash
set -u
BASE=http://localhost:7465
AUTH="Authorization: Bearer devtoken12345"
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected '$2', got '$3')"; FAIL=1; fi; }

# --- create: redirect batch of 5 ---
R=$(curl -s -X POST "$BASE/api/batch/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"e2e vouchers","mode":"redirect","url":"https://example.com/","count":5}' -w "\n%{http_code}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
check "redirect batch created" "201" "$CODE"
BID=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['id'])")
SLUGS=$(echo "$BODY" | python3 -c "import sys,json;print(' '.join(json.load(sys.stdin)['batch']['slugs']))")
N=$(echo "$SLUGS" | wc -w | tr -d ' ')
check "5 slugs" "5" "$N"
# slugs random: no two share a 6-char prefix (sequential slugs would)
UNIQ=$(for s in $SLUGS; do echo "${s:0:6}"; done | sort -u | wc -l | tr -d ' ')
check "slugs non-sequential (unique prefixes)" "5" "$UNIQ"

# --- validation: redirect without url -> 400 ---
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/batch/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"bad","mode":"redirect","count":3}')
check "redirect without url rejected" "400" "$C"
# --- validation: count 101 -> 400 ---
C=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/batch/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"big","mode":"checkin","count":101}')
check "count>100 rejected" "400" "$C"

# --- create: checkin batch of 3, no url ---
R=$(curl -s -X POST "$BASE/api/batch/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"e2e tickets","mode":"checkin","count":3}' -w "\n%{http_code}")
CODE=$(echo "$R" | tail -1); BODY=$(echo "$R" | sed '$d')
check "checkin batch created (no url)" "201" "$CODE"
BID2=$(echo "$BODY" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['id'])")

# --- list contains both ---
L=$(curl -s "$BASE/api/batch/list" -H "$AUTH")
HAS=$(echo "$L" | python3 -c "
import sys,json
ids=[b['id'] for b in json.load(sys.stdin)['batches']]
print('yes' if '$BID' in ids and '$BID2' in ids else 'no')")
check "list has both batches" "yes" "$HAS"

# --- detail: 5 codes, 0 claimed, seq 1..5 ---
D=$(curl -s "$BASE/api/batch/detail?id=$BID" -H "$AUTH")
echo "$D" | python3 -c "
import sys,json
d=json.load(sys.stdin)
assert d['claimedCount']==0, d['claimedCount']
assert [c['seq'] for c in d['codes']]==[1,2,3,4,5]
assert all(not c['claimed'] and not c['missing'] for c in d['codes'])
print('detail-ok')" | grep -q detail-ok && echo "PASS: detail shape" || { echo "FAIL: detail shape"; FAIL=1; }

# --- detail 404 for unknown id ---
C=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/api/batch/detail?id=nonexistent1" -H "$AUTH")
check "detail 404 unknown" "404" "$C"

# --- delete batch 1: codes 404, record gone ---
curl -s -X POST "$BASE/api/batch/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"id\":\"$BID\"}" -o /dev/null
FIRST=$(echo "$SLUGS" | awk '{print $1}')
C=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$FIRST")
check "deleted code 404s" "404" "$C"
L=$(curl -s "$BASE/api/batch/list" -H "$AUTH")
HAS=$(echo "$L" | python3 -c "
import sys,json
ids=[b['id'] for b in json.load(sys.stdin)['batches']]
print('yes' if '$BID' in ids else 'no')")
check "deleted batch gone from list" "no" "$HAS"

# cleanup batch 2
curl -s -X POST "$BASE/api/batch/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"id\":\"$BID2\"}" -o /dev/null
[ "$FAIL" = "0" ] && echo "ALL PASS" || echo "FAILURES"
exit $FAIL
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash $SCRATCH/e2e-batch-api.sh`
Expected: `FAIL: redirect batch created (expected '201', got '404')` — endpoints don't exist. Exit 1.

- [ ] **Step 3: Create `server/utils/batch-store.ts`**

```ts
import type { BatchRecord } from '#shared/schemas/batch'
import type { H3Event } from 'h3'

export function batchKey(id: string): string {
  return `batch:${id}`
}

export async function getBatch(event: H3Event, id: string): Promise<BatchRecord | null> {
  const { KV } = event.context.cloudflare.env
  return await KV.get(batchKey(id), { type: 'json' }) as BatchRecord | null
}

export async function putBatch(event: H3Event, batch: BatchRecord): Promise<void> {
  const { KV } = event.context.cloudflare.env
  await KV.put(batchKey(batch.id), JSON.stringify(batch))
}

export async function deleteBatchRecord(event: H3Event, id: string): Promise<void> {
  const { KV } = event.context.cloudflare.env
  await KV.delete(batchKey(id))
}

export async function listBatches(event: H3Event): Promise<BatchRecord[]> {
  const { KV } = event.context.cloudflare.env
  const batches: BatchRecord[] = []
  let cursor: string | undefined
  do {
    const list = await KV.list({ prefix: 'batch:', limit: 1000, cursor })
    const values = await Promise.all(
      list.keys.map(async (key: { name: string }) =>
        await KV.get(key.name, { type: 'json' }) as BatchRecord | null),
    )
    batches.push(...values.filter((b): b is BatchRecord => b !== null))
    cursor = list.list_complete ? undefined : list.cursor
  } while (cursor)
  return batches.sort((a, b) => b.createdAt - a.createdAt)
}
```

- [ ] **Step 4: Create `server/api/batch/create.post.ts`**

```ts
import type { Link } from '#shared/schemas/link'
import type { BatchRecord } from '#shared/schemas/batch'
import { CreateBatchSchema } from '#shared/schemas/batch'
import { nanoid } from '#shared/schemas/link'
import pLimit from 'p-limit'

defineRouteMeta({
  openAPI: {
    description: 'Create a batch of single-use codes',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'mode', 'count'],
            properties: {
              name: { type: 'string', description: 'Batch name' },
              mode: { type: 'string', enum: ['redirect', 'checkin'], description: 'Redemption mode' },
              url: { type: 'string', description: 'Destination URL (required for redirect mode)' },
              count: { type: 'integer', description: 'Number of codes (1-100)' },
            },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event) => {
  const { previewMode } = useRuntimeConfig(event).public
  if (previewMode) {
    throw createError({ status: 403, statusText: 'Preview mode cannot create batches.' })
  }

  const body = await readValidatedBody(event, CreateBatchSchema.parse)
  const generate = nanoid(10)
  const id = generate()
  const now = Math.floor(Date.now() / 1000)
  const slugs = Array.from({ length: body.count }, () => generate())

  const limit = pLimit(10)
  await Promise.all(slugs.map((slug, i) => limit(async () => {
    const link: Link = {
      id: generate(),
      type: 'redirect',
      slug,
      createdAt: now,
      updatedAt: now,
      hitCount: 0,
      batchId: id,
      batchSeq: i + 1,
      batchMode: body.mode,
      ...(body.url ? { url: body.url } : {}),
      ...(body.mode === 'redirect' ? { maxHits: 1 } : {}),
    }
    await putLink(event, link)
  })))

  const batch: BatchRecord = {
    id,
    name: body.name,
    mode: body.mode,
    count: body.count,
    createdAt: now,
    slugs,
    ...(body.url ? { url: body.url } : {}),
  }
  await putBatch(event, batch)

  setResponseStatus(event, 201)
  return { batch }
})
```

- [ ] **Step 5: Create `server/api/batch/list.get.ts`**

```ts
defineRouteMeta({
  openAPI: {
    description: 'List all code batches',
    security: [{ bearerAuth: [] }],
  },
})

export default eventHandler(async (event) => {
  const batches = await listBatches(event)
  return { batches }
})
```

- [ ] **Step 6: Create `server/api/batch/detail.get.ts`**

```ts
import type { BatchCodeStatus } from '#shared/schemas/batch'
import pLimit from 'p-limit'
import { z } from 'zod'

const DetailQuerySchema = z.object({
  id: z.string().trim().min(1).max(26),
})

defineRouteMeta({
  openAPI: {
    description: 'Get a batch with per-code claimed status',
    security: [{ bearerAuth: [] }],
    parameters: [{ name: 'id', in: 'query', required: true, schema: { type: 'string' } }],
  },
})

export default eventHandler(async (event) => {
  const { id } = await getValidatedQuery(event, DetailQuerySchema.parse)
  const batch = await getBatch(event, id)
  if (!batch) {
    throw createError({ status: 404, statusText: 'Batch not found' })
  }

  const limit = pLimit(10)
  const codes: BatchCodeStatus[] = await Promise.all(batch.slugs.map((slug, i) => limit(async () => {
    const link = await getLink(event, slug)
    if (!link) {
      return { slug, seq: i + 1, missing: true, claimed: false, claimedAt: null, hitCount: 0 }
    }
    const claimed = link.batchMode === 'checkin'
      ? link.claimedAt != null
      : (link.hitCount ?? 0) >= (link.maxHits ?? Number.POSITIVE_INFINITY)
    return {
      slug,
      seq: i + 1,
      missing: false,
      claimed,
      claimedAt: link.claimedAt ?? null,
      hitCount: link.hitCount ?? 0,
    }
  })))

  return { batch, codes, claimedCount: codes.filter(c => c.claimed).length }
})
```

- [ ] **Step 7: Create `server/api/batch/delete.post.ts`**

```ts
import pLimit from 'p-limit'
import { z } from 'zod'

const DeleteBatchSchema = z.object({
  id: z.string().trim().min(1).max(26),
})

defineRouteMeta({
  openAPI: {
    description: 'Delete a batch and all of its codes',
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', description: 'Batch id' } },
          },
        },
      },
    },
  },
})

export default eventHandler(async (event) => {
  const { previewMode } = useRuntimeConfig(event).public
  if (previewMode) {
    throw createError({ status: 403, statusText: 'Preview mode cannot delete batches.' })
  }

  const { id } = await readValidatedBody(event, DeleteBatchSchema.parse)
  const batch = await getBatch(event, id)
  if (!batch) {
    throw createError({ status: 404, statusText: 'Batch not found' })
  }

  const limit = pLimit(10)
  await Promise.all(batch.slugs.map(slug => limit(() => deleteLink(event, slug))))
  await deleteBatchRecord(event, id)

  return { success: true }
})
```

- [ ] **Step 8: Run the e2e script to verify it passes**

Give the dev server ~5s to hot-reload, then:
Run: `bash $SCRATCH/e2e-batch-api.sh`
Expected: `ALL PASS`, exit 0. Do not weaken any assertion.

- [ ] **Step 9: Static checks + commit**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → clean.

```bash
git add server/utils/batch-store.ts server/api/batch/
git commit -m "feat: add batch store and batch CRUD API (#6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 3: Check-in middleware branch + redirect-mode regression

**Files:**
- Modify: `server/middleware/1.redirect.ts` (new render helper after `renderTextPage`, ~line 150; new branch before the `isTextLink` branch, ~line 270)
- Test script: `$SCRATCH/e2e-checkin.sh`

**Interfaces:**
- Consumes: `getBatch(event, id)` (Task 2), `Link.batchMode`/`claimedAt`/`batchSeq` (Task 1), existing `sendNoStoreHtml`, `escapeHtml`, `useAccessLog`, `putLink`.
- Produces: no exports — behavior only. GET on a check-in slug → status page; `POST checkin=true` → claim.

- [ ] **Step 1: Write the failing e2e script**

Write `$SCRATCH/e2e-checkin.sh`:

```bash
#!/usr/bin/env bash
set -u
BASE=http://localhost:7465
AUTH="Authorization: Bearer devtoken12345"
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected '$2', got '$3')"; FAIL=1; fi; }

# checkin batch of 2
R=$(curl -s -X POST "$BASE/api/batch/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"door tickets","mode":"checkin","count":2}')
BID=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['id'])")
S1=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['slugs'][0])")

# GET shows VALID, does not claim
P=$(curl -s "$BASE/$S1")
check "GET shows valid" "yes" "$(echo "$P" | grep -qi "valid" && echo yes || echo no)"
check "GET shows ticket seq" "yes" "$(echo "$P" | grep -q "#1" && echo yes || echo no)"
check "GET has check-in form" "yes" "$(echo "$P" | grep -q 'name="checkin"' && echo yes || echo no)"
# second GET still valid (no claim on GET)
P=$(curl -s "$BASE/$S1")
check "second GET still valid" "yes" "$(echo "$P" | grep -qi "valid" && echo yes || echo no)"
D=$(curl -s "$BASE/api/batch/detail?id=$BID" -H "$AUTH" | python3 -c "import sys,json;print(json.load(sys.stdin)['claimedCount'])")
check "claimedCount still 0 after GETs" "0" "$D"

# POST checkin=true claims
P=$(curl -s -X POST "$BASE/$S1" -d "checkin=true")
check "POST claims (checked in page)" "yes" "$(echo "$P" | grep -qi "checked in" && echo yes || echo no)"
D=$(curl -s "$BASE/api/batch/detail?id=$BID" -H "$AUTH" | python3 -c "import sys,json;print(json.load(sys.stdin)['claimedCount'])")
check "claimedCount 1 after claim" "1" "$D"

# GET now shows USED; second POST shows USED (no double-claim page)
P=$(curl -s "$BASE/$S1")
check "GET shows already used" "yes" "$(echo "$P" | grep -qi "already used" && echo yes || echo no)"
P=$(curl -s -X POST "$BASE/$S1" -d "checkin=true")
check "re-POST shows already used" "yes" "$(echo "$P" | grep -qi "already used" && echo yes || echo no)"

# reset un-claims
curl -s -X POST "$BASE/api/link/reset" -H "$AUTH" -H "Content-Type: application/json" -d "{\"slug\":\"$S1\"}" -o /dev/null
P=$(curl -s "$BASE/$S1")
check "reset un-claims (valid again)" "yes" "$(echo "$P" | grep -qi "valid" && echo yes || echo no)"

# redirect-mode regression: burn on first scan
R=$(curl -s -X POST "$BASE/api/batch/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"name":"vouchers","mode":"redirect","url":"https://example.com/","count":1}')
BID2=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['id'])")
S2=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['slugs'][0])")
C=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$S2")
check "voucher first scan redirects" "302" "$C"
C=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/$S2")
check "voucher second scan burned" "410" "$C"

# cleanup
curl -s -X POST "$BASE/api/batch/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"id\":\"$BID\"}" -o /dev/null
curl -s -X POST "$BASE/api/batch/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"id\":\"$BID2\"}" -o /dev/null
[ "$FAIL" = "0" ] && echo "ALL PASS" || echo "FAILURES"
exit $FAIL
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash $SCRATCH/e2e-checkin.sh`
Expected: check-in GET checks fail (a check-in code currently falls through to the redirect path and 500s or redirects — either way "GET shows valid" FAILs). The redirect-mode regression checks already pass. Exit 1.

- [ ] **Step 3: Add the render helper**

In `server/middleware/1.redirect.ts`, directly after the closing brace of `renderTextPage(...)` and before `function isTextLink(...)`, add:

```ts
type CheckinState = 'valid' | 'used' | 'claimed-now'

function renderCheckinPage(link: Link, batchName: string, state: CheckinState): string {
  const seq = link.batchSeq ?? 0
  const title = escapeHtml(batchName || 'Ticket')
  const usedTime = link.claimedAt
    ? new Date(link.claimedAt * 1000).toISOString().replace('T', ' ').slice(0, 16)
    : ''

  let statusHtml = ''
  if (state === 'valid') {
    statusHtml = `
    <div class="mark ok">✓</div>
    <h1>VALID</h1>
    <p class="meta">${title} · Ticket #${seq}</p>
    <form method="POST">
      <input type="hidden" name="checkin" value="true">
      <button type="submit">Check in</button>
    </form>`
  }
  else if (state === 'claimed-now') {
    statusHtml = `
    <div class="mark ok">✓</div>
    <h1>Checked in</h1>
    <p class="meta">${title} · Ticket #${seq}</p>`
  }
  else {
    statusHtml = `
    <div class="mark bad">✕</div>
    <h1>ALREADY USED</h1>
    <p class="meta">${title} · Ticket #${seq}${usedTime ? ` · ${usedTime} UTC` : ''}</p>`
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · Ticket #${seq}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      background: #fafafa; color: #1a1a1a;
    }
    @media (prefers-color-scheme: dark) { body { background: #1a1a1a; color: #e5e5e5; } }
    .card { text-align: center; padding: 2rem; }
    .mark { font-size: 4rem; line-height: 1; margin-bottom: 0.5rem; }
    .ok { color: #16a34a; }
    .bad { color: #dc2626; }
    h1 { font-size: 2em; margin-bottom: 0.25em; }
    .meta { color: #6b7280; margin-bottom: 1.5rem; }
    button {
      font-size: 1.25rem; font-weight: 600; padding: 0.9rem 3rem; border: none;
      border-radius: 0.75rem; background: #16a34a; color: white; cursor: pointer;
    }
    button:active { background: #15803d; }
  </style>
</head>
<body>
  <div class="card">${statusHtml}</div>
</body>
</html>`
}
```

- [ ] **Step 4: Add the middleware branch**

Find the text-link branch:

```ts
      // Text links render their content instead of redirecting.
      if (isTextLink(link)) {
```

Insert this block immediately BEFORE it:

```ts
      // Check-in batch codes: GET renders a read-only status page; the
      // confirm-button POST (checkin=true) claims with an awaited write.
      if (link.batchMode === 'checkin') {
        event.context.link = link
        try {
          await useAccessLog(event)
        }
        catch (error) {
          console.error('Failed write access log:', error)
        }

        const batch = link.batchId ? await getBatch(event, link.batchId) : null
        const batchName = batch?.name ?? ''

        if (event.method === 'POST') {
          const body = await readBody(event).catch(() => null)
          if (body?.checkin === 'true') {
            if (link.claimedAt)
              return sendNoStoreHtml(renderCheckinPage(link, batchName, 'used'))
            const claimedLink: Link = { ...link, claimedAt: now }
            await putLink(event, claimedLink)
            return sendNoStoreHtml(renderCheckinPage(claimedLink, batchName, 'claimed-now'))
          }
        }

        return sendNoStoreHtml(renderCheckinPage(link, batchName, link.claimedAt ? 'used' : 'valid'))
      }
```

Note: `now` already exists in scope (declared for the hit-limit block above); `getBatch` is auto-imported from Task 2's util.

- [ ] **Step 5: Run the e2e to verify it passes**

Run: `bash $SCRATCH/e2e-checkin.sh` (after ~5s hot-reload).
Expected: `ALL PASS`, exit 0.

- [ ] **Step 6: Static checks + commit**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → clean.

```bash
git add server/middleware/1.redirect.ts
git commit -m "feat: check-in status page and confirm-button claiming (#6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 4: i18n — batches dashboard strings (all 10 locales)

**Files:**
- Modify: all of `i18n/locales/{en-US,de-DE,fr-FR,id-ID,it-IT,pt-BR,pt-PT,vi-VN,zh-CN,zh-TW}.json` via script
- Script: `$SCRATCH/i18n_batches.py`

**Interfaces:**
- Produces the keys Tasks 5–6 reference: `nav.batches` (under the top-level `nav` object) and a new top-level `batches` object with keys: `title, create, name, name_placeholder, mode, mode_redirect, mode_checkin, mode_redirect_short, mode_checkin_short, destination, destination_placeholder, count, create_success, create_failed, claimed, empty, delete, delete_confirm_title, delete_confirm_desc, delete_success, print_sheet, download_zip, status_valid, status_claimed, status_missing, back, load_failed`.

- [ ] **Step 1: Write the injection script**

Write `$SCRATCH/i18n_batches.py` (complete file):

```python
import json

BASE = "/home/ubuntu/repos/Sink/.claude/worktrees/6-batch-single-use-codes/i18n/locales"
ALL = ["en-US", "de-DE", "fr-FR", "id-ID", "it-IT", "pt-BR", "pt-PT", "vi-VN", "zh-CN", "zh-TW"]

nav = {
    "batches": {
        "en-US": "Batches", "de-DE": "Stapel", "fr-FR": "Lots", "id-ID": "Batch",
        "it-IT": "Lotti", "pt-BR": "Lotes", "pt-PT": "Lotes", "vi-VN": "Lô mã",
        "zh-CN": "批量码", "zh-TW": "批量碼",
    },
}

batches = {
    "title": {"en-US": "Code Batches", "de-DE": "Code-Stapel", "fr-FR": "Lots de codes", "id-ID": "Batch kode", "it-IT": "Lotti di codici", "pt-BR": "Lotes de códigos", "pt-PT": "Lotes de códigos", "vi-VN": "Lô mã", "zh-CN": "批量码", "zh-TW": "批量碼"},
    "create": {"en-US": "Create Batch", "de-DE": "Stapel erstellen", "fr-FR": "Créer un lot", "id-ID": "Buat batch", "it-IT": "Crea lotto", "pt-BR": "Criar lote", "pt-PT": "Criar lote", "vi-VN": "Tạo lô", "zh-CN": "创建批量", "zh-TW": "建立批量"},
    "name": {"en-US": "Name", "de-DE": "Name", "fr-FR": "Nom", "id-ID": "Nama", "it-IT": "Nome", "pt-BR": "Nome", "pt-PT": "Nome", "vi-VN": "Tên", "zh-CN": "名称", "zh-TW": "名稱"},
    "name_placeholder": {"en-US": "Event tickets, drink vouchers…", "de-DE": "Event-Tickets, Getränkegutscheine…", "fr-FR": "Billets d'événement, bons de boisson…", "id-ID": "Tiket acara, voucher minuman…", "it-IT": "Biglietti evento, buoni bevande…", "pt-BR": "Ingressos, vouchers de bebida…", "pt-PT": "Bilhetes, vouchers de bebida…", "vi-VN": "Vé sự kiện, phiếu đồ uống…", "zh-CN": "活动门票、饮品券……", "zh-TW": "活動門票、飲品券……"},
    "mode": {"en-US": "Mode", "de-DE": "Modus", "fr-FR": "Mode", "id-ID": "Mode", "it-IT": "Modalità", "pt-BR": "Modo", "pt-PT": "Modo", "vi-VN": "Chế độ", "zh-CN": "模式", "zh-TW": "模式"},
    "mode_redirect": {"en-US": "Voucher (redirect, burns on first scan)", "de-DE": "Gutschein (Weiterleitung, verfällt beim ersten Scan)", "fr-FR": "Bon (redirection, brûlé au premier scan)", "id-ID": "Voucher (pengalihan, hangus saat pemindaian pertama)", "it-IT": "Buono (reindirizza, si esaurisce alla prima scansione)", "pt-BR": "Voucher (redireciona, expira no primeiro escaneio)", "pt-PT": "Voucher (redireciona, expira na primeira leitura)", "vi-VN": "Phiếu (chuyển hướng, hết hạn sau lần quét đầu)", "zh-CN": "优惠券（跳转，首次扫码后失效）", "zh-TW": "優惠券（跳轉，首次掃碼後失效）"},
    "mode_checkin": {"en-US": "Ticket (check-in page with confirm button)", "de-DE": "Ticket (Check-in-Seite mit Bestätigungsknopf)", "fr-FR": "Billet (page d'enregistrement avec bouton de confirmation)", "id-ID": "Tiket (halaman check-in dengan tombol konfirmasi)", "it-IT": "Biglietto (pagina check-in con pulsante di conferma)", "pt-BR": "Ingresso (página de check-in com botão de confirmação)", "pt-PT": "Bilhete (página de check-in com botão de confirmação)", "vi-VN": "Vé (trang check-in với nút xác nhận)", "zh-CN": "门票（签到页面 + 确认按钮）", "zh-TW": "門票（簽到頁面 + 確認按鈕）"},
    "mode_redirect_short": {"en-US": "Voucher", "de-DE": "Gutschein", "fr-FR": "Bon", "id-ID": "Voucher", "it-IT": "Buono", "pt-BR": "Voucher", "pt-PT": "Voucher", "vi-VN": "Phiếu", "zh-CN": "优惠券", "zh-TW": "優惠券"},
    "mode_checkin_short": {"en-US": "Ticket", "de-DE": "Ticket", "fr-FR": "Billet", "id-ID": "Tiket", "it-IT": "Biglietto", "pt-BR": "Ingresso", "pt-PT": "Bilhete", "vi-VN": "Vé", "zh-CN": "门票", "zh-TW": "門票"},
    "destination": {"en-US": "Destination URL", "de-DE": "Ziel-URL", "fr-FR": "URL de destination", "id-ID": "URL tujuan", "it-IT": "URL di destinazione", "pt-BR": "URL de destino", "pt-PT": "URL de destino", "vi-VN": "URL đích", "zh-CN": "目标 URL", "zh-TW": "目標 URL"},
    "destination_placeholder": {"en-US": "https://example.com (optional for tickets)", "de-DE": "https://example.com (optional für Tickets)", "fr-FR": "https://example.com (facultatif pour les billets)", "id-ID": "https://example.com (opsional untuk tiket)", "it-IT": "https://example.com (facoltativo per i biglietti)", "pt-BR": "https://example.com (opcional para ingressos)", "pt-PT": "https://example.com (opcional para bilhetes)", "vi-VN": "https://example.com (tùy chọn cho vé)", "zh-CN": "https://example.com（门票可留空）", "zh-TW": "https://example.com（門票可留空）"},
    "count": {"en-US": "Number of codes (1-100)", "de-DE": "Anzahl der Codes (1-100)", "fr-FR": "Nombre de codes (1-100)", "id-ID": "Jumlah kode (1-100)", "it-IT": "Numero di codici (1-100)", "pt-BR": "Quantidade de códigos (1-100)", "pt-PT": "Quantidade de códigos (1-100)", "vi-VN": "Số lượng mã (1-100)", "zh-CN": "码数量（1-100）", "zh-TW": "碼數量（1-100）"},
    "create_success": {"en-US": "Batch created", "de-DE": "Stapel erstellt", "fr-FR": "Lot créé", "id-ID": "Batch dibuat", "it-IT": "Lotto creato", "pt-BR": "Lote criado", "pt-PT": "Lote criado", "vi-VN": "Đã tạo lô", "zh-CN": "批量已创建", "zh-TW": "批量已建立"},
    "create_failed": {"en-US": "Failed to create batch", "de-DE": "Stapel konnte nicht erstellt werden", "fr-FR": "Échec de la création du lot", "id-ID": "Gagal membuat batch", "it-IT": "Creazione del lotto non riuscita", "pt-BR": "Falha ao criar lote", "pt-PT": "Falha ao criar lote", "vi-VN": "Tạo lô thất bại", "zh-CN": "批量创建失败", "zh-TW": "批量建立失敗"},
    "claimed": {"en-US": "claimed", "de-DE": "eingelöst", "fr-FR": "utilisés", "id-ID": "diklaim", "it-IT": "riscattati", "pt-BR": "usados", "pt-PT": "usados", "vi-VN": "đã dùng", "zh-CN": "已使用", "zh-TW": "已使用"},
    "empty": {"en-US": "No batches yet. Create one to generate single-use codes.", "de-DE": "Noch keine Stapel. Erstelle einen, um Einmal-Codes zu generieren.", "fr-FR": "Aucun lot. Créez-en un pour générer des codes à usage unique.", "id-ID": "Belum ada batch. Buat satu untuk menghasilkan kode sekali pakai.", "it-IT": "Nessun lotto. Creane uno per generare codici monouso.", "pt-BR": "Nenhum lote ainda. Crie um para gerar códigos de uso único.", "pt-PT": "Ainda sem lotes. Crie um para gerar códigos de utilização única.", "vi-VN": "Chưa có lô nào. Tạo một lô để sinh mã dùng một lần.", "zh-CN": "还没有批量。创建一个以生成一次性码。", "zh-TW": "還沒有批量。建立一個以產生一次性碼。"},
    "delete": {"en-US": "Delete batch", "de-DE": "Stapel löschen", "fr-FR": "Supprimer le lot", "id-ID": "Hapus batch", "it-IT": "Elimina lotto", "pt-BR": "Excluir lote", "pt-PT": "Eliminar lote", "vi-VN": "Xóa lô", "zh-CN": "删除批量", "zh-TW": "刪除批量"},
    "delete_confirm_title": {"en-US": "Delete this batch?", "de-DE": "Diesen Stapel löschen?", "fr-FR": "Supprimer ce lot ?", "id-ID": "Hapus batch ini?", "it-IT": "Eliminare questo lotto?", "pt-BR": "Excluir este lote?", "pt-PT": "Eliminar este lote?", "vi-VN": "Xóa lô này?", "zh-CN": "确定删除此批量？", "zh-TW": "確定刪除此批量？"},
    "delete_confirm_desc": {"en-US": "All codes in this batch will be deleted and stop working. This cannot be undone.", "de-DE": "Alle Codes dieses Stapels werden gelöscht und funktionieren nicht mehr. Dies kann nicht rückgängig gemacht werden.", "fr-FR": "Tous les codes de ce lot seront supprimés et cesseront de fonctionner. Cette action est irréversible.", "id-ID": "Semua kode dalam batch ini akan dihapus dan berhenti berfungsi. Tindakan ini tidak dapat dibatalkan.", "it-IT": "Tutti i codici di questo lotto verranno eliminati e smetteranno di funzionare. Operazione irreversibile.", "pt-BR": "Todos os códigos deste lote serão excluídos e deixarão de funcionar. Isso não pode ser desfeito.", "pt-PT": "Todos os códigos deste lote serão eliminados e deixarão de funcionar. Esta ação é irreversível.", "vi-VN": "Tất cả mã trong lô sẽ bị xóa và ngừng hoạt động. Không thể hoàn tác.", "zh-CN": "此批量中的所有码将被删除并失效。此操作无法撤销。", "zh-TW": "此批量中的所有碼將被刪除並失效。此操作無法復原。"},
    "delete_success": {"en-US": "Batch deleted", "de-DE": "Stapel gelöscht", "fr-FR": "Lot supprimé", "id-ID": "Batch dihapus", "it-IT": "Lotto eliminato", "pt-BR": "Lote excluído", "pt-PT": "Lote eliminado", "vi-VN": "Đã xóa lô", "zh-CN": "批量已删除", "zh-TW": "批量已刪除"},
    "print_sheet": {"en-US": "Print sheet", "de-DE": "Druckbogen", "fr-FR": "Feuille à imprimer", "id-ID": "Lembar cetak", "it-IT": "Foglio di stampa", "pt-BR": "Folha para impressão", "pt-PT": "Folha para impressão", "vi-VN": "In trang mã", "zh-CN": "打印页", "zh-TW": "列印頁"},
    "download_zip": {"en-US": "Download ZIP", "de-DE": "ZIP herunterladen", "fr-FR": "Télécharger le ZIP", "id-ID": "Unduh ZIP", "it-IT": "Scarica ZIP", "pt-BR": "Baixar ZIP", "pt-PT": "Transferir ZIP", "vi-VN": "Tải ZIP", "zh-CN": "下载 ZIP", "zh-TW": "下載 ZIP"},
    "status_valid": {"en-US": "Unclaimed", "de-DE": "Offen", "fr-FR": "Non utilisé", "id-ID": "Belum diklaim", "it-IT": "Non riscattato", "pt-BR": "Não usado", "pt-PT": "Não usado", "vi-VN": "Chưa dùng", "zh-CN": "未使用", "zh-TW": "未使用"},
    "status_claimed": {"en-US": "Claimed", "de-DE": "Eingelöst", "fr-FR": "Utilisé", "id-ID": "Diklaim", "it-IT": "Riscattato", "pt-BR": "Usado", "pt-PT": "Usado", "vi-VN": "Đã dùng", "zh-CN": "已使用", "zh-TW": "已使用"},
    "status_missing": {"en-US": "Missing", "de-DE": "Fehlt", "fr-FR": "Manquant", "id-ID": "Hilang", "it-IT": "Mancante", "pt-BR": "Ausente", "pt-PT": "Em falta", "vi-VN": "Thiếu", "zh-CN": "缺失", "zh-TW": "缺失"},
    "back": {"en-US": "Back to batches", "de-DE": "Zurück zu den Stapeln", "fr-FR": "Retour aux lots", "id-ID": "Kembali ke batch", "it-IT": "Torna ai lotti", "pt-BR": "Voltar aos lotes", "pt-PT": "Voltar aos lotes", "vi-VN": "Về danh sách lô", "zh-CN": "返回批量列表", "zh-TW": "返回批量列表"},
    "load_failed": {"en-US": "Failed to load", "de-DE": "Laden fehlgeschlagen", "fr-FR": "Échec du chargement", "id-ID": "Gagal memuat", "it-IT": "Caricamento non riuscito", "pt-BR": "Falha ao carregar", "pt-PT": "Falha ao carregar", "vi-VN": "Tải thất bại", "zh-CN": "加载失败", "zh-TW": "載入失敗"},
}

missing = []
for loc in ALL:
    path = f"{BASE}/{loc}.json"
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    d.setdefault("nav", {}).setdefault("batches", nav["batches"][loc])
    b = d.setdefault("batches", {})
    for k, tr in batches.items():
        b.setdefault(k, tr[loc])
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"updated {loc}")

for loc in ALL:
    with open(f"{BASE}/{loc}.json", encoding="utf-8") as f:
        d = json.load(f)
    if "batches" not in d["nav"] and "batches" not in d.get("nav", {}):
        missing.append(f"{loc}: nav.batches")
    for k in batches:
        if k not in d["batches"]:
            missing.append(f"{loc}: batches.{k}")
print("MISSING:", missing if missing else "none — ALL KEYS PRESENT")
```

- [ ] **Step 2: Run it**

Run: `python3 $SCRATCH/i18n_batches.py`
Expected: `updated <locale>` ×10, `MISSING: none — ALL KEYS PRESENT`.

- [ ] **Step 3: Sanity check + commit**

Run: `git diff --stat i18n/ | tail -1` → 10 files changed.
Run: `python3 -c "import json; d=json.load(open('i18n/locales/de-DE.json')); print(d['nav']['batches'], '|', d['batches']['status_claimed'])"` → `Stapel | Eingelöst`.

```bash
git add i18n/locales/
git commit -m "feat: add batches i18n strings to all locales (#6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 5: Dashboard — nav, batches page, list, create dialog, detail grid, links-page filter

**Files:**
- Modify: `layers/dashboard/app/composables/dashboard.ts` (routes registry, ~line 12; lucide import line 3)
- Modify: `layers/dashboard/app/components/dashboard/sidebar/AppSidebar.vue` (platformItems, ~line 12)
- Create: `layers/dashboard/app/pages/dashboard/batches.vue`
- Create: `layers/dashboard/app/components/dashboard/batches/Index.vue`
- Create: `layers/dashboard/app/components/dashboard/batches/Create.vue`
- Create: `layers/dashboard/app/components/dashboard/batches/Detail.vue`
- Modify: `layers/dashboard/app/components/dashboard/links/Index.vue` (line ~78, batch filter)

**Interfaces:**
- Consumes: `/api/batch/*` endpoints (Task 2), i18n keys (Task 4), `BatchRecord`/`BatchCodeStatus` types (Task 1), existing `useAPI`, `shortDate`, `ResponsiveModal`, `AlertDialog*`, `Badge`, `Button`, `Input`, shadcn components (auto-imported).
- Produces: `/dashboard/batches` page; `DashboardBatchesIndex/Create/Detail` components. Task 6 adds the Print/ZIP actions into `Detail.vue`'s header (a `<div id="batch-actions">`-free approach: Task 6 edits Detail.vue directly at an anchor named below).

- [ ] **Step 1: Register the route**

In `layers/dashboard/app/composables/dashboard.ts`, change the lucide import line:

```ts
import { Activity, ChartArea, FolderSync, Link, ScanSearch } from 'lucide-vue-next'
```

to:

```ts
import { Activity, ChartArea, FolderSync, Link, ScanSearch, Tickets } from 'lucide-vue-next'
```

and add to `DASHBOARD_ROUTES` after the `link:` entry:

```ts
  batches: {
    paths: ['/dashboard/batches'],
    titleKey: 'nav.batches',
    icon: Tickets,
  },
```

- [ ] **Step 2: Sidebar entry**

In `AppSidebar.vue`, add to `platformItems` after the `links` item:

```ts
  {
    title: 'nav.batches',
    url: '/dashboard/batches',
    icon: DASHBOARD_ROUTES.batches.icon,
    isActive: isActive('batches'),
  },
```

- [ ] **Step 3: Create `layers/dashboard/app/pages/dashboard/batches.vue`**

```vue
<script setup lang="ts">
definePageMeta({
  layout: 'dashboard',
})

const route = useRoute()
const batchId = computed(() => typeof route.query.id === 'string' ? route.query.id : '')
</script>

<template>
  <main class="space-y-6">
    <Teleport to="#dashboard-header-actions" defer>
      <DashboardBatchesCreate v-if="!batchId" />
    </Teleport>

    <DashboardBatchesDetail v-if="batchId" :batch-id="batchId" />
    <DashboardBatchesIndex v-else />
  </main>
</template>
```

- [ ] **Step 4: Create `layers/dashboard/app/components/dashboard/batches/Index.vue`**

```vue
<script setup lang="ts">
import type { BatchRecord } from '#shared/schemas/batch'
import { Tickets } from 'lucide-vue-next'

const { locale } = useI18n()

const batches = ref<BatchRecord[]>([])
const claimedCounts = ref<Record<string, number>>({})
const loading = ref(true)
const error = ref(false)

async function loadBatches() {
  loading.value = true
  error.value = false
  try {
    const data = await useAPI<{ batches: BatchRecord[] }>('/api/batch/list')
    batches.value = data.batches
    data.batches.forEach(async (batch) => {
      try {
        const detail = await useAPI<{ claimedCount: number }>('/api/batch/detail', { query: { id: batch.id } })
        claimedCounts.value[batch.id] = detail.claimedCount
      }
      catch (e) {
        console.error(e)
      }
    })
  }
  catch (e) {
    console.error(e)
    error.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(loadBatches)
</script>

<template>
  <div>
    <div v-if="loading" class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <Skeleton v-for="i in 3" :key="i" class="h-28 rounded-xl" />
    </div>
    <p v-else-if="error" class="text-center text-sm text-muted-foreground">
      {{ $t('batches.load_failed') }}
    </p>
    <p v-else-if="batches.length === 0" class="text-center text-sm text-muted-foreground">
      {{ $t('batches.empty') }}
    </p>
    <div v-else class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <NuxtLink
        v-for="batch in batches"
        :key="batch.id"
        :to="{ path: '/dashboard/batches', query: { id: batch.id } }"
      >
        <Card class="h-full transition-colors hover:bg-accent/50">
          <CardContent class="space-y-2">
            <div class="flex items-center gap-2">
              <Tickets class="h-5 w-5 shrink-0" aria-hidden="true" />
              <span class="truncate font-bold">{{ batch.name }}</span>
              <Badge variant="secondary" class="ml-auto shrink-0">
                {{ batch.mode === 'checkin' ? $t('batches.mode_checkin_short') : $t('batches.mode_redirect_short') }}
              </Badge>
            </div>
            <div class="text-sm text-muted-foreground">
              {{ shortDate(batch.createdAt, locale) }}
            </div>
            <div class="text-sm">
              <template v-if="claimedCounts[batch.id] !== undefined">
                {{ claimedCounts[batch.id] }}/{{ batch.count }} {{ $t('batches.claimed') }}
              </template>
              <Skeleton v-else class="h-4 w-24" />
            </div>
          </CardContent>
        </Card>
      </NuxtLink>
    </div>
  </div>
</template>
```

- [ ] **Step 5: Create `layers/dashboard/app/components/dashboard/batches/Create.vue`**

```vue
<script setup lang="ts">
import type { BatchRecord } from '#shared/schemas/batch'
import { toast } from 'vue-sonner'

const { t } = useI18n()
const dialogOpen = ref(false)
const submitting = ref(false)

const name = ref('')
const mode = ref<'redirect' | 'checkin'>('redirect')
const url = ref('')
const count = ref<number | undefined>(undefined)

const valid = computed(() => {
  if (!name.value.trim())
    return false
  const n = count.value ?? 0
  if (n < 1 || n > 100)
    return false
  if (mode.value === 'redirect' && !url.value.trim())
    return false
  return true
})

async function submit() {
  if (!valid.value || submitting.value)
    return
  submitting.value = true
  try {
    const { batch } = await useAPI<{ batch: BatchRecord }>('/api/batch/create', {
      method: 'POST',
      body: {
        name: name.value.trim(),
        mode: mode.value,
        url: url.value.trim() || undefined,
        count: count.value,
      },
    })
    toast(t('batches.create_success'))
    dialogOpen.value = false
    name.value = ''
    url.value = ''
    count.value = undefined
    await navigateTo({ path: '/dashboard/batches', query: { id: batch.id } })
  }
  catch (error) {
    console.error(error)
    toast.error(t('batches.create_failed'), {
      description: error instanceof Error ? error.message : String(error),
    })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <ResponsiveModal v-model:open="dialogOpen" :title="t('batches.create')">
    <template #trigger>
      <Button class="md:ml-2" variant="outline">
        {{ $t('batches.create') }}
      </Button>
    </template>

    <div class="space-y-4 px-1">
      <div class="space-y-1.5">
        <Label for="batch-name">{{ $t('batches.name') }}</Label>
        <Input id="batch-name" v-model="name" :placeholder="$t('batches.name_placeholder')" autocomplete="off" />
      </div>

      <div class="space-y-1.5">
        <Label>{{ $t('batches.mode') }}</Label>
        <div class="grid gap-2">
          <Button type="button" :variant="mode === 'redirect' ? 'default' : 'outline'" size="sm" @click="mode = 'redirect'">
            {{ $t('batches.mode_redirect') }}
          </Button>
          <Button type="button" :variant="mode === 'checkin' ? 'default' : 'outline'" size="sm" @click="mode = 'checkin'">
            {{ $t('batches.mode_checkin') }}
          </Button>
        </div>
      </div>

      <div class="space-y-1.5">
        <Label for="batch-url">{{ $t('batches.destination') }}</Label>
        <Input id="batch-url" v-model="url" :placeholder="$t('batches.destination_placeholder')" autocomplete="url" />
      </div>

      <div class="space-y-1.5">
        <Label for="batch-count">{{ $t('batches.count') }}</Label>
        <Input
          id="batch-count"
          type="number"
          min="1"
          max="100"
          :model-value="count"
          @input="count = ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <template #footer>
      <Button type="button" variant="secondary" @click="dialogOpen = false">
        {{ $t('common.close') }}
      </Button>
      <Button type="button" :disabled="!valid || submitting" @click="submit">
        {{ $t('common.save') }}
      </Button>
    </template>
  </ResponsiveModal>
</template>
```

- [ ] **Step 6: Create `layers/dashboard/app/components/dashboard/batches/Detail.vue`**

```vue
<script setup lang="ts">
import type { BatchCodeStatus, BatchRecord } from '#shared/schemas/batch'
import { ArrowLeft, Copy, Eraser, RotateCcw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

const props = defineProps<{
  batchId: string
}>()

const { t, locale } = useI18n()
const requestUrl = useRequestURL()

const batch = ref<BatchRecord | null>(null)
const codes = ref<BatchCodeStatus[]>([])
const claimedCount = ref(0)
const loading = ref(true)
const error = ref(false)

async function loadDetail() {
  loading.value = true
  error.value = false
  try {
    const data = await useAPI<{ batch: BatchRecord, codes: BatchCodeStatus[], claimedCount: number }>('/api/batch/detail', {
      query: { id: props.batchId },
    })
    batch.value = data.batch
    codes.value = data.codes
    claimedCount.value = data.claimedCount
  }
  catch (e) {
    console.error(e)
    error.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(loadDetail)

function shortLink(slug: string) {
  return `${requestUrl.origin}/${slug}`
}

async function copyLink(slug: string) {
  await navigator.clipboard.writeText(shortLink(slug))
  toast(t('links.copy_success'))
}

async function resetCode(slug: string) {
  try {
    await useAPI('/api/link/reset', { method: 'POST', body: { slug } })
    toast(t('links.reset_success'))
    await loadDetail()
  }
  catch (e) {
    console.error(e)
    toast.error(t('links.reset_failed'))
  }
}

async function deleteBatch() {
  try {
    await useAPI('/api/batch/delete', { method: 'POST', body: { id: props.batchId } })
    toast(t('batches.delete_success'))
    await navigateTo('/dashboard/batches')
  }
  catch (e) {
    console.error(e)
    toast.error(t('batches.load_failed'))
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <NuxtLink to="/dashboard/batches" class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft class="h-4 w-4" aria-hidden="true" /> {{ $t('batches.back') }}
      </NuxtLink>
    </div>

    <div v-if="loading">
      <Skeleton class="h-24 rounded-xl" />
    </div>
    <p v-else-if="error || !batch" class="text-center text-sm text-muted-foreground">
      {{ $t('batches.load_failed') }}
    </p>
    <template v-else>
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-xl font-bold">
          {{ batch.name }}
        </h2>
        <Badge variant="secondary">
          {{ claimedCount }}/{{ batch.count }} {{ $t('batches.claimed') }}
        </Badge>
        <span class="text-sm text-muted-foreground">{{ shortDate(batch.createdAt, locale) }}</span>
        <div class="ml-auto flex items-center gap-2">
          <!-- batch-actions -->
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button variant="destructive" size="sm">
                <Eraser class="mr-1 h-4 w-4" aria-hidden="true" /> {{ $t('batches.delete') }}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{{ $t('batches.delete_confirm_title') }}</AlertDialogTitle>
                <AlertDialogDescription>{{ $t('batches.delete_confirm_desc') }}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{{ $t('common.cancel') }}</AlertDialogCancel>
                <AlertDialogAction @click="deleteBatch">
                  {{ $t('common.continue') }}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div class="overflow-x-auto rounded-xl border">
        <table class="w-full text-sm">
          <tbody>
            <tr v-for="code in codes" :key="code.slug" class="border-b last:border-b-0">
              <td class="w-12 px-3 py-2 text-muted-foreground">
                #{{ code.seq }}
              </td>
              <td class="px-3 py-2 font-mono">
                {{ code.slug }}
              </td>
              <td class="px-3 py-2">
                <Badge v-if="code.missing" variant="outline">
                  {{ $t('batches.status_missing') }}
                </Badge>
                <Badge v-else-if="code.claimed" variant="destructive">
                  {{ $t('batches.status_claimed') }}
                  <template v-if="code.claimedAt">
                    · {{ shortDate(code.claimedAt, locale) }}
                  </template>
                </Badge>
                <Badge v-else variant="secondary">
                  {{ $t('batches.status_valid') }}
                </Badge>
              </td>
              <td class="w-24 px-3 py-2 text-right whitespace-nowrap">
                <Button v-if="!code.missing" variant="ghost" size="icon" class="h-7 w-7" aria-label="Copy link" @click="copyLink(code.slug)">
                  <Copy class="h-4 w-4" />
                </Button>
                <Button v-if="code.claimed && !code.missing" variant="ghost" size="icon" class="h-7 w-7" aria-label="Reset code" @click="resetCode(code.slug)">
                  <RotateCcw class="h-4 w-4" />
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
```

(The `<!-- batch-actions -->` comment is the anchor where Task 6 inserts the Print/ZIP buttons.)

- [ ] **Step 7: Hide batch codes from the main links list**

In `layers/dashboard/app/components/dashboard/links/Index.vue`, find (~line 78):

```ts
    const newLinks = data.links.filter(Boolean)
```

Replace with:

```ts
    const newLinks = data.links.filter((l): l is Link => Boolean(l) && !l.batchId)
```

- [ ] **Step 8: Static checks + API round-trip**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → clean.

Dev-server sanity (list filter):

```bash
AUTH="Authorization: Bearer devtoken12345"; BASE=http://localhost:7465
R=$(curl -s -X POST "$BASE/api/batch/create" -H "$AUTH" -H "Content-Type: application/json" -d '{"name":"ui-check","mode":"checkin","count":2}')
BID=$(echo "$R" | python3 -c "import sys,json;print(json.load(sys.stdin)['batch']['id'])")
curl -s "$BASE/api/link/list?limit=100" -H "$AUTH" | python3 -c "
import sys,json
links=[l for l in json.load(sys.stdin)['links'] if l]
batch=[l for l in links if l.get('batchId')]
print('batch links in raw list (client filters them):', len(batch))"
curl -s -X POST "$BASE/api/batch/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"id\":\"$BID\"}" -o /dev/null
```

Expected: raw list still contains the batch links (server unchanged — the filter is client-side; the browser check happens in Task 7's walkthrough).

- [ ] **Step 9: Commit**

```bash
git add layers/dashboard/app/composables/dashboard.ts layers/dashboard/app/components/dashboard/sidebar/AppSidebar.vue layers/dashboard/app/pages/dashboard/batches.vue layers/dashboard/app/components/dashboard/batches/ layers/dashboard/app/components/dashboard/links/Index.vue
git commit -m "feat: batches dashboard page with create, detail, and reset (#6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 6: Print sheet + ZIP export

**Files:**
- Modify: `package.json` (add `client-zip`)
- Create: `layers/dashboard/app/pages/dashboard/batches/print.vue`
- Create: `layers/dashboard/app/composables/useBatchQr.ts`
- Modify: `layers/dashboard/app/components/dashboard/batches/Detail.vue` (insert actions at the `<!-- batch-actions -->` anchor)

**Interfaces:**
- Consumes: `/api/batch/detail` (Task 2), `qr-code-styling` (existing dep), `BatchCodeStatus` (Task 1).
- Produces: `useBatchQr()` composable exporting `qrPngBlob(data: string, size?: number): Promise<Blob>`; route `/dashboard/batches/print?id=<batchId>`; Print/ZIP buttons in Detail.

- [ ] **Step 1: Add the dependency**

In `package.json` dependencies, after the `"marked"` line style — insert alphabetically:

```json
    "client-zip": "^2.4.5",
```

Run: `CI=true pnpm install` → lockfile updates.

- [ ] **Step 2: Create `layers/dashboard/app/composables/useBatchQr.ts`**

```ts
import QRCodeStyling from 'qr-code-styling'

export function useBatchQr() {
  async function qrPngBlob(data: string, size = 512): Promise<Blob> {
    const qr = new QRCodeStyling({
      width: size,
      height: size,
      data,
      margin: 8,
      dotsOptions: { type: 'square', color: '#000000' },
      backgroundOptions: { color: '#ffffff' },
    })
    const raw = await qr.getRawData('png')
    if (!raw)
      throw new Error('QR generation failed')
    return raw as Blob
  }

  return { qrPngBlob }
}
```

- [ ] **Step 3: Create `layers/dashboard/app/pages/dashboard/batches/print.vue`**

```vue
<script setup lang="ts">
import type { BatchCodeStatus, BatchRecord } from '#shared/schemas/batch'

definePageMeta({
  layout: false,
})

const route = useRoute()
const requestUrl = useRequestURL()
const { qrPngBlob } = useBatchQr()

const batch = ref<BatchRecord | null>(null)
const codes = ref<BatchCodeStatus[]>([])
const qrUrls = ref<Record<string, string>>({})
const ready = ref(false)

onMounted(async () => {
  const id = typeof route.query.id === 'string' ? route.query.id : ''
  if (!id)
    return
  const data = await useAPI<{ batch: BatchRecord, codes: BatchCodeStatus[] }>('/api/batch/detail', { query: { id } })
  batch.value = data.batch
  codes.value = data.codes
  for (const code of data.codes) {
    const blob = await qrPngBlob(`${requestUrl.origin}/${code.slug}`, 256)
    qrUrls.value[code.slug] = URL.createObjectURL(blob)
  }
  ready.value = true
})
</script>

<template>
  <div class="mx-auto max-w-5xl bg-white p-6 text-black">
    <div class="mb-4 flex items-center justify-between print:hidden">
      <h1 class="text-xl font-bold">
        {{ batch?.name }}
      </h1>
      <button
        class="rounded-lg border px-4 py-2 text-sm font-medium"
        :disabled="!ready"
        @click="typeof window !== 'undefined' && window.print()"
      >
        🖨 Print
      </button>
    </div>

    <div class="grid grid-cols-3 gap-6">
      <div
        v-for="code in codes"
        :key="code.slug"
        class="break-inside-avoid rounded-lg border p-3 text-center"
      >
        <img
          v-if="qrUrls[code.slug]"
          :src="qrUrls[code.slug]"
          :alt="`QR code ${code.seq}`"
          class="mx-auto aspect-square w-full max-w-44"
        >
        <div class="mt-1 text-sm font-bold">
          #{{ code.seq }}
        </div>
        <div class="font-mono text-[10px] break-all">
          {{ requestUrl.origin }}/{{ code.slug }}
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@media print {
  body { background: white; }
}
</style>
```

- [ ] **Step 4: Add Print + ZIP buttons to Detail.vue**

In `layers/dashboard/app/components/dashboard/batches/Detail.vue`, add to the script section (after `deleteBatch`):

```ts
const zipping = ref(false)
const { qrPngBlob } = useBatchQr()

async function downloadZip() {
  if (!batch.value || zipping.value)
    return
  zipping.value = true
  try {
    const { downloadZip: makeZip } = await import('client-zip')
    const files = await Promise.all(codes.value.filter(c => !c.missing).map(async code => ({
      name: `${String(code.seq).padStart(3, '0')}-${code.slug}.png`,
      input: await qrPngBlob(shortLink(code.slug)),
    })))
    const blob = await makeZip(files).blob()
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${batch.value.name.replace(/[^\w-]+/g, '-')}-codes.zip`
    a.click()
    URL.revokeObjectURL(a.href)
  }
  catch (e) {
    console.error(e)
    toast.error(t('batches.load_failed'))
  }
  finally {
    zipping.value = false
  }
}
```

Add `Download, Printer` to the existing lucide import in the same file:

```ts
import { ArrowLeft, Copy, Download, Eraser, Printer, RotateCcw } from 'lucide-vue-next'
```

Replace the `<!-- batch-actions -->` comment in the template with:

```vue
          <NuxtLink :to="{ path: '/dashboard/batches/print', query: { id: batchId } }" target="_blank">
            <Button variant="outline" size="sm">
              <Printer class="mr-1 h-4 w-4" aria-hidden="true" /> {{ $t('batches.print_sheet') }}
            </Button>
          </NuxtLink>
          <Button variant="outline" size="sm" :disabled="zipping" @click="downloadZip">
            <Download class="mr-1 h-4 w-4" aria-hidden="true" /> {{ $t('batches.download_zip') }}
          </Button>
```

- [ ] **Step 5: Static checks + commit**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → clean.

```bash
git add package.json pnpm-lock.yaml layers/dashboard/app/pages/dashboard/batches/print.vue layers/dashboard/app/composables/useBatchQr.ts layers/dashboard/app/components/dashboard/batches/Detail.vue
git commit -m "feat: printable QR sheet and PNG zip export for batches (#6)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 7: Full gates, browser walkthrough, push branch, create PR

**Files:**
- Create: `$SCRATCH/ui-walk-batches.mjs` (scratch only)
- Create: `~/.cache/claude-pr/worktree-6-batch-single-use-codes.md` (PR text, outside repo)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: pushed branch + PR with `Closes #6`. **Do NOT merge; do NOT push master; do NOT deploy.**

- [ ] **Step 1: Full static + build gate**

```bash
CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"   # expect empty
pnpm lint                                                                 # expect 0 errors
pnpm build                                                                # NO CI=true! expect exit 0
```

- [ ] **Step 2: Re-run both e2e suites**

```bash
bash $SCRATCH/e2e-batch-api.sh   # expect ALL PASS
bash $SCRATCH/e2e-checkin.sh     # expect ALL PASS
```

- [ ] **Step 3: Browser walkthrough**

Playwright-core is installed at
`/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/uitest/node_modules`
with chromium at `/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome`.

Write `$SCRATCH/ui-walk-batches.mjs`:

```js
import { createRequire } from 'node:module'
const require = createRequire('/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/uitest/package.json')
const { chromium } = require('playwright-core')

const EXE = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux/chrome'
const BASE = 'http://localhost:7465'
const SHOT = '/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/batch-tests'

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 1280, height: 1400 } })).newPage()
try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.evaluate(t => localStorage.setItem('SinkSiteToken', t), 'devtoken12345')

  // 1. Batches page via sidebar route
  await page.goto(BASE + '/dashboard/batches', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${SHOT}/b1-batches-empty-or-list.png` })

  // 2. Create a check-in batch of 4 through the dialog
  await page.getByRole('button', { name: /Create Batch/i }).first().click()
  await page.waitForTimeout(800)
  await page.locator('#batch-name').fill('Walkthrough tickets')
  await page.getByRole('button', { name: /Ticket \(check-in/i }).click()
  await page.locator('#batch-count').fill('4')
  await page.screenshot({ path: `${SHOT}/b2-create-dialog.png` })
  await page.getByRole('button', { name: /^Save$/ }).click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${SHOT}/b3-detail.png`, fullPage: true })

  const rows = await page.locator('table tbody tr').count()
  const unclaimed = await page.getByText('Unclaimed', { exact: true }).count()
  console.log('detail rows:', rows, '| unclaimed badges:', unclaimed)

  // 3. Print sheet renders QRs
  const url = page.url()
  const id = new URL(url).searchParams.get('id')
  await page.goto(`${BASE}/dashboard/batches/print?id=${id}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(3500)
  const imgs = await page.locator('img[alt^="QR code"]').count()
  console.log('print sheet QR images:', imgs)
  await page.screenshot({ path: `${SHOT}/b4-print-sheet.png`, fullPage: true })

  // 4. Links page does NOT show batch codes
  await page.goto(BASE + '/dashboard/links', { waitUntil: 'networkidle' })
  await page.waitForTimeout(2000)
  const batchCards = await page.getByText('Walkthrough tickets').count()
  console.log('batch content on links page (expect 0):', batchCards)

  console.log('CLEANUP_ID=' + id)
  console.log(rows === 4 && unclaimed === 4 && imgs === 4 && batchCards === 0 ? 'UI_WALK_OK' : 'UI_WALK_FAIL')
}
catch (e) {
  console.log('UI_WALK_ERROR:', e.message)
  await page.screenshot({ path: `${SHOT}/b9-error.png`, fullPage: true }).catch(() => {})
}
finally {
  await browser.close()
}
```

Run: `node $SCRATCH/ui-walk-batches.mjs`
Expected: `detail rows: 4 | unclaimed badges: 4`, `print sheet QR images: 4`, `batch content on links page (expect 0): 0`, `UI_WALK_OK`.
**Open and LOOK at all four screenshots** — the detail grid must show rows/badges, the print sheet must show 4 rendered QR codes in a grid. Blank frames = failure.
Then clean up: `curl -s -X POST http://localhost:7465/api/batch/delete -H "Authorization: Bearer devtoken12345" -H "Content-Type: application/json" -d '{"id":"<CLEANUP_ID value>"}'`.

- [ ] **Step 4: Push the branch and create the PR**

```bash
git push -u origin worktree-6-batch-single-use-codes
mkdir -p ~/.cache/claude-pr
cat > ~/.cache/claude-pr/worktree-6-batch-single-use-codes.md <<'EOF'
feat: batch single-use codes (tickets/vouchers)

## What

Create batches of 1-100 unique single-use QR codes from the dashboard:

- **Voucher mode (redirect):** first scan redirects and burns the code (`maxHits: 1`); later scans get the expired page.
- **Ticket mode (check-in):** scanning shows a VALID / ALREADY USED status page; a confirm button (POST) marks it used — GETs never claim, so guest curiosity and link previews can't burn tickets.
- New **Batches** dashboard page: create dialog, claimed/unclaimed grid with per-code copy + reset, printable QR sheet, PNG ZIP export, batch delete.
- Code slugs are random (nanoid), never sequential.
- Batch codes are hidden from the main links list.

## Implementation

- 4 new optional `LinkSchema` fields (`batchId`, `batchSeq`, `batchMode`, `claimedAt`); one `batch:<id>` KV record per batch. Claim state is per-code — no shared-key contention at the door.
- 4 new endpoints under `/api/batch/`; per-code ops reuse existing link endpoints (Reset now also clears `claimedAt`).
- One middleware branch for check-in pages (same form-POST pattern as the password page).
- i18n for all 10 locales. Only new dependency: `client-zip`.

Verified with dev-server e2e suites (batch CRUD lifecycle; check-in GET/POST semantics; redirect burn; reset un-claim) and a browser walkthrough with screenshots.

Closes #6

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
EOF
F=~/.cache/claude-pr/worktree-6-batch-single-use-codes.md
gh pr create -R bmichaelis/Sink --base master --head worktree-6-batch-single-use-codes \
  --title "$(head -n 1 "$F")" --body "$(tail -n +3 "$F")"
```

Expected: PR URL printed. Report it; the user decides when to merge.

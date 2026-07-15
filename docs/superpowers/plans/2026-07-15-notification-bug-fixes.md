# Notification Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two scan-notification bugs — social link-preview fetchers (WhatsApp/Facebook/etc.) firing false push notifications (#1), and stale `notify:<slug>` KV state surviving `notifyUrl` removal plus transient read errors being mistaken for corruption (#2).

**Architecture:** Extract the middleware's `SOCIAL_BOTS` list into a shared auto-imported util and consult it in the notification bot check; delete notify state on the `notifyUrl` set→unset transition in the edit endpoint; read notify state as text and parse explicitly so a read error preserves state while only corrupt JSON self-heals.

**Tech Stack:** Nuxt 4 (layers) + Nitro on Cloudflare Workers, Workers KV, TypeScript.

**Spec:** `docs/superpowers/specs/2026-07-15-notification-bug-fixes-design.md`
**Issues:** #1 and #2 — the PR body must contain `Closes #1` and `Closes #2`.

## Global Constraints

- Work in the worktree `/home/ubuntu/repos/Sink/.claude/worktrees/1-2-notification-fixes` on branch `worktree-1-2-notification-fixes`. **Before EVERY git commit run `git rev-parse --show-toplevel` and confirm it prints that worktree path** — if it prints `/home/ubuntu/repos/Sink`, STOP (wrong checkout). Never `cd /home/ubuntu/repos/Sink`. Never commit or push master. Ships as a PR.
- Package manager is **pnpm**. **NEVER build or run dev with `CI=true`** (breaks the cloudflare-module preset; `CI=true` is fine for `pnpm types:check` and `pnpm install`).
- Fresh worktree: run `CI=true pnpm install` first (no `node_modules` yet).
- Dev server (start once, background; needs the account id for local bindings in a fresh worktree, and 302 to match prod):
  `CLOUDFLARE_ACCOUNT_ID=3fec0e6981622dd93b3889f06ed9532b NUXT_SITE_TOKEN=devtoken12345 NUXT_REDIRECT_STATUS_CODE=302 pnpm dev` → `http://localhost:7465`. First boot ~90s. If it's down mid-task, report BLOCKED — don't restart it yourself.
- e2e scripts talk to real `ntfy.sh` over the internet with random topics; delivery is verified via ntfy's poll API (`curl "https://ntfy.sh/<topic>/json?poll=1"`). If ntfy.sh itself is unreachable (network, not code), report BLOCKED — never weaken an assertion.
- `$SCRATCH` = `/tmp/claude-1001/-home-ubuntu-repos-Sink/cad5bc97-64e6-467e-87a9-d077dbedbaec/scratchpad/notif-fix-tests` — `export SCRATCH=...` and `mkdir -p "$SCRATCH"` at the top of every shell session.
- Server utils in `server/utils/` are **auto-imported** across server code — no import statements needed for functions defined there.
- Style: 2-space indent, single quotes, no semicolons (`@antfu/eslint-config`; a `lint-staged` pre-commit hook runs `eslint --fix` — its output is normal). Never edit `app/components/ui/**`.
- Every commit message references the issues and ends with:
  ```
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
  ```
- Known pre-existing failure to IGNORE (present on clean master): `types:check` errors in `layers/dashboard/app/components/dashboard/links/Search.vue`. Any OTHER type error is yours.

---

### Task 1: Suppress social unfurl bots in scan notifications (#1)

**Files:**
- Create: `server/utils/bots.ts`
- Modify: `server/middleware/1.redirect.ts` (remove local `SOCIAL_BOTS` const ~line 221 and `isSocialBot` fn ~line 241)
- Modify: `server/utils/scan-notify.ts` (`isBotScan`, ~line 18)
- Test script: `$SCRATCH/e2e-bot-suppress.sh`

**Interfaces:**
- Produces (auto-imported): `SOCIAL_BOTS: string[]` and `isSocialBot(userAgent: string): boolean` in `server/utils/bots.ts`.
- Consumes: existing `BOT_UA_MARKERS` and `isBotScan` in `scan-notify.ts`.

- [ ] **Step 1: Write the failing e2e script**

Write `$SCRATCH/e2e-bot-suppress.sh`:

```bash
#!/usr/bin/env bash
set -u
BASE=http://localhost:7465
AUTH="Authorization: Bearer devtoken12345"
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected '$2', got '$3')"; FAIL=1; fi; }

msgs() { # count messages on a topic
  curl -s "https://ntfy.sh/$1/json?poll=1" | python3 -c '
import sys, json
n = 0
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    if json.loads(line).get("event") == "message": n += 1
print(n)'
}
lastmsg() {
  curl -s "https://ntfy.sh/$1/json?poll=1" | python3 -c '
import sys, json
last = ""
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    if d.get("event") == "message": last = d.get("message", "")
print(last)'
}

TOPIC="sink-bot-$RANDOM$RANDOM"
SLUG="bot-suppress-$RANDOM"
curl -s -X POST "$BASE/api/link/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://example.com/\",\"slug\":\"$SLUG\",\"notifyUrl\":\"https://ntfy.sh/$TOPIC\",\"notifyCooldownMinutes\":0}" -o /dev/null

# social bot scans must NOT notify
curl -s -o /dev/null -H "User-Agent: facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)" "$BASE/$SLUG"
curl -s -o /dev/null -H "User-Agent: WhatsApp/2.23.20.0" "$BASE/$SLUG"
sleep 3
check "no push from social bots" "0" "$(msgs "$TOPIC")"

# a real human scan DOES notify, and reports total 1 (proving the bots never counted)
curl -s -o /dev/null -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1" "$BASE/$SLUG"
sleep 3
check "human scan notifies" "1" "$(msgs "$TOPIC")"
check "human scan total is 1 (bots uncounted)" "yes" "$(lastmsg "$TOPIC" | grep -q '1 scan since last ping · 1 total' && echo yes || echo no)"

curl -s -X POST "$BASE/api/link/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"slug\":\"$SLUG\"}" -o /dev/null
[ "$FAIL" = "0" ] && echo "ALL PASS" || echo "FAILURES"
exit $FAIL
```

- [ ] **Step 2: Run to verify it fails**

Ensure the dev server is up (`until curl -s -o /dev/null -w "%{http_code}" http://localhost:7465/ | grep -qE "200|30."; do sleep 5; done`), then:
Run: `bash $SCRATCH/e2e-bot-suppress.sh`
Expected: `FAIL: no push from social bots (expected '0', got '2')` — WhatsApp/Facebook currently notify. Exit 1.

- [ ] **Step 3: Create `server/utils/bots.ts`**

Move the list and helper out of the middleware verbatim:

```ts
// Social link-preview fetchers (unfurl bots). Shared by the OG-preview
// middleware and the scan-notification bot filter.
export const SOCIAL_BOTS = [
  'applebot',
  'discordbot',
  'facebot',
  'facebookexternalhit',
  'linkedinbot',
  'linkexpanding',
  'mastodon',
  'skypeuripreview',
  'slackbot',
  'slackbot-linkexpanding',
  'snapchat',
  'telegrambot',
  'tiktok',
  'twitterbot',
  'whatsapp',
]

export function isSocialBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  return SOCIAL_BOTS.some(bot => ua.includes(bot))
}
```

- [ ] **Step 4: Remove the local copies from the middleware**

In `server/middleware/1.redirect.ts`, delete the local `SOCIAL_BOTS` array declaration:

```ts
const SOCIAL_BOTS = [
  'applebot',
  'discordbot',
  'facebot',
  'facebookexternalhit',
  'linkedinbot',
  'linkexpanding',
  'mastodon',
  'skypeuripreview',
  'slackbot',
  'slackbot-linkexpanding',
  'snapchat',
  'telegrambot',
  'tiktok',
  'twitterbot',
  'whatsapp',
]
```

and delete the local `isSocialBot` function:

```ts
function isSocialBot(userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  return SOCIAL_BOTS.some(bot => ua.includes(bot))
}
```

Leave the call site `if (isSocialBot(userAgent) && hasOgConfig(link))` untouched — it now resolves to the auto-imported `isSocialBot` from `server/utils/bots.ts`.

- [ ] **Step 5: Consult the social list in `isBotScan`**

In `server/utils/scan-notify.ts`, replace the `isBotScan` body's final line:

```ts
  const ua = (getHeader(event, 'user-agent') || '').toLowerCase()
  return BOT_UA_MARKERS.some(marker => ua.includes(marker))
```

with:

```ts
  const ua = (getHeader(event, 'user-agent') || '').toLowerCase()
  return BOT_UA_MARKERS.some(marker => ua.includes(marker)) || isSocialBot(ua)
```

(`isSocialBot` is auto-imported; it re-lowercases, which is harmless.)

- [ ] **Step 6: Run the e2e to verify it passes**

Wait ~5s for hot-reload, then:
Run: `bash $SCRATCH/e2e-bot-suppress.sh`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 7: Static checks + commit**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → 0 errors.

Confirm `git rev-parse --show-toplevel` prints the worktree path, then:

```bash
git add server/utils/bots.ts server/middleware/1.redirect.ts server/utils/scan-notify.ts
git commit -m "fix: suppress social unfurl bots in scan notifications (#1)

Share the middleware's SOCIAL_BOTS list via server/utils/bots.ts and
consult it in the notification bot filter, so WhatsApp/Facebook/etc.
link-preview fetches no longer fire false scan pushes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 2: Delete stale notify state on removal + distinguish read errors from corruption (#2)

**Files:**
- Modify: `server/utils/scan-notify.ts` (add `deleteNotifyState` export; change the state read in `sendScanNotification`, ~line 157)
- Modify: `server/api/link/edit.put.ts` (~line 63, after `mergeEditableLink`)
- Test script: `$SCRATCH/e2e-notify-state.sh`

**Interfaces:**
- Consumes: `notifyStateKey(slug)`, `NotifyState` (existing in scan-notify.ts); `deleteLink`/`getLink` conventions.
- Produces (auto-imported): `deleteNotifyState(event: H3Event, slug: string): Promise<void>`.

- [ ] **Step 1: Write the failing e2e script**

Write `$SCRATCH/e2e-notify-state.sh`:

```bash
#!/usr/bin/env bash
set -u
BASE=http://localhost:7465
AUTH="Authorization: Bearer devtoken12345"
UA="User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1"
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS: $1"; else echo "FAIL: $1 (expected '$2', got '$3')"; FAIL=1; fi; }
lastmsg() {
  curl -s "https://ntfy.sh/$1/json?poll=1" | python3 -c '
import sys, json
last = ""
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    if d.get("event") == "message": last = d.get("message", "")
print(last)'
}

SLUG="notif-state-$RANDOM"
T1="sink-state-a-$RANDOM$RANDOM"
T2="sink-state-b-$RANDOM$RANDOM"

# create with notifyUrl (cooldown 0), scan once -> total 1 on topic A
curl -s -X POST "$BASE/api/link/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://example.com/\",\"slug\":\"$SLUG\",\"notifyUrl\":\"https://ntfy.sh/$T1\",\"notifyCooldownMinutes\":0}" -o /dev/null
curl -s -o /dev/null -H "$UA" "$BASE/$SLUG"; sleep 3
check "initial scan total 1" "yes" "$(lastmsg "$T1" | grep -q '· 1 total' && echo yes || echo no)"

# edit to REMOVE notifyUrl (state should be deleted)
curl -s -X PUT "$BASE/api/link/edit" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"slug\":\"$SLUG\",\"url\":\"https://example.com/\"}" -o /dev/null
# re-ADD notifyUrl pointing at a fresh topic B
curl -s -X PUT "$BASE/api/link/edit" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"slug\":\"$SLUG\",\"url\":\"https://example.com/\",\"notifyUrl\":\"https://ntfy.sh/$T2\",\"notifyCooldownMinutes\":0}" -o /dev/null
# scan -> must be a FRESH total 1 (not resurrected 2), on topic B
curl -s -o /dev/null -H "$UA" "$BASE/$SLUG"; sleep 3
check "after remove+readd, total resets to 1" "yes" "$(lastmsg "$T2" | grep -q '1 scan since last ping · 1 total' && echo yes || echo no)"

# regression: batching/counting still works (two rapid scans within cooldown 5 -> one push, count 2)
SLUG2="notif-batch-$RANDOM"; T3="sink-state-c-$RANDOM$RANDOM"
curl -s -X POST "$BASE/api/link/create" -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"url\":\"https://example.com/\",\"slug\":\"$SLUG2\",\"notifyUrl\":\"https://ntfy.sh/$T3\",\"notifyCooldownMinutes\":5}" -o /dev/null
curl -s -o /dev/null -H "$UA" "$BASE/$SLUG2"; curl -s -o /dev/null -H "$UA" "$BASE/$SLUG2"; sleep 3
N=$(curl -s "https://ntfy.sh/$T3/json?poll=1" | python3 -c 'import sys,json;print(sum(1 for l in sys.stdin if l.strip() and json.loads(l).get("event")=="message"))')
check "regression: 2 scans in cooldown = 1 push" "1" "$N"

curl -s -X POST "$BASE/api/link/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"slug\":\"$SLUG\"}" -o /dev/null
curl -s -X POST "$BASE/api/link/delete" -H "$AUTH" -H "Content-Type: application/json" -d "{\"slug\":\"$SLUG2\"}" -o /dev/null
[ "$FAIL" = "0" ] && echo "ALL PASS" || echo "FAILURES"
exit $FAIL
```

- [ ] **Step 2: Run to verify it fails**

Run: `bash $SCRATCH/e2e-notify-state.sh`
Expected: `FAIL: after remove+readd, total resets to 1` — the stale state resurrects `total: 2`, so the message reads "· 2 total". Exit 1. (The other two checks already pass.)

- [ ] **Step 3: Add `deleteNotifyState` to `scan-notify.ts`**

Directly after the `notifyStateKey` function in `server/utils/scan-notify.ts`, add:

```ts
export async function deleteNotifyState(event: H3Event, slug: string): Promise<void> {
  const { KV } = event.context.cloudflare.env
  await KV.delete(notifyStateKey(slug))
}
```

- [ ] **Step 4: Delete state on the set→unset transition in the edit endpoint**

In `server/api/link/edit.put.ts`, the handler currently ends:

```ts
  const newLink = mergeEditableLink(existingLink, link)
  await applyEditableLinkPassword(newLink, link.password)

  await putLink(event, newLink)
  setResponseStatus(event, 201)
  return buildLinkResponse(event, newLink)
```

Change to:

```ts
  const newLink = mergeEditableLink(existingLink, link)
  await applyEditableLinkPassword(newLink, link.password)

  // Removing a notify URL should clear its accumulated notification state,
  // so re-enabling later starts fresh instead of resurrecting an old total.
  if (existingLink.notifyUrl && !newLink.notifyUrl)
    await deleteNotifyState(event, newLink.slug)

  await putLink(event, newLink)
  setResponseStatus(event, 201)
  return buildLinkResponse(event, newLink)
```

(`deleteNotifyState` is auto-imported.)

- [ ] **Step 5: Split read error from corruption in `sendScanNotification`**

In `server/utils/scan-notify.ts`, replace the single state-read line:

```ts
    const raw = await KV.get(key, { type: 'json' }).catch(() => null) as Partial<NotifyState> | null
```

with:

```ts
    // Read as text and parse explicitly: a transient KV read error throws and
    // is caught by the outer try/catch (skipping this notification without
    // mutating state), while only genuinely corrupt JSON self-heals to zeros.
    const rawText = await KV.get(key, { type: 'text' })
    let raw: Partial<NotifyState> | null = null
    if (rawText) {
      try {
        raw = JSON.parse(rawText) as Partial<NotifyState>
      }
      catch {
        raw = null
      }
    }
```

The subsequent `Number(raw?.lastNotifiedAt) || 0` / `pending` / `total` lines are unchanged.

- [ ] **Step 6: Run the e2e to verify it passes**

Wait ~5s for hot-reload, then:
Run: `bash $SCRATCH/e2e-notify-state.sh`
Expected: `ALL PASS`, exit 0.

- [ ] **Step 7: Static checks + commit**

`CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"` → empty; `pnpm lint:fix && pnpm lint` → 0 errors.

Confirm `git rev-parse --show-toplevel` prints the worktree path, then:

```bash
git add server/utils/scan-notify.ts server/api/link/edit.put.ts
git commit -m "fix: clear notify state on URL removal, don't reset on read error (#2)

Delete notify:<slug> when a link's notifyUrl is removed via edit, and
read notify state as text + parse explicitly so a transient KV read
error preserves lifetime counters (only corrupt JSON self-heals).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE"
```

---

### Task 3: Full gates + push branch + PR

**Files:**
- Create: `~/.cache/claude-pr/worktree-1-2-notification-fixes.md` (PR text, outside the repo)
- No repo files modified unless a gate fails.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: pushed branch + PR with `Closes #1` / `Closes #2`. **Do NOT merge; do NOT push master; do NOT deploy.**

- [ ] **Step 1: Full static + build gate**

```bash
CI=true pnpm types:check 2>&1 | grep "error TS" | grep -v "Search.vue"   # expect empty
pnpm lint                                                                 # expect 0 errors
pnpm build                                                                # NO CI=true! expect exit 0
```

- [ ] **Step 2: Re-run both e2e suites**

```bash
bash $SCRATCH/e2e-bot-suppress.sh   # expect ALL PASS
bash $SCRATCH/e2e-notify-state.sh   # expect ALL PASS
```

- [ ] **Step 3: Push the branch and open the PR**

Confirm `git rev-parse --show-toplevel` prints the worktree path, then:

```bash
git push -u origin worktree-1-2-notification-fixes
mkdir -p ~/.cache/claude-pr
cat > ~/.cache/claude-pr/worktree-1-2-notification-fixes.md <<'EOF'
fix: scan-notification bug fixes (social unfurl bots, stale notify state)

## What

Two contained fixes to the scan-notifications feature, both flagged by its final whole-branch review:

- **#1 — social unfurl bots.** WhatsApp/Facebook/TikTok/etc. link-preview fetches no longer fire a false "someone scanned your link" push. The middleware's `SOCIAL_BOTS` list moved to a shared `server/utils/bots.ts` and is now consulted by the notification bot filter (previously only `bot`/`crawler`/`spider`/`preview` markers were checked).
- **#2 — stale notify state.** Removing a link's `notifyUrl` via edit now deletes its `notify:<slug>` KV state, so re-enabling later starts fresh instead of resurrecting an old total and firing an immediate push. Notify state is also read as text and parsed explicitly, so a transient KV read error preserves lifetime counters while only genuinely corrupt JSON self-heals to zero.

## Testing

Dev-server e2e against real ntfy.sh topics: social-bot UAs produce no push and no counter increment while a real Safari scan still notifies; remove+re-add `notifyUrl` yields a fresh "1 total"; cooldown batching still works (regression). Plus types/lint/build gates.

Closes #1
Closes #2

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_015P4j4jPVr74UfW1GW795FE
EOF
F=~/.cache/claude-pr/worktree-1-2-notification-fixes.md
gh pr create -R bmichaelis/Sink --base master --head worktree-1-2-notification-fixes \
  --title "$(head -n 1 "$F")" --body "$(tail -n +3 "$F")"
```

Expected: PR URL printed. Report it; the user decides when to merge (merging auto-deploys via the CI workflow on master).

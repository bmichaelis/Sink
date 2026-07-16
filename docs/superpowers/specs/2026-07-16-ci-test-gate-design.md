# CI Test Gate — Design

**Date:** 2026-07-16
**Status:** Approved by default — see "Decisions made without you"
**Issue:** #17

## Purpose

`deploy.yml` installs, builds, guards the preset, and deploys — it never runs
the test suite. So nothing tests this repo on the way to production; the tests
only run when someone remembers, locally. This session alone, that gap let a
rotted 301/302 assertion sit undetected for weeks and let two feature branches
conflict across 17 files with nothing to catch it. This makes the tests run in
CI and gate deploys.

## The two blockers (both real, both solved here)

Getting the vitest pool to run in CI has been the whole obstacle. Verified fixes:

1. **The `ai` binding stops the pool from starting.** Workers AI has no local
   emulation, so its `"remote": true` binding makes `@cloudflare/vitest-pool-workers`
   open a *remote proxy session* that needs Cloudflare API credentials — and when
   they're absent every binding (including KV) comes back `undefined` and every
   test fails confusingly. **Fix:** `vitest.config.ts` generates a test-only
   config from `wrangler.jsonc` with the `ai` block stripped, and points the pool
   at that. No test touches AI. `wrangler.jsonc` stays the single source of truth
   for every other binding; the generated file is git-ignored. *(Bonus: this also
   removes the manual "edit wrangler.jsonc before testing" dance locally.)*

2. **`stats.spec.ts` and `logs.spec.ts` need real Analytics Engine credentials.**
   Those endpoints query the Cloudflare Analytics Engine SQL API (`useWAE`), which
   is a live external call — unmockable without a refactor and impossible to run
   hermetically. They fail (22 tests) on `master` today, unrelated to any change.
   **Fix:** the CI gate excludes those two specs. They remain runnable locally
   with credentials. Making them CI-testable (inject AE creds as secrets, or mock
   `useWAE`) is deliberately out of scope and noted as follow-up.

## Architecture

`vitest.config.ts` change (the linchpin, already validated):

```ts
// Strip the AI binding into a generated, git-ignored test config so the pool
// starts without Cloudflare credentials. wrangler.jsonc is untouched.
const testConfigPath = './.wrangler.test.jsonc'
writeFileSync(testConfigPath, readFileSync('./wrangler.jsonc', 'utf8').replace(/\n\s*"ai":\s*\{[^}]*\},/, ''))
// ...poolOptions.workers.wrangler.configPath = testConfigPath
```

A `test:ci` script excludes the AE-dependent specs (kept out of the config's
default excludes so local `pnpm vitest` still runs everything):

```json
"test:ci": "vitest run --exclude '**/stats.spec.ts' --exclude '**/logs.spec.ts'"
```

`deploy.yml` becomes two jobs:

```
test    (on push, pull_request, workflow_dispatch)
  install → build (NITRO_PRESET=cloudflare-module) → preset guard
    → write .env with a test NUXT_SITE_TOKEN → pnpm test:ci
deploy  (needs: test; only on push to master)
  install → build → preset guard → wrangler deploy
```

The pool's `SELF.fetch` runs the **built** worker (`.output/server/index.mjs`),
so the test job must build before testing — which also exercises the exact
artifact that ships. The preset guard moves into the shared path so both jobs
assert it.

## Decisions made without you

The owner asked for #20 then #17 back-to-back, not reviewing between. Each is
cheap to change:

| Decision | Why | If you disagree |
| --- | --- | --- |
| **Strip `ai` via a generated test config**, not a hand-maintained `wrangler.test.jsonc` | One source of truth (wrangler.jsonc); every other binding auto-syncs; zero drift | Commit a static test config instead |
| **Exclude stats/logs from the gate** | They need live Analytics Engine; unmockable without a refactor; already red on master | Add AE secrets to CI and run them, or mock `useWAE` (bigger change) |
| **Run tests on PRs too, not just pre-deploy** | The near-misses this session (merge conflicts, rotted assertions) would have been caught on the PR, not after merge | Gate deploys only — drop the `pull_request` trigger |
| **Two jobs, deploy `needs: test`, accept a double build** | Clean, readable, each job self-contained; no artifact plumbing | Share `.output` via an artifact to build once |
| **Test `NUXT_SITE_TOKEN` written to `.env` in-workflow** | Mirrors local; the value only needs to be self-consistent (worker + auth header read the same var) | Inject via `test.env` from `process.env` |
| **Node 22, pnpm, `--frozen-lockfile`** | Matches the existing deploy job exactly | — |

## Testing / verification

CI changes can't be fully exercised locally (GitHub Actions runs remotely), so
verification is layered:

1. **The linchpin is proven locally:** with the `vitest.config.ts` change,
   `pnpm build` then `pnpm vitest run` starts the pool with **no** manual
   `wrangler.jsonc` edit, `wrangler.jsonc` shows no diff, and the generated
   `.wrangler.test.jsonc` has the `ai` block removed but keeps KV/R2/ANALYTICS/vars.
   (Verified: 21/21 redirect specs pass this way.)
2. **The gate scope is proven locally:** `pnpm test:ci` (excluding stats/logs)
   passes fully (129/129 on this branch).
3. **Workflow YAML** is validated for syntax (`yq`/`python` parse) and reviewed by
   eye against the existing job; the actual run is confirmed after the PR opens by
   watching the `test` job on the PR itself — the first real proof the gate works
   end to end, reported back before merge.
4. `.wrangler.test.jsonc` is git-ignored and never committed.

## Non-goals (YAGNI)

- Making `stats.spec.ts`/`logs.spec.ts` pass in CI (needs AE creds or a `useWAE`
  mock — a separate issue).
- Adding `types:check`/`lint` as gates (worth doing, but `types:check` has
  pre-existing `Search.vue` errors that must be fixed first — its own issue).
- Caching the build between the test and deploy jobs.
- Coverage reporting, test sharding, or matrix runs.

One PR to `master`, body contains `Closes #17`.

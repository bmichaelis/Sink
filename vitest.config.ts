import { readFileSync, writeFileSync } from 'node:fs'
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
import { loadEnv } from 'vite'

// Workers AI has no local emulation, so its `remote: true` binding makes the
// test pool open a remote proxy session that needs Cloudflare API credentials
// the test runner shouldn't require. No test touches AI, so tests run against a
// generated copy of wrangler.jsonc with the `ai` block stripped. wrangler.jsonc
// stays the single source of truth for every other binding.
const testConfigPath = './.wrangler.test.jsonc'
const wranglerConfig = readFileSync('./wrangler.jsonc', 'utf8').replace(/\n\s*"ai":\s*\{[^}]*\},/, '')
// Fail loud if the strip silently no-ops (e.g. the `ai` block was reformatted or
// moved to last position, losing its trailing comma). Otherwise the surviving
// remote AI binding would make the pool hang on a credentials-less proxy — a
// confusing failure. Turn that into a clear, actionable error instead.
if (/"ai":/.test(wranglerConfig))
  throw new Error('vitest.config: failed to strip the "ai" binding from wrangler.jsonc — the test pool needs it removed. Check the block\'s formatting against the regex above.')
writeFileSync(testConfigPath, wranglerConfig)

export default defineWorkersConfig(({ mode }) => ({
  test: {
    env: loadEnv(mode, process.cwd(), ''),
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: {
          configPath: testConfigPath,
        },
        miniflare: {
          cf: true,
        },
      },
    },
  },
}))

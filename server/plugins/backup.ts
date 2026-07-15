/// <reference path="../../worker-configuration.d.ts" />

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    // Skip only the weekly digest cron; anything else still backs up (fail-open,
    // so an unexpected cron string can never silently disable backups).
    if (cronFired(event, '0 14 * * 1', 14, 1))
      return

    const config = useRuntimeConfig()

    if (config.disableAutoBackup) {
      console.info('[backup:kv] Auto backup is disabled by configuration')
      return
    }

    const env = event.env as Cloudflare.Env
    await backupKVToR2(env)
  })
})

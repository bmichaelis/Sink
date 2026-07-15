/// <reference path="../../worker-configuration.d.ts" />

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    // Only run on the daily backup cron; other crons (e.g. the weekly digest)
    // share this hook and must not trigger a backup.
    if (!cronFired(event, '0 0 * * *', 0))
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

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async (event) => {
    const config = useRuntimeConfig()

    if (!config.digestNotifyUrl)
      return
    if (!cronFired(event, '0 14 * * 1', 14, 1))
      return

    try {
      const data = await buildWeeklyDigest(config)
      await postDigest(config.digestNotifyUrl, 'Weekly digest', formatDigest(data))
      console.info('[digest] Weekly digest sent')
    }
    catch (error) {
      console.error('[digest] Failed:', error)
    }
  })
})

defineRouteMeta({
  openAPI: {
    description: 'Manually build and send the weekly analytics digest',
    security: [{ bearerAuth: [] }],
  },
})

export default eventHandler(async (event) => {
  const config = useRuntimeConfig(event)

  if (!config.digestNotifyUrl) {
    throw createError({
      status: 400,
      statusText: 'NUXT_DIGEST_NOTIFY_URL is not configured',
    })
  }

  const data = await buildWeeklyDigest(config)
  const body = formatDigest(data)
  await postDigest(config.digestNotifyUrl, 'Weekly digest', body)

  return {
    success: true,
    message: 'Digest sent successfully',
    preview: body,
  }
})

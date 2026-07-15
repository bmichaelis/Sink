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

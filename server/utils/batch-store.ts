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

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

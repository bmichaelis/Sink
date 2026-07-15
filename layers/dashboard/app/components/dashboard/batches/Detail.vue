<script setup lang="ts">
import type { BatchCodeStatus, BatchRecord } from '#shared/schemas/batch'
import { ArrowLeft, Copy, Eraser, RotateCcw } from 'lucide-vue-next'
import { toast } from 'vue-sonner'

const props = defineProps<{
  batchId: string
}>()

const { t, locale } = useI18n()
const requestUrl = useRequestURL()

const batch = ref<BatchRecord | null>(null)
const codes = ref<BatchCodeStatus[]>([])
const claimedCount = ref(0)
const loading = ref(true)
const error = ref(false)

async function loadDetail() {
  loading.value = true
  error.value = false
  try {
    const data = await useAPI<{ batch: BatchRecord, codes: BatchCodeStatus[], claimedCount: number }>('/api/batch/detail', {
      query: { id: props.batchId },
    })
    batch.value = data.batch
    codes.value = data.codes
    claimedCount.value = data.claimedCount
  }
  catch (e) {
    console.error(e)
    error.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(loadDetail)

function shortLink(slug: string) {
  return `${requestUrl.origin}/${slug}`
}

async function copyLink(slug: string) {
  await navigator.clipboard.writeText(shortLink(slug))
  toast(t('links.copy_success'))
}

async function resetCode(slug: string) {
  try {
    await useAPI('/api/link/reset', { method: 'POST', body: { slug } })
    toast(t('links.reset_success'))
    await loadDetail()
  }
  catch (e) {
    console.error(e)
    toast.error(t('links.reset_failed'))
  }
}

async function deleteBatch() {
  try {
    await useAPI('/api/batch/delete', { method: 'POST', body: { id: props.batchId } })
    toast(t('batches.delete_success'))
    await navigateTo('/dashboard/batches')
  }
  catch (e) {
    console.error(e)
    toast.error(t('batches.load_failed'))
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center gap-2">
      <NuxtLink
        to="/dashboard/batches" class="
          inline-flex items-center gap-1 text-sm text-muted-foreground
          hover:text-foreground
        "
      >
        <ArrowLeft class="h-4 w-4" aria-hidden="true" /> {{ $t('batches.back') }}
      </NuxtLink>
    </div>

    <div v-if="loading">
      <Skeleton class="h-24 rounded-xl" />
    </div>
    <p
      v-else-if="error || !batch" class="
        text-center text-sm text-muted-foreground
      "
    >
      {{ $t('batches.load_failed') }}
    </p>
    <template v-else>
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-xl font-bold">
          {{ batch.name }}
        </h2>
        <Badge variant="secondary">
          {{ claimedCount }}/{{ batch.count }} {{ $t('batches.claimed') }}
        </Badge>
        <span class="text-sm text-muted-foreground">{{ shortDate(batch.createdAt, locale) }}</span>
        <div class="ml-auto flex items-center gap-2">
          <!-- batch-actions -->
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button variant="destructive" size="sm">
                <Eraser class="mr-1 h-4 w-4" aria-hidden="true" /> {{ $t('batches.delete') }}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{{ $t('batches.delete_confirm_title') }}</AlertDialogTitle>
                <AlertDialogDescription>{{ $t('batches.delete_confirm_desc') }}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{{ $t('common.cancel') }}</AlertDialogCancel>
                <AlertDialogAction @click="deleteBatch">
                  {{ $t('common.continue') }}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div class="overflow-x-auto rounded-xl border">
        <table class="w-full text-sm">
          <tbody>
            <tr
              v-for="code in codes" :key="code.slug" class="
                border-b
                last:border-b-0
              "
            >
              <td class="w-12 px-3 py-2 text-muted-foreground">
                #{{ code.seq }}
              </td>
              <td class="px-3 py-2 font-mono">
                {{ code.slug }}
              </td>
              <td class="px-3 py-2">
                <Badge v-if="code.missing" variant="outline">
                  {{ $t('batches.status_missing') }}
                </Badge>
                <Badge v-else-if="code.claimed" variant="destructive">
                  {{ $t('batches.status_claimed') }}
                  <template v-if="code.claimedAt">
                    · {{ shortDate(code.claimedAt, locale) }}
                  </template>
                </Badge>
                <Badge v-else variant="secondary">
                  {{ $t('batches.status_valid') }}
                </Badge>
              </td>
              <td class="w-24 px-3 py-2 text-right whitespace-nowrap">
                <Button
                  v-if="!code.missing" variant="ghost" size="icon" class="
                    h-7 w-7
                  " aria-label="Copy link" @click="copyLink(code.slug)"
                >
                  <Copy class="h-4 w-4" />
                </Button>
                <Button
                  v-if="code.claimed && !code.missing" variant="ghost" size="icon" class="
                    h-7 w-7
                  " aria-label="Reset code" @click="resetCode(code.slug)"
                >
                  <RotateCcw class="h-4 w-4" />
                </Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import type { BatchRecord } from '#shared/schemas/batch'
import { Tickets } from 'lucide-vue-next'

const { locale } = useI18n()

const batches = ref<BatchRecord[]>([])
const claimedCounts = ref<Record<string, number>>({})
const loading = ref(true)
const error = ref(false)

async function loadBatches() {
  loading.value = true
  error.value = false
  try {
    const data = await useAPI<{ batches: BatchRecord[] }>('/api/batch/list')
    batches.value = data.batches
    data.batches.forEach(async (batch) => {
      try {
        const detail = await useAPI<{ claimedCount: number }>('/api/batch/detail', { query: { id: batch.id } })
        claimedCounts.value[batch.id] = detail.claimedCount
      }
      catch (e) {
        console.error(e)
      }
    })
  }
  catch (e) {
    console.error(e)
    error.value = true
  }
  finally {
    loading.value = false
  }
}

onMounted(loadBatches)
</script>

<template>
  <div>
    <div
      v-if="loading" class="
        grid gap-4
        md:grid-cols-2
        lg:grid-cols-3
      "
    >
      <Skeleton v-for="i in 3" :key="i" class="h-28 rounded-xl" />
    </div>
    <p v-else-if="error" class="text-center text-sm text-muted-foreground">
      {{ $t('batches.load_failed') }}
    </p>
    <p
      v-else-if="batches.length === 0" class="
        text-center text-sm text-muted-foreground
      "
    >
      {{ $t('batches.empty') }}
    </p>
    <div
      v-else class="
        grid gap-4
        md:grid-cols-2
        lg:grid-cols-3
      "
    >
      <NuxtLink
        v-for="batch in batches"
        :key="batch.id"
        :to="{ path: '/dashboard/batches', query: { id: batch.id } }"
      >
        <Card
          class="
            h-full transition-colors
            hover:bg-accent/50
          "
        >
          <CardContent class="space-y-2">
            <div class="flex items-center gap-2">
              <Tickets class="h-5 w-5 shrink-0" aria-hidden="true" />
              <span class="truncate font-bold">{{ batch.name }}</span>
              <Badge variant="secondary" class="ml-auto shrink-0">
                {{ batch.mode === 'checkin' ? $t('batches.mode_checkin_short') : $t('batches.mode_redirect_short') }}
              </Badge>
            </div>
            <div class="text-sm text-muted-foreground">
              {{ shortDate(batch.createdAt, locale) }}
            </div>
            <div class="text-sm">
              <template v-if="claimedCounts[batch.id] !== undefined">
                {{ claimedCounts[batch.id] }}/{{ batch.count }} {{ $t('batches.claimed') }}
              </template>
              <Skeleton v-else class="h-4 w-24" />
            </div>
          </CardContent>
        </Card>
      </NuxtLink>
    </div>
  </div>
</template>

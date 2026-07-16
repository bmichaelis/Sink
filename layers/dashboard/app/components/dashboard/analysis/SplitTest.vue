<script setup lang="ts">
import type { VariantStat, VariantStatRow } from '../../../../shared/types/metrics'
import type { Link } from '@/types'
import { watchThrottled } from '@vueuse/core'

const props = defineProps<{
  link: Link
}>()

const { locale } = useI18n()
const analysisStore = useDashboardAnalysisStore()

const stats = ref<VariantStat[]>([])
const pending = ref(true)

async function getVariantStats() {
  pending.value = true
  try {
    const result = await useAPI<{ data: VariantStatRow[] }>('/api/stats/variants', {
      query: {
        id: props.link.id,
        startAt: analysisStore.dateRange.startAt,
        endAt: analysisStore.dateRange.endAt,
        ...analysisStore.filters,
      },
    })
    stats.value = mergeVariantStats(props.link.variants, Array.isArray(result.data) ? result.data : [])
  }
  finally {
    pending.value = false
  }
}

watchThrottled([() => analysisStore.dateRange, () => analysisStore.filters], getVariantStats, {
  deep: true,
  throttle: 500,
  leading: true,
  trailing: true,
})

onMounted(getVariantStats)

const hasVisits = computed(() => stats.value.some(s => s.visits > 0))
</script>

<template>
  <Card class="flex flex-col gap-0 p-0">
    <CardHeader class="px-4 py-3">
      <CardTitle class="text-base">
        {{ $t('dashboard.split_test') }}
      </CardTitle>
      <CardDescription class="text-xs">
        {{ $t('dashboard.split_test_note') }}
      </CardDescription>
    </CardHeader>
    <CardContent class="p-0">
      <div
        class="
          flex justify-between border-t px-4 py-2 text-xs font-medium
          text-muted-foreground
        "
      >
        <span>{{ $t('dashboard.name') }}</span>
        <span class="flex gap-4">
          <span>{{ $t('dashboard.split_test_visits') }}</span>
          <span>{{ $t('dashboard.split_test_visitors') }}</span>
        </span>
      </div>
      <div
        v-for="stat in stats"
        :key="stat.index"
        class="flex items-center justify-between border-t px-4 py-2 text-sm"
      >
        <div class="min-w-0 flex-1 pr-4">
          <div class="font-medium">
            {{ stat.url === null
              ? $t('dashboard.split_test_removed', { index: stat.index + 1 })
              : $t('dashboard.split_test_variant', { index: stat.index + 1 }) }}
            <span
              v-if="stat.weight !== null"
              class="text-xs text-muted-foreground"
            >· {{ $t('dashboard.split_test_weight', { weight: stat.weight }) }}</span>
          </div>
          <div
            v-if="stat.url"
            class="truncate text-xs text-muted-foreground"
          >
            {{ stat.url }}
          </div>
        </div>
        <div class="flex gap-4 text-right tabular-nums">
          <span class="w-16">
            {{ formatNumber(stat.visits, locale) }}
            <span class="text-xs text-gray-500">({{ stat.percent }}%)</span>
          </span>
          <span class="w-12">{{ formatNumber(stat.visitors, locale) }}</span>
        </div>
      </div>
      <div
        v-if="!pending && !hasVisits"
        class="border-t px-4 py-3 text-xs text-muted-foreground"
      >
        {{ $t('dashboard.split_test_empty') }}
      </div>
    </CardContent>
  </Card>
</template>

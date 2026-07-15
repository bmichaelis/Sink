<script setup lang="ts">
import type { BatchCodeStatus, BatchRecord } from '#shared/schemas/batch'

definePageMeta({
  layout: false,
})

const route = useRoute()
const requestUrl = useRequestURL()
const { qrPngBlob } = useBatchQr()

const batch = ref<BatchRecord | null>(null)
const codes = ref<BatchCodeStatus[]>([])
const qrUrls = ref<Record<string, string>>({})
const ready = ref(false)

onMounted(async () => {
  const id = typeof route.query.id === 'string' ? route.query.id : ''
  if (!id)
    return
  const data = await useAPI<{ batch: BatchRecord, codes: BatchCodeStatus[] }>('/api/batch/detail', { query: { id } })
  batch.value = data.batch
  codes.value = data.codes
  for (const code of data.codes) {
    const blob = await qrPngBlob(`${requestUrl.origin}/${code.slug}`, 256)
    qrUrls.value[code.slug] = URL.createObjectURL(blob)
  }
  ready.value = true
})

function printSheet() {
  if (typeof window !== 'undefined')
    window.print()
}
</script>

<template>
  <div class="mx-auto max-w-5xl bg-white p-6 text-black">
    <div
      class="
        mb-4 flex items-center justify-between
        print:hidden
      "
    >
      <h1 class="text-xl font-bold">
        {{ batch?.name }}
      </h1>
      <button
        class="rounded-lg border px-4 py-2 text-sm font-medium"
        :disabled="!ready"
        @click="printSheet"
      >
        🖨 Print
      </button>
    </div>

    <div class="grid grid-cols-3 gap-6">
      <div
        v-for="code in codes"
        :key="code.slug"
        class="break-inside-avoid rounded-lg border p-3 text-center"
      >
        <img
          v-if="qrUrls[code.slug]"
          :src="qrUrls[code.slug]"
          :alt="`QR code ${code.seq}`"
          class="mx-auto aspect-square w-full max-w-44"
        >
        <div class="mt-1 text-sm font-bold">
          #{{ code.seq }}
        </div>
        <div class="font-mono text-[10px] break-all">
          {{ requestUrl.origin }}/{{ code.slug }}
        </div>
      </div>
    </div>
  </div>
</template>

<style>
@media print {
  body {
    background: white;
  }
}
</style>

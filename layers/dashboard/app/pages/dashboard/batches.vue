<script setup lang="ts">
definePageMeta({
  layout: 'dashboard',
})

const route = useRoute()
const batchId = computed(() => typeof route.query.id === 'string' ? route.query.id : '')
</script>

<template>
  <main class="space-y-6">
    <Teleport to="#dashboard-header-actions" defer>
      <DashboardBatchesCreate v-if="!batchId" />
    </Teleport>

    <DashboardBatchesDetail v-if="batchId" :batch-id="batchId" />
    <DashboardBatchesIndex v-else />
  </main>
</template>

<script setup lang="ts">
import type { BatchRecord } from '#shared/schemas/batch'
import { toast } from 'vue-sonner'

const { t } = useI18n()
const dialogOpen = ref(false)
const submitting = ref(false)

const name = ref('')
const mode = ref<'redirect' | 'checkin'>('redirect')
const url = ref('')
const count = ref<number | undefined>(undefined)

const valid = computed(() => {
  if (!name.value.trim())
    return false
  const n = count.value ?? 0
  if (n < 1 || n > 100)
    return false
  if (mode.value === 'redirect' && !url.value.trim())
    return false
  return true
})

async function submit() {
  if (!valid.value || submitting.value)
    return
  submitting.value = true
  try {
    const { batch } = await useAPI<{ batch: BatchRecord }>('/api/batch/create', {
      method: 'POST',
      body: {
        name: name.value.trim(),
        mode: mode.value,
        url: url.value.trim() || undefined,
        count: count.value,
      },
    })
    toast(t('batches.create_success'))
    dialogOpen.value = false
    name.value = ''
    url.value = ''
    count.value = undefined
    await navigateTo({ path: '/dashboard/batches', query: { id: batch.id } })
  }
  catch (error) {
    console.error(error)
    toast.error(t('batches.create_failed'), {
      description: error instanceof Error ? error.message : String(error),
    })
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <ResponsiveModal v-model:open="dialogOpen" :title="t('batches.create')">
    <template #trigger>
      <Button class="md:ml-2" variant="outline">
        {{ $t('batches.create') }}
      </Button>
    </template>

    <div class="space-y-4 px-1">
      <div class="space-y-1.5">
        <Label for="batch-name">{{ $t('batches.name') }}</Label>
        <Input id="batch-name" v-model="name" :placeholder="$t('batches.name_placeholder')" autocomplete="off" />
      </div>

      <div class="space-y-1.5">
        <Label>{{ $t('batches.mode') }}</Label>
        <div class="grid gap-2">
          <Button type="button" :variant="mode === 'redirect' ? 'default' : 'outline'" size="sm" @click="mode = 'redirect'">
            {{ $t('batches.mode_redirect') }}
          </Button>
          <Button type="button" :variant="mode === 'checkin' ? 'default' : 'outline'" size="sm" @click="mode = 'checkin'">
            {{ $t('batches.mode_checkin') }}
          </Button>
        </div>
      </div>

      <div class="space-y-1.5">
        <Label for="batch-url">{{ $t('batches.destination') }}</Label>
        <Input id="batch-url" v-model="url" :placeholder="$t('batches.destination_placeholder')" autocomplete="url" />
      </div>

      <div class="space-y-1.5">
        <Label for="batch-count">{{ $t('batches.count') }}</Label>
        <Input
          id="batch-count"
          type="number"
          min="1"
          max="100"
          :model-value="count"
          @input="count = ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value)"
        />
      </div>
    </div>

    <template #footer>
      <Button type="button" variant="secondary" @click="dialogOpen = false">
        {{ $t('common.close') }}
      </Button>
      <Button type="button" :disabled="!valid || submitting" @click="submit">
        {{ $t('common.save') }}
      </Button>
    </template>
  </ResponsiveModal>
</template>

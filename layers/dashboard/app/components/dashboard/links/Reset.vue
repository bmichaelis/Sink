<script setup lang="ts">
import type { Link } from '@/types'
import { toast } from 'vue-sonner'

const props = defineProps<{
  link: Link
}>()

const { t } = useI18n()
const linksStore = useDashboardLinksStore()
const linksSearchStore = useDashboardLinksSearchStore()

async function resetLink() {
  try {
    const { link: updatedLink } = await useAPI<{ link: Link }>('/api/link/reset', {
      method: 'POST',
      body: {
        slug: props.link.slug,
      },
    })
    linksSearchStore.syncLink(updatedLink, 'edit')
    linksStore.notifyLinkUpdate(updatedLink, 'edit')
    toast(t('links.reset_success'))
  }
  catch (error) {
    console.error(error)
    toast.error(t('links.reset_failed'))
  }
}
</script>

<template>
  <AlertDialog>
    <AlertDialogTrigger as-child>
      <slot />
    </AlertDialogTrigger>
    <AlertDialogContent
      class="
        max-h-[95svh] max-w-[95svw] grid-rows-[auto_minmax(0,1fr)_auto]
        md:max-w-lg
      "
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{{ $t('links.reset_confirm_title') }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ $t('links.reset_confirm_desc') }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ $t('common.cancel') }}</AlertDialogCancel>
        <AlertDialogAction @click="resetLink">
          {{ $t('common.continue') }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>

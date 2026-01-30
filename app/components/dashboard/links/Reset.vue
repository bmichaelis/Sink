<script setup>
import { toast } from 'vue-sonner'

const props = defineProps({
  link: {
    type: Object,
    required: true,
  },
})

const emit = defineEmits(['update:link'])

const { t } = useI18n()

async function resetLink() {
  const { link: updatedLink } = await useAPI('/api/link/reset', {
    method: 'POST',
    body: {
      slug: props.link.slug,
    },
  })
  emit('update:link', updatedLink, 'edit')
  toast(t('links.reset_success'))
}
</script>

<template>
  <AlertDialog>
    <AlertDialogTrigger as-child>
      <slot />
    </AlertDialogTrigger>
    <AlertDialogContent class="max-w-[95svw] max-h-[95svh] md:max-w-lg grid-rows-[auto_minmax(0,1fr)_auto]">
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

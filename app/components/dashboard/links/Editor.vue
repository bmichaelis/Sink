<script setup>
import { DependencyType } from '@/components/ui/auto-form/interface'
import { LinkSchema, LinkTypeEnum, nanoid } from '@@/schemas/link'
import { toTypedSchema } from '@vee-validate/zod'
import { Shuffle, Sparkles } from 'lucide-vue-next'
import { useForm } from 'vee-validate'
import { toast } from 'vue-sonner'
import { z } from 'zod'

const props = defineProps({
  link: {
    type: Object,
    default: () => ({}),
  },
})

const emit = defineEmits(['update:link'])

const { t } = useI18n()
const link = ref(props.link)
const dialogOpen = ref(false)

const isEdit = !!props.link.id

const EditLinkSchema = z.object({
  type: LinkTypeEnum.default('redirect'),
  url: z.string().trim().url().max(2048).optional(),
  content: z.string().trim().max(50000).optional(),
  slug: LinkSchema.shape.slug,
  optional: LinkSchema.omit({
    id: true,
    type: true,
    url: true,
    content: true,
    slug: true,
    createdAt: true,
    updatedAt: true,
    title: true,
    description: true,
    image: true,
  }).extend({
    expiration: z.coerce.date().optional(),
  }).optional(),
}).refine(
  (data) => {
    if (data.type === 'redirect')
      return !!data.url
    if (data.type === 'text')
      return !!data.content
    return true
  },
  {
    message: 'URL is required for redirect links, content is required for text links',
    path: ['url'],
  },
)

const fieldConfig = {
  type: {
    label: t('links.type'),
  },
  url: {
    label: 'URL',
  },
  content: {
    label: t('links.content'),
    component: 'textarea',
    inputProps: {
      placeholder: t('links.content_placeholder'),
      rows: 8,
    },
  },
  slug: {
    disabled: isEdit,
  },
  optional: {
    comment: {
      component: 'textarea',
    },
  },
}

const dependencies = [
  {
    sourceField: 'slug',
    type: DependencyType.DISABLES,
    targetField: 'slug',
    when: () => isEdit,
  },
  {
    sourceField: 'type',
    type: DependencyType.HIDES,
    targetField: 'url',
    when: type => type === 'text',
  },
  {
    sourceField: 'type',
    type: DependencyType.HIDES,
    targetField: 'content',
    when: type => type === 'redirect',
  },
]

const form = useForm({
  validationSchema: toTypedSchema(EditLinkSchema),
  initialValues: {
    type: link.value.type || 'redirect',
    slug: link.value.slug,
    url: link.value.url,
    content: link.value.content,
    optional: {
      comment: link.value.comment,
    },
  },
  validateOnMount: isEdit,
  keepValuesOnUnmount: isEdit,
})

const isTextType = computed(() => form.values.type === 'text')

function randomSlug() {
  form.setFieldValue('slug', nanoid()())
}

const aiSlugPending = ref(false)
async function aiSlug() {
  if (!form.values.url || isTextType.value)
    return

  aiSlugPending.value = true
  try {
    const { slug } = await useAPI('/api/link/ai', {
      query: {
        url: form.values.url,
      },
    })
    form.setFieldValue('slug', slug)
  }
  catch (error) {
    console.log(error)
  }
  aiSlugPending.value = false
}

onMounted(() => {
  if (link.value.expiration) {
    form.setFieldValue('optional.expiration', unix2date(link.value.expiration))
  }
})

async function onSubmit(formData) {
  const isText = formData.type === 'text'
  const link = {
    type: formData.type,
    slug: formData.slug,
    ...(isText ? { content: formData.content } : { url: formData.url }),
    ...(formData.optional || []),
    expiration: formData.optional?.expiration ? date2unix(formData.optional?.expiration, 'end') : undefined,
  }
  const { link: newLink } = await useAPI(isEdit ? '/api/link/edit' : '/api/link/create', {
    method: isEdit ? 'PUT' : 'POST',
    body: link,
  })
  dialogOpen.value = false
  emit('update:link', newLink, isEdit ? 'edit' : 'create')
  if (isEdit) {
    toast(t('links.update_success'))
  }
  else {
    toast(t('links.create_success'))
  }
}

const { previewMode } = useRuntimeConfig().public
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogTrigger as-child>
      <slot>
        <Button
          class="ml-2"
          variant="outline"
          @click="randomSlug"
        >
          {{ $t('links.create') }}
        </Button>
      </slot>
    </DialogTrigger>
    <DialogContent class="max-w-[95svw] max-h-[95svh] md:max-w-lg grid-rows-[auto_minmax(0,1fr)_auto]">
      <DialogHeader>
        <DialogTitle>{{ link.id ? $t('links.edit') : $t('links.create') }}</DialogTitle>
      </DialogHeader>
      <p
        v-if="previewMode"
        class="text-sm text-muted-foreground"
      >
        {{ $t('links.preview_mode_tip') }}
      </p>
      <AutoForm
        class="overflow-y-auto px-2 space-y-2"
        :schema="EditLinkSchema"
        :form="form"
        :field-config="fieldConfig"
        :dependencies="dependencies"
        @submit="onSubmit"
      >
        <template #slug="slotProps">
          <div
            v-if="!isEdit"
            class="relative"
          >
            <div class="flex absolute right-0 top-1 space-x-3">
              <Shuffle
                class="w-4 h-4 cursor-pointer"
                @click="randomSlug"
              />
              <Sparkles
                v-if="!isTextType"
                class="w-4 h-4 cursor-pointer"
                :class="{ 'animate-bounce': aiSlugPending }"
                @click="aiSlug"
              />
            </div>
            <AutoFormField
              v-bind="slotProps"
            />
          </div>
        </template>
        <DialogFooter>
          <DialogClose as-child>
            <Button
              type="button"
              variant="secondary"
              class="mt-2 sm:mt-0"
            >
              {{ $t('common.close') }}
            </Button>
          </DialogClose>
          <Button type="submit">
            {{ $t('common.save') }}
          </Button>
        </DialogFooter>
      </AutoForm>
    </DialogContent>
  </Dialog>
</template>

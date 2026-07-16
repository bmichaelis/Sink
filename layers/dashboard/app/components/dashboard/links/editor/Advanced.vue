<script setup lang="ts">
import type { DateValue } from '@internationalized/date'
import type { Component } from 'vue'
import type { AnyFieldApi, LinkFormData } from '@/types'
import { isMaskedLinkPassword, LINK_PASSWORD_MASK_PREFIX } from '#shared/utils/link-password'
import { today } from '@internationalized/date'
import { CalendarIcon, Plus, Sparkles, Trash2 } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { cn } from '@/lib/utils'

const props = defineProps<{
  form: {
    Field: Component
    getFieldValue: (name: keyof LinkFormData) => LinkFormData[keyof LinkFormData]
    setFieldValue: (name: keyof LinkFormData, value: any) => void
  }
  validateOptionalUrl: (ctx: { value: string }) => string | undefined
  isInvalid: (field: AnyFieldApi) => boolean
  getAriaInvalid: (field: AnyFieldApi) => string | undefined
  formatErrors: (errors: unknown[]) => string[]
  currentSlug: string
}>()

const datePickerOpen = ref(false)
const { t, locale } = useI18n()
const accordionTriggerClass = 'hover:no-underline'

type GeoRoute = LinkFormData['geo'][number]

function updateGeoRoute(routes: GeoRoute[], index: number | string, value: Partial<GeoRoute>) {
  const targetIndex = Number(index)
  return routes.map((route, routeIndex) => routeIndex === targetIndex ? { ...route, ...value } : route)
}

function removeGeoRoute(routes: GeoRoute[], index: number | string) {
  const targetIndex = Number(index)
  return routes.filter((_, routeIndex) => routeIndex !== targetIndex)
}

type ScheduleEntry = LinkFormData['schedule'][number]

function updateScheduleEntry(entries: ScheduleEntry[], index: number | string, value: Partial<ScheduleEntry>) {
  const targetIndex = Number(index)
  return entries.map((entry, entryIndex) => entryIndex === targetIndex ? { ...entry, ...value } : entry)
}

function removeScheduleEntry(entries: ScheduleEntry[], index: number | string) {
  const targetIndex = Number(index)
  return entries.filter((_, entryIndex) => entryIndex !== targetIndex)
}

type VariantEntry = LinkFormData['variants'][number]

function updateVariant(entries: VariantEntry[], index: number | string, value: Partial<VariantEntry>) {
  const targetIndex = Number(index)
  return entries.map((entry, entryIndex) => entryIndex === targetIndex ? { ...entry, ...value } : entry)
}

function removeVariant(entries: VariantEntry[], index: number | string) {
  const targetIndex = Number(index)
  return entries.filter((_, entryIndex) => entryIndex !== targetIndex)
}

function removeAllowedCountry(countries: string[], index: number | string) {
  const targetIndex = Number(index)
  return countries.filter((_, countryIndex) => countryIndex !== targetIndex)
}

function updateAllowedCountry(countries: string[], index: number | string, value: string) {
  const targetIndex = Number(index)
  return countries.map((country, countryIndex) => countryIndex === targetIndex ? value.toUpperCase() : country)
}

function formatPasswordDisplay(password: string) {
  return isMaskedLinkPassword(password)
    ? password.replace(LINK_PASSWORD_MASK_PREFIX, '')
    : password
}

// A window is only stored when start, end and tz are all set (see Form.vue's
// submit). Partial input is otherwise dropped silently, taking the times the
// user did set with it — so say so rather than discarding their work quietly.
function isPartialWindow(hours: { start: string, end: string, tz: string }): boolean {
  const filled = [hours.start, hours.end, hours.tz].filter(Boolean).length
  return filled > 0 && filled < 3
}

// Compute default open items based on existing values
const defaultOpenItems = computed(() => {
  const items: string[] = []
  if (props.form.getFieldValue('title') || props.form.getFieldValue('description') || props.form.getFieldValue('image')) {
    items.push('og')
  }
  if (props.form.getFieldValue('google') || props.form.getFieldValue('apple')) {
    items.push('device')
  }
  if (props.form.getFieldValue('expiration') || props.form.getFieldValue('cloaking') || props.form.getFieldValue('redirectWithQuery') || props.form.getFieldValue('password') || props.form.getFieldValue('unsafe')) {
    items.push('link_settings')
  }
  const geoVal = props.form.getFieldValue('geo')
  if (Array.isArray(geoVal) && geoVal.length > 0) {
    items.push('geo')
  }
  const scheduleVal = props.form.getFieldValue('schedule')
  if (Array.isArray(scheduleVal) && scheduleVal.length > 0) {
    items.push('schedule')
  }
  const variantsVal = props.form.getFieldValue('variants')
  if (Array.isArray(variantsVal) && variantsVal.length > 0) {
    items.push('split_test')
  }
  const countriesVal = props.form.getFieldValue('allowedCountries')
  if (Array.isArray(countriesVal) && countriesVal.length > 0) {
    items.push('geo_restrictions')
  }
  const hoursVal = props.form.getFieldValue('activeHours') as { start?: string, end?: string } | undefined
  if (hoursVal?.start && hoursVal?.end) {
    items.push('active_hours')
  }
  if (props.form.getFieldValue('notifyUrl')) {
    items.push('notifications')
  }
  return items
})

const aiOgPending = ref(false)
async function aiOg() {
  const url = props.form.getFieldValue('url') as string
  if (!url) {
    return
  }

  aiOgPending.value = true
  try {
    const result = await useAPI<{ title?: string, description?: string }>('/api/link/og-ai', {
      query: { url },
    })

    if (result.title) {
      props.form.setFieldValue('title', result.title)
    }
    if (result.description) {
      props.form.setFieldValue('description', result.description)
    }
    toast.success(t('links.ai_og_success'))
  }
  catch (error) {
    console.error(error)
    toast.error(t('links.ai_og_failed'), {
      description: error instanceof Error ? error.message : String(error),
    })
  }
  finally {
    aiOgPending.value = false
  }
}
</script>

<template>
  <Accordion type="multiple" :default-value="defaultOpenItems" class="w-full">
    <AccordionItem value="link_settings">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.link_settings') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="redirectWithQuery">
            <DashboardLinksEditorFieldSwitch
              :id="field.name"
              :model-value="field.state.value"
              :label="$t('links.form.redirect_with_query_label')"
              :description="$t('links.form.redirect_with_query_description')"
              @update:model-value="field.handleChange"
            />
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="cloaking">
            <DashboardLinksEditorFieldSwitch
              :id="field.name"
              :model-value="field.state.value"
              :label="$t('links.form.cloaking_label')"
              :description="$t('links.form.cloaking_description')"
              @update:model-value="field.handleChange"
            />
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="unsafe">
            <DashboardLinksEditorFieldSwitch
              :id="field.name"
              :model-value="field.state.value"
              :label="$t('links.form.unsafe_label')"
              :description="$t('links.form.unsafe_description')"
              @update:model-value="field.handleChange"
            />
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="expiration">
            <Field :data-invalid="isInvalid(field)">
              <FieldLabel :for="field.name">
                {{ $t('links.form.expiration') }}
              </FieldLabel>
              <FieldDescription class="text-xs">
                {{ $t('links.form.expiration_description') }}
              </FieldDescription>
              <Popover v-model:open="datePickerOpen">
                <PopoverTrigger as-child>
                  <Button
                    :id="field.name"
                    variant="outline"
                    :class="cn(
                      'w-full justify-start text-left font-normal',
                      !field.state.value && 'text-muted-foreground',
                    )"
                  >
                    <CalendarIcon class="mr-2 h-4 w-4" />
                    {{
                      field.state.value
                        ? field.state.value.toDate(getTimeZone()).toLocaleDateString(locale)
                        : $t('links.form.pick_date')
                    }}
                  </Button>
                </PopoverTrigger>
                <PopoverContent class="w-auto p-0" align="start">
                  <Calendar
                    :model-value="field.state.value"
                    :default-placeholder="today(getTimeZone())"
                    layout="month-and-year"
                    initial-focus
                    @update:model-value="(v: DateValue | undefined) => {
                      field.handleChange(v)
                      datePickerOpen = false
                    }"
                  />
                </PopoverContent>
              </Popover>
              <FieldError
                v-if="isInvalid(field)"
                :errors="formatErrors(field.state.meta.errors)"
              />
            </Field>
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="password">
            <Field>
              <FieldLabel :for="field.name">
                {{ $t('links.form.password_label') }}
              </FieldLabel>
              <FieldDescription class="text-xs">
                {{ $t('links.form.password_description') }}
              </FieldDescription>
              <Input
                :id="field.name"
                :name="field.name"
                :model-value="formatPasswordDisplay(field.state.value)"
                :placeholder="$t('links.form.password_placeholder')"
                :type="isMaskedLinkPassword(field.state.value) ? 'text' : 'password'"
                autocomplete="off"
                class="mt-1.5"
                @blur="field.handleBlur"
                @input="field.handleChange(($event.target as HTMLInputElement).value)"
              />
            </Field>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="og">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.og_settings') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="title">
            <Field>
              <div class="flex items-center justify-between">
                <FieldLabel :for="field.name">
                  {{ $t('links.form.og_title') }}
                </FieldLabel>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  class="h-auto w-auto p-0"
                  :aria-label="$t('links.form.ai_og_generate')"
                  :disabled="aiOgPending"
                  @click="aiOg"
                >
                  <Sparkles
                    class="h-4 w-4"
                    :class="{ 'animate-bounce': aiOgPending }"
                  />
                </Button>
              </div>
              <Input
                :id="field.name"
                :name="field.name"
                :model-value="field.state.value"
                :placeholder="$t('links.form.og_title_placeholder')"
                @blur="field.handleBlur"
                @input="field.handleChange(($event.target as HTMLInputElement).value)"
              />
            </Field>
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="description">
            <DashboardLinksEditorFieldTextarea
              :field="field"
              :label="$t('links.form.og_description')"
              :placeholder="$t('links.form.og_description_placeholder')"
            />
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="image">
            <Field>
              <FieldLabel :for="field.name">
                {{ $t('links.form.og_image') }}
              </FieldLabel>
              <DashboardLinksEditorImageUploader
                :model-value="field.state.value"
                :slug="currentSlug"
                @update:model-value="field.handleChange($event || '')"
              />
            </Field>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="device">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.device_redirect') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field
            v-slot="{ field }"
            name="google"
            :validators="{ onBlur: validateOptionalUrl }"
          >
            <DashboardLinksEditorFieldInput
              :field="field"
              :label="$t('links.form.google_play')"
              placeholder="https://play.google.com/store/apps/…"
              autocomplete="off"
              :invalid="isInvalid(field)"
              :aria-invalid="getAriaInvalid(field)"
              :errors="formatErrors(field.state.meta.errors)"
            />
          </props.form.Field>

          <props.form.Field
            v-slot="{ field }"
            name="apple"
            :validators="{ onBlur: validateOptionalUrl }"
          >
            <DashboardLinksEditorFieldInput
              :field="field"
              :label="$t('links.form.app_store')"
              placeholder="https://apps.apple.com/app/…"
              autocomplete="off"
              :invalid="isInvalid(field)"
              :aria-invalid="getAriaInvalid(field)"
              :errors="formatErrors(field.state.meta.errors)"
            />
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="geo">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.geo_routing') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="geo">
            <div class="space-y-2">
              <div
                v-for="(item, i) in field.state.value" :key="i" class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field
                  class="
                    w-full
                    sm:w-56
                  "
                >
                  <DashboardLinksEditorCountrySelect
                    :model-value="item.country"
                    :placeholder="$t('links.form.select_country')"
                    :search-placeholder="$t('links.form.search_country')"
                    :empty-text="$t('links.form.no_country_found')"
                    @update:model-value="field.handleChange(updateGeoRoute(field.state.value, i, { country: $event }))"
                  />
                </Field>
                <Field class="flex-1">
                  <Input
                    :model-value="item.url"
                    placeholder="https://..."
                    autocomplete="url"
                    @input="field.handleChange(updateGeoRoute(field.state.value, i, { url: ($event.target as HTMLInputElement).value }))"
                  />
                </Field>
                <Button type="button" variant="ghost" size="icon" @click="field.handleChange(removeGeoRoute(field.state.value, i))">
                  <Trash2 class="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" @click="field.handleChange([...field.state.value, { country: '', url: '' }])">
                <Plus class="mr-2 h-4 w-4" /> {{ $t('links.form.add_geo_route') }}
              </Button>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="schedule">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.schedule') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="schedule">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.schedule_description') }}
              </FieldDescription>
              <div
                v-for="(item, i) in field.state.value" :key="i" class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field
                  class="
                    w-full
                    sm:w-56
                  "
                >
                  <Input
                    type="datetime-local"
                    :model-value="item.until === undefined ? '' : unix2datetimeLocal(item.until)"
                    :aria-label="$t('links.form.schedule_until')"
                    @input="field.handleChange(updateScheduleEntry(field.state.value, i, { until: datetimeLocal2unix(($event.target as HTMLInputElement).value) }))"
                  />
                </Field>
                <Field class="flex-1">
                  <Input
                    :model-value="item.url"
                    placeholder="https://..."
                    autocomplete="url"
                    :aria-label="$t('links.form.schedule_url')"
                    @input="field.handleChange(updateScheduleEntry(field.state.value, i, { url: ($event.target as HTMLInputElement).value }))"
                  />
                </Field>
                <Button type="button" variant="ghost" size="icon" @click="field.handleChange(removeScheduleEntry(field.state.value, i))">
                  <Trash2 class="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" @click="field.handleChange([...field.state.value, { until: undefined, url: '' }])">
                <Plus class="mr-2 h-4 w-4" /> {{ $t('links.form.add_schedule_entry') }}
              </Button>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="split_test">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.split_test') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="variants">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.split_test_description') }}
              </FieldDescription>
              <div
                v-for="(item, i) in field.state.value" :key="i" class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field class="flex-1">
                  <Input
                    :model-value="item.url"
                    placeholder="https://..."
                    autocomplete="url"
                    :aria-label="$t('links.form.split_test_url')"
                    @input="field.handleChange(updateVariant(field.state.value, i, { url: ($event.target as HTMLInputElement).value }))"
                  />
                </Field>
                <Field
                  class="
                    w-full
                    sm:w-28
                  "
                >
                  <Input
                    type="number"
                    min="1"
                    :model-value="item.weight"
                    :placeholder="$t('links.form.split_test_weight')"
                    :aria-label="$t('links.form.split_test_weight')"
                    @input="field.handleChange(updateVariant(field.state.value, i, { weight: ($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value) }))"
                  />
                </Field>
                <Button type="button" variant="ghost" size="icon" @click="field.handleChange(removeVariant(field.state.value, i))">
                  <Trash2 class="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" @click="field.handleChange([...field.state.value, { url: '', weight: undefined }])">
                <Plus class="mr-2 h-4 w-4" /> {{ $t('links.form.add_variant') }}
              </Button>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="geo_restrictions">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.geo_restrictions') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="allowedCountries">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.geo_restrictions_description') }}
              </FieldDescription>
              <div
                v-for="(item, i) in field.state.value" :key="i" class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field class="flex-1">
                  <DashboardLinksEditorCountrySelect
                    :model-value="item"
                    :placeholder="$t('links.form.select_country')"
                    :search-placeholder="$t('links.form.search_country')"
                    :empty-text="$t('links.form.no_country_found')"
                    @update:model-value="field.handleChange(updateAllowedCountry(field.state.value, i, $event))"
                  />
                </Field>
                <Button type="button" variant="ghost" size="icon" @click="field.handleChange(removeAllowedCountry(field.state.value, i))">
                  <Trash2 class="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
              <Button type="button" variant="outline" size="sm" @click="field.handleChange([...field.state.value, ''])">
                <Plus class="mr-2 h-4 w-4" /> {{ $t('links.form.add_allowed_country') }}
              </Button>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="active_hours">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.active_hours') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field v-slot="{ field }" name="activeHours">
            <div class="space-y-2">
              <FieldDescription class="text-xs">
                {{ $t('links.form.active_hours_description') }}
              </FieldDescription>
              <div
                class="
                  flex flex-col gap-2
                  sm:flex-row sm:items-start
                "
              >
                <Field
                  class="
                    w-full
                    sm:w-32
                  "
                >
                  <FieldLabel class="text-xs">
                    {{ $t('links.form.active_hours_start') }}
                  </FieldLabel>
                  <Input
                    type="time"
                    :model-value="field.state.value.start"
                    :aria-label="$t('links.form.active_hours_start')"
                    @input="field.handleChange({ ...field.state.value, start: ($event.target as HTMLInputElement).value, tz: field.state.value.tz || getTimeZone() })"
                  />
                </Field>
                <Field
                  class="
                    w-full
                    sm:w-32
                  "
                >
                  <FieldLabel class="text-xs">
                    {{ $t('links.form.active_hours_end') }}
                  </FieldLabel>
                  <Input
                    type="time"
                    :model-value="field.state.value.end"
                    :aria-label="$t('links.form.active_hours_end')"
                    @input="field.handleChange({ ...field.state.value, end: ($event.target as HTMLInputElement).value, tz: field.state.value.tz || getTimeZone() })"
                  />
                </Field>
                <Field class="flex-1">
                  <FieldLabel class="text-xs">
                    {{ $t('links.form.active_hours_tz') }}
                  </FieldLabel>
                  <Input
                    :model-value="field.state.value.tz"
                    placeholder="America/Denver"
                    :aria-label="$t('links.form.active_hours_tz')"
                    @input="field.handleChange({ ...field.state.value, tz: ($event.target as HTMLInputElement).value })"
                  />
                </Field>
              </div>
              <FieldDescription
                v-if="isPartialWindow(field.state.value)" class="
                  text-xs text-destructive
                "
              >
                {{ $t('links.form.active_hours_incomplete') }}
              </FieldDescription>
            </div>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>

    <AccordionItem value="notifications">
      <AccordionTrigger :class="accordionTriggerClass">
        {{ $t('links.form.notifications') }}
      </AccordionTrigger>
      <AccordionContent class="px-1">
        <FieldGroup>
          <props.form.Field
            v-slot="{ field }"
            name="notifyUrl"
            :validators="{ onBlur: validateOptionalUrl }"
          >
            <Field :data-invalid="isInvalid(field)">
              <FieldLabel :for="field.name">
                {{ $t('links.form.notify_url') }}
              </FieldLabel>
              <FieldDescription class="text-xs">
                {{ $t('links.form.notify_url_description') }}
              </FieldDescription>
              <Input
                :id="field.name"
                :name="field.name"
                :model-value="field.state.value"
                :aria-invalid="getAriaInvalid(field)"
                :placeholder="$t('links.form.notify_url_placeholder')"
                autocomplete="off"
                @blur="field.handleBlur"
                @input="field.handleChange(($event.target as HTMLInputElement).value)"
              />
              <FieldError
                v-if="isInvalid(field)"
                :errors="formatErrors(field.state.meta.errors)"
              />
            </Field>
          </props.form.Field>

          <props.form.Field v-slot="{ field }" name="notifyCooldownMinutes">
            <Field>
              <FieldLabel :for="field.name">
                {{ $t('links.form.notify_cooldown') }}
              </FieldLabel>
              <FieldDescription class="text-xs">
                {{ $t('links.form.notify_cooldown_description') }}
              </FieldDescription>
              <Input
                :id="field.name"
                :name="field.name"
                type="number"
                min="0"
                :model-value="field.state.value"
                :placeholder="$t('links.form.notify_cooldown_placeholder')"
                @blur="field.handleBlur"
                @input="field.handleChange(($event.target as HTMLInputElement).value === '' ? undefined : Number(($event.target as HTMLInputElement).value))"
              />
            </Field>
          </props.form.Field>
        </FieldGroup>
      </AccordionContent>
    </AccordionItem>
  </Accordion>
</template>

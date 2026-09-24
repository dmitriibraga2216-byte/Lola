<script setup lang="ts">
import { COURSE_RESULT_MODES } from '#shared/schemas/content'
const { formatShortDate } = useFormat()

/**
 * Курсы по мокапу ContentCourses (docs/11 §14.1): фильтры Автор · Мітки · Опубліковано, таблица
 * НАЗВА (Код · N розділів, M елементів) · ТРИВАЛІСТЬ · РЕЗУЛЬТАТ ПО · АВТОР · ДАТА ЗМІНИ · ОПУБЛІКОВАНО.
 * «Додати» открывает карточку курса: назва, код, тривалість, оцінка зайнятості, «Визначати результат по».
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Course {
  id: string
  title: string
  status: string
  code: string | null
  durationDays: number | null
  workload: string | null
  resultMode: string
  tags: string[]
  authorName: string | null
  createdBy: string | null
  updatedAt: string
  sections: number
  items: number
}

const items = ref<Course[]>([])
const error = ref('')
const busy = ref(false)
const status = ref<'all' | 'draft' | 'published'>('all')
const authorId = ref('')
const tag = ref('')
const formOpen = ref(false)
const form = reactive({ title: '', code: '', durationDays: null as number | null, workload: '', resultMode: 'pct' as typeof COURSE_RESULT_MODES[number], summary: '' })

async function load() {
  try {
    items.value = await api<Course[]>('/courses')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

const authors = computed(() => [...new Map(items.value.filter(c => c.createdBy).map(c => [c.createdBy!, c.authorName ?? ''])).entries()])
const tags = computed(() => [...new Set(items.value.flatMap(c => c.tags))].sort())
const visible = computed(() => items.value.filter(c =>
  (status.value === 'all' || c.status === status.value)
  && (!authorId.value || c.createdBy === authorId.value)
  && (!tag.value || c.tags.includes(tag.value)),
))

async function create() {
  if (form.title.trim().length < 3) return
  busy.value = true
  error.value = ''
  try {
    const course = await api<Course>('/courses', {
      method: 'POST',
      body: {
        title: form.title.trim(),
        code: form.code.trim() || null,
        durationDays: form.durationDays || null,
        workload: form.workload.trim() || null,
        resultMode: form.resultMode,
        summary: form.summary.trim() || undefined,
      },
    })
    await navigateTo(`/admin/courses/${course.id}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

const shortName = (n: string | null) => (n ? n.split(' ').map((p, i) => (i === 0 ? p : `${p[0]}.`)).slice(0, 2).join(' ') : '—')
</script>

<template>
  <div>
    <PageHeader :title="t('course.title')" :crumbs="[{ label: t('admin.section.content') }]">
      <template #actions>
        <button v-if="hasScope('course.create')" class="btn primary" @click="formOpen = true">{{ t('course.add') }}</button>
      </template>
    </PageHeader>

    <div class="filters">
      <div class="chips" role="tablist">
        <button v-for="s in (['all', 'draft', 'published'] as const)" :key="s" role="tab" :aria-selected="status === s" :class="['chip', { on: status === s }]" @click="status = s">
          {{ s === 'all' ? t('resource.filter.all') : t(`course.status.${s}`) }}
        </button>
      </div>
      <div class="selects">
        <select v-model="authorId" class="field" :aria-label="t('resource.filter.author')">
          <option value="">{{ t('resource.filter.author') }}</option>
          <option v-for="[id, name] in authors" :key="id" :value="id">{{ name }}</option>
        </select>
        <select v-model="tag" class="field" :aria-label="t('resource.filter.tag')">
          <option value="">{{ t('resource.filter.tag') }}</option>
          <option v-for="tg in tags" :key="tg" :value="tg">{{ tg }}</option>
        </select>
      </div>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('course.col.title') }}</th><th>{{ t('course.col.duration') }}</th><th>{{ t('course.col.resultMode') }}</th>
            <th>{{ t('course.col.author') }}</th><th>{{ t('course.col.updated') }}</th><th>{{ t('course.col.published') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in visible" :key="c.id" class="row" tabindex="0" @click="navigateTo(`/admin/courses/${c.id}`)" @keydown.enter="navigateTo(`/admin/courses/${c.id}`)">
            <td>
              <b>{{ c.title }}</b>
              <span class="sub">{{ t('course.meta', { code: c.code || '—', sections: t('course.sectionsN', { n: c.sections }), items: t('course.itemsN', { n: c.items }) }) }}</span>
            </td>
            <td>{{ c.durationDays ? t('course.daysN', { n: c.durationDays }) : '—' }}</td>
            <td>{{ t(`course.resultMode.${c.resultMode}`) }}</td>
            <td class="muted">{{ shortName(c.authorName) }}</td>
            <td class="muted">{{ formatShortDate(new Date(c.updatedAt)) }}</td>
            <td><span :class="['badge upper', c.status]">{{ t(`course.status.${c.status}`) }}</span></td>
          </tr>
          <tr v-if="visible.length === 0"><td colspan="6" class="empty">{{ t('course.empty') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="formOpen" class="modal-backdrop" @click.self="formOpen = false">
      <form class="modal card" @submit.prevent="create">
        <h2 class="panel-title">{{ t('course.card') }}</h2>
        <label><span class="label">{{ t('course.newTitle') }}</span><input v-model="form.title" class="field" required minlength="3" maxlength="200" autofocus></label>
        <label><span class="label">{{ t('course.description') }}</span><textarea v-model="form.summary" class="field" rows="2" maxlength="300" /></label>
        <div class="grid2">
          <label><span class="label">{{ t('course.code') }}</span><input v-model="form.code" class="field" maxlength="40"></label>
          <label><span class="label">{{ t('course.durationDays') }}</span><input v-model.number="form.durationDays" class="field" type="number" min="1" max="3650"></label>
        </div>
        <label><span class="label">{{ t('course.workload') }}</span><input v-model="form.workload" class="field" maxlength="200"></label>
        <fieldset class="modes">
          <legend class="label">{{ t('course.resultModeLabel') }}</legend>
          <label v-for="m in COURSE_RESULT_MODES" :key="m" class="radio"><input v-model="form.resultMode" type="radio" name="resultMode" :value="m"> {{ t(`course.resultMode.${m}`) }}</label>
        </fieldset>
        <div class="modal-actions">
          <button type="button" class="btn ghost" @click="formOpen = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn primary" :disabled="busy || form.title.trim().length < 3">{{ t('course.create') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.filters { display: grid; gap: var(--space-3); margin-bottom: var(--space-3); }
.selects { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 240px)); gap: var(--space-2); }
.row { cursor: pointer; }
.row:hover td, .row:focus-visible td { background: var(--color-bg-line-soft); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 0.4); display: grid; place-items: center; padding: var(--space-4); z-index: 20; }
.modal { width: min(560px, 100%); display: grid; gap: var(--space-3); max-height: 100%; overflow: auto; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.modes { border: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.radio { display: flex; gap: var(--space-2); align-items: center; font-weight: 700; }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
@media (max-width: 600px) { .grid2 { grid-template-columns: 1fr; } }
</style>

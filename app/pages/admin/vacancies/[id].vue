<script setup lang="ts">
/**
 * Картка вакансії — `/admin/vacancies/:id` (docs/v2/29-vacancies.md §5.2, §6.1, Г-29.2, Г-29.3).
 *
 * Дві речі, заради яких екран існує саме таким:
 * 1. **Публікація — окрема дія**, а не побічний ефект збереження (Г-29.2). Сервер перевіряє
 *    курс, точку, рекрутера й неперевірений ШІ-текст і повертає, чого саме бракує.
 * 2. **Правка не чіпає створених призначень** (§7.12). Тому поруч із блоком параметрів
 *    стоїть рядок «Зміни вплинуть лише на нові відгуки. Кандидатів у роботі: N» — число
 *    рахує сервер, сторінка його лише показує.
 */
import type { VacancyState } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'vacancy.view' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const id = route.params.id as string

interface Criterion { id: string, name: string, weight: string, scaleMin: string, scaleMax: string, isCritical: boolean, origin: string }
interface Card {
  id: string
  title: string
  state: VacancyState
  courseId: string | null
  courseTitle: string | null
  locationId: string | null
  recruiterId: string | null
  recruiterName: string | null
  employmentType: string | null
  workFormat: string | null
  city: string | null
  salaryFrom: string | null
  salaryTo: string | null
  salaryVisible: boolean
  publicEnabled: boolean
  publicToken: string | null
  closeReason: string | null
  candidatesInProgress: number
  assignmentTemplate: { dueMode: string, dueDays: number | null, isMandatory: boolean, params: Record<string, unknown> }
  criteria: Criterion[]
}
interface Option { id: string, title?: string, name?: string }

const card = ref<Card | null>(null)
const courses = ref<Option[]>([])
const locations = ref<Option[]>([])
const error = ref('')
const notice = ref('')
const busy = ref('')

const form = reactive({ title: '', courseId: '', locationId: '', city: '', employmentType: '', dueDays: 3, passScore: '' })
const criterion = reactive({ name: '', weight: 1, scaleMin: 0, scaleMax: 5, isCritical: false })

function fill(v: Card) {
  card.value = v
  form.title = v.title
  form.courseId = v.courseId ?? ''
  form.locationId = v.locationId ?? ''
  form.city = v.city ?? ''
  form.employmentType = v.employmentType ?? ''
  form.dueDays = v.assignmentTemplate.dueDays ?? 3
  form.passScore = v.assignmentTemplate.params.passScore === undefined ? '' : String(v.assignmentTemplate.params.passScore)
}

async function load() {
  error.value = ''
  busy.value = 'load'
  try {
    fill(await api<Card>(`/vacancies/${id}`))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
  // Справочники — отдельной попыткой: у рекрутера может не быть `course.view` и `people.view`,
  // и это не повод не показать карточку. Пустой селект честнее пустого экрана.
  try {
    courses.value = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(c => c.status === 'published')
    locations.value = await api<Option[]>('/refs/locations')
  }
  catch { /* нет прав на справочник — селекты остаются пустыми */ }
}
onMounted(load)

async function save() {
  error.value = ''
  notice.value = ''
  busy.value = 'save'
  try {
    const body = {
      title: form.title,
      courseId: form.courseId || null,
      locationId: form.locationId || null,
      city: form.city || null,
      employmentType: form.employmentType || null,
      assignmentTemplate: {
        dueMode: 'relative',
        dueDays: Number(form.dueDays) || null,
        isMandatory: true,
        params: form.passScore === '' ? {} : { passScore: Number(form.passScore) },
        notifyOnAssign: true,
      },
    }
    fill(await api<Card>(`/vacancies/${id}`, { method: 'PATCH', body }))
    notice.value = t('vacancies.savedOnlyNew', { n: card.value?.candidatesInProgress ?? 0 })
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

/** Публікація, пауза, закриття, нове посилання — окремі дії §4 з перевірками на сервері. */
async function act(path: string, body?: Record<string, unknown>) {
  error.value = ''
  notice.value = ''
  busy.value = path
  try {
    fill(await api<Card>(`/vacancies/${id}/${path}`, { method: 'POST', body: body ?? {} }))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function addCriterion() {
  error.value = ''
  busy.value = 'criterion'
  try {
    await api(`/vacancies/${id}/criteria`, { method: 'POST', body: { ...criterion } })
    criterion.name = ''
    fill(await api<Card>(`/vacancies/${id}`))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function removeCriterion(cid: string) {
  busy.value = cid
  try {
    await api(`/vacancies/${id}/criteria/${cid}`, { method: 'DELETE' })
    fill(await api<Card>(`/vacancies/${id}`))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function saveTemplate() {
  error.value = ''
  busy.value = 'template'
  try {
    await api(`/vacancy-templates/from-vacancy/${id}`, { method: 'POST', body: { name: `${form.title} — ${new Date().toISOString().slice(0, 10)}` } })
    notice.value = t('vacancies.tpl.saved')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

const tone = (s: VacancyState) => (s === 'published' ? 'teal' : s === 'paused' ? 'sun' : s === 'draft' ? 'ink' : 'muted')
</script>

<template>
  <div v-if="card">
    <PageHeader :title="card.title" :subtitle="t('vacancies.cardHint')" :crumbs="[{ label: t('vacancies.title'), to: '/admin/vacancies' }, { label: card.title }]">
      <template #actions>
        <span :class="['badge', `tone-${tone(card.state)}`]">{{ t(`vacancy.state.${card.state}`) }}</span>
      </template>
    </PageHeader>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div class="actions">
      <button class="btn primary" type="button" :disabled="busy === 'save'" @click="save">{{ t('common.save') }}</button>
      <button
        v-if="card.state !== 'published'" class="btn" type="button"
        :disabled="busy === 'publish'" @click="act('publish')"
      >
        {{ t('vacancies.publish') }}
      </button>
      <button v-if="card.state === 'published'" class="btn" type="button" :disabled="busy === 'pause'" @click="act('pause')">
        {{ t('vacancies.pause') }}
      </button>
      <button
        v-if="card.state === 'published' || card.state === 'paused'" class="btn" type="button"
        :disabled="busy === 'close'" @click="act('close', { reason: 'filled' })"
      >
        {{ t('vacancies.close') }}
      </button>
      <button v-if="card.publicEnabled" class="btn ghost" type="button" :disabled="busy === 'rotate-token'" @click="act('rotate-token')">
        {{ t('vacancies.rotate') }}
      </button>
      <button class="btn ghost" type="button" :disabled="busy === 'template'" @click="saveTemplate">{{ t('vacancies.tpl.save') }}</button>
    </div>

    <section class="panel">
      <h2>{{ t('vacancies.sec.main') }}</h2>
      <div class="grid">
        <label>{{ t('vacancies.f.title') }}
          <input v-model="form.title" maxlength="200">
        </label>
        <label>{{ t('vacancies.f.course') }}
          <select v-model="form.courseId">
            <option value="">{{ t('vacancies.f.notChosen') }}</option>
            <option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option>
          </select>
        </label>
        <label>{{ t('vacancies.f.location') }}
          <select v-model="form.locationId">
            <option value="">{{ t('vacancies.f.notChosen') }}</option>
            <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </label>
        <label>{{ t('vacancies.f.city') }}
          <input v-model="form.city" maxlength="120">
        </label>
        <label>{{ t('vacancies.f.employment') }}
          <select v-model="form.employmentType">
            <option value="">{{ t('vacancies.f.notChosen') }}</option>
            <option v-for="e in (['full_time', 'part_time', 'shift', 'temporary', 'internship', 'contract'] as const)" :key="e" :value="e">
              {{ t(`vacancy.employment.${e}`) }}
            </option>
          </select>
        </label>
      </div>
      <p v-if="card.publicToken" class="sub">{{ t('vacancies.f.link') }}: <code>/j/{{ card.publicToken }}</code></p>
    </section>

    <section class="panel">
      <h2>{{ t('vacancies.sec.template') }}</h2>
      <p class="sub">{{ t('vacancies.templateHint') }}</p>
      <div class="grid">
        <label>{{ t('vacancies.f.dueDays') }}
          <input v-model.number="form.dueDays" type="number" min="1" max="365">
        </label>
        <label>{{ t('vacancies.f.passScore') }}
          <input v-model="form.passScore" type="number" min="0" max="100">
        </label>
      </div>
      <p class="note sun">{{ t('vacancies.savedOnlyNew', { n: card.candidatesInProgress }) }}</p>
    </section>

    <section class="panel">
      <h2>{{ t('vacancies.sec.criteria') }}</h2>
      <p class="sub">{{ t('vacancies.criteriaHint') }}</p>
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('vacancies.c.name') }}</th>
            <th>{{ t('vacancies.c.weight') }}</th>
            <th>{{ t('vacancies.c.scale') }}</th>
            <th>{{ t('vacancies.c.critical') }}</th>
            <th><span class="sr-only">{{ t('common.delete') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in card.criteria" :key="c.id">
            <td>{{ c.name }}</td>
            <td>{{ c.weight }}</td>
            <td>{{ c.scaleMin }}–{{ c.scaleMax }}</td>
            <td>{{ c.isCritical ? t('common.yes') : t('common.no') }}</td>
            <td>
              <button class="btn ghost" type="button" :disabled="busy === c.id" @click="removeCriterion(c.id)">
                {{ t('common.delete') }}
              </button>
            </td>
          </tr>
          <tr v-if="!card.criteria.length"><td colspan="5" class="sub">{{ t('vacancies.c.empty') }}</td></tr>
        </tbody>
      </table>
      <div class="grid">
        <label>{{ t('vacancies.c.name') }}
          <input v-model="criterion.name" maxlength="120">
        </label>
        <label>{{ t('vacancies.c.weight') }}
          <input v-model.number="criterion.weight" type="number" min="0.1" max="100" step="0.1">
        </label>
        <label>{{ t('vacancies.c.min') }}
          <input v-model.number="criterion.scaleMin" type="number">
        </label>
        <label>{{ t('vacancies.c.max') }}
          <input v-model.number="criterion.scaleMax" type="number">
        </label>
        <label class="check">
          <input v-model="criterion.isCritical" type="checkbox">{{ t('vacancies.c.critical') }}
        </label>
      </div>
      <button class="btn" type="button" :disabled="busy === 'criterion' || !criterion.name" @click="addCriterion">
        {{ t('common.add') }}
      </button>
    </section>
  </div>
  <p v-else-if="error" class="error" role="alert">{{ error }}</p>
</template>

<style scoped>
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--space-2); }
.check { display: flex; align-items: center; gap: var(--space-1); }
.table { width: 100%; border-collapse: collapse; margin-bottom: var(--space-3); }
.table th, .table td { text-align: left; padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
.badge { display: inline-block; padding: var(--space-1) var(--space-2); border-radius: var(--radius-pill); }
.tone-teal { background: var(--color-teal-soft); }
.tone-sun { background: var(--color-sun-soft); }
.tone-ink { background: var(--color-bg-soft); }
.tone-muted { background: var(--color-bg-soft); color: var(--color-ink-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 480px) {
  .grid { grid-template-columns: 1fr; }
  .actions { flex-direction: column; align-items: stretch; }
  .panel { overflow-x: auto; }
}
</style>

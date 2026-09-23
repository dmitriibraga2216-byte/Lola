<script setup lang="ts">
/**
 * Реєстр вакансій — `/admin/vacancies` (docs/v2/29-vacancies.md §5.1, Г-29.1).
 *
 * Колонки відповідають задачі рекрутера «де що горить»: окремо стан, окремо кандидати в
 * роботі, окремо публічне посилання. Рахує все сервер (CLAUDE.md п. 3) — сторінка лише
 * показує; посилання й токен вона не вигадує.
 */
import type { VacancyState } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'vacancy.view' })

const { t } = useI18n()
const { api } = useApi()

interface Row {
  id: string
  title: string
  state: VacancyState
  recruiterName: string | null
  courseTitle: string | null
  publicEnabled: boolean
  candidatesInProgress: number
  createdAt: string
}
interface Template { id: string, name: string, usageCount: number }

const rows = ref<Row[]>([])
const templates = ref<Template[]>([])
const tab = ref<'vacancies' | 'templates'>('vacancies')
const q = ref('')
const state = ref<'' | VacancyState>('')
const error = ref('')
const busy = ref(false)

async function load() {
  error.value = ''
  busy.value = true
  try {
    const res = await api<{ items: Row[] }>('/vacancies', {
      query: { ...(q.value ? { q: q.value } : {}), ...(state.value ? { state: state.value } : {}) },
    })
    rows.value = res.items
    const tpl = await api<{ items: Template[] }>('/vacancy-templates')
    templates.value = tpl.items
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
onMounted(load)

const router = useRouter()

/** «Нова вакансія» — чернетка: публікація окрема дія зі своїми перевірками (§4, Г-29.2). */
async function create() {
  error.value = ''
  busy.value = true
  try {
    const v = await api<{ id: string }>('/vacancies', { method: 'POST', body: { title: t('vacancies.newTitle') } })
    await router.push(`/admin/vacancies/${v.id}`)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function fromTemplate(id: string) {
  error.value = ''
  busy.value = true
  try {
    const v = await api<{ id: string }>(`/vacancies/from-template/${id}`, { method: 'POST', body: {} })
    await router.push(`/admin/vacancies/${v.id}`)
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

const dateOf = (v: string) => new Date(v).toLocaleDateString('uk', { day: '2-digit', month: '2-digit', year: 'numeric' })
/** Бейдж стану у кольорах бренду (Г-29.3): чернетка — чорнило, опубліковано — бірюза, пауза — сонце. */
const tone = (s: VacancyState) => (s === 'published' ? 'teal' : s === 'paused' ? 'sun' : s === 'draft' ? 'ink' : 'muted')
</script>

<template>
  <div>
    <PageHeader :title="t('vacancies.title')" :subtitle="t('vacancies.hint')">
      <template #actions>
        <button class="btn primary" type="button" :disabled="busy" @click="create">{{ t('vacancies.new') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <div class="tabs" role="tablist">
      <button role="tab" :aria-selected="tab === 'vacancies'" :class="['tab', { on: tab === 'vacancies' }]" @click="tab = 'vacancies'">
        {{ t('vacancies.tab.vacancies') }}
      </button>
      <button role="tab" :aria-selected="tab === 'templates'" :class="['tab', { on: tab === 'templates' }]" @click="tab = 'templates'">
        {{ t('vacancies.tab.templates') }}
      </button>
    </div>

    <div v-if="tab === 'vacancies'" class="filters">
      <label class="grow">{{ t('common.search') }}
        <input v-model="q" maxlength="200" @keyup.enter="load">
      </label>
      <label>{{ t('vacancies.col.state') }}
        <select v-model="state" @change="load">
          <option value="">{{ t('vacancies.allStates') }}</option>
          <option v-for="s in (['draft', 'published', 'paused', 'closed', 'archived'] as const)" :key="s" :value="s">
            {{ t(`vacancy.state.${s}`) }}
          </option>
        </select>
      </label>
      <button class="btn" type="button" :disabled="busy" @click="load">{{ t('vacancies.apply') }}</button>
    </div>

    <section v-if="tab === 'vacancies'" class="panel">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('vacancies.col.title') }}</th>
            <th>{{ t('vacancies.col.course') }}</th>
            <th>{{ t('vacancies.col.recruiter') }}</th>
            <th>{{ t('vacancies.col.inWork') }}</th>
            <th>{{ t('vacancies.col.link') }}</th>
            <th>{{ t('vacancies.col.state') }}</th>
            <th>{{ t('vacancies.col.created') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in rows" :key="v.id">
            <td><NuxtLink class="link" :to="`/admin/vacancies/${v.id}`">{{ v.title }}</NuxtLink></td>
            <td>{{ v.courseTitle ?? '—' }}</td>
            <td>{{ v.recruiterName ?? '—' }}</td>
            <td>{{ v.candidatesInProgress }}</td>
            <td>{{ v.publicEnabled ? t('vacancies.linkOn') : '—' }}</td>
            <td><span :class="['badge', `tone-${tone(v.state)}`]">{{ t(`vacancy.state.${v.state}`) }}</span></td>
            <td>{{ dateOf(v.createdAt) }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="7" class="sub">{{ t('vacancies.empty') }}</td></tr>
        </tbody>
      </table>
    </section>

    <section v-else class="panel">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('vacancies.tpl.name') }}</th>
            <th>{{ t('vacancies.tpl.used') }}</th>
            <th><span class="sr-only">{{ t('vacancies.tpl.apply') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="tpl in templates" :key="tpl.id">
            <td>{{ tpl.name }}</td>
            <td>{{ tpl.usageCount }}</td>
            <td>
              <button class="btn ghost" type="button" :disabled="busy" @click="fromTemplate(tpl.id)">
                {{ t('vacancies.tpl.apply') }}
              </button>
            </td>
          </tr>
          <tr v-if="!templates.length"><td colspan="3" class="sub">{{ t('vacancies.tpl.empty') }}</td></tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.grow { flex: 1 1 14rem; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { color: var(--color-ink); border-color: var(--color-ink); }
.table { width: 100%; border-collapse: collapse; }
.table th, .table td { text-align: left; padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-bg-line); }
.badge { display: inline-block; padding: var(--space-1) var(--space-2); border-radius: var(--radius-pill); }
.tone-teal { background: var(--color-teal-soft); }
.tone-sun { background: var(--color-sun-soft); }
.tone-ink { background: var(--color-bg-soft); }
.tone-muted { background: var(--color-bg-soft); color: var(--color-ink-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .panel { overflow-x: auto; }
}
</style>

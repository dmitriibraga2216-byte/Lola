<script setup lang="ts">
/**
 * Реєстр вакансій — `/admin/vacancies` (docs/v2/29-vacancies.md §5.1, Г-29.1).
 *
 * Колонки відповідають задачі рекрутера «де що горить»: окремо стан, окремо кандидати в
 * роботі, окремо публічне посилання. Рахує все сервер (CLAUDE.md п. 3) — сторінка лише
 * показує; посилання й токен вона не вигадує.
 */
import type { VacancyState } from '#shared/enums'
const { formatDate } = useFormat()

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'vacancy.view' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()

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
interface Account { id: string, provider: string, ownerType: string, ownerName: string | null, label: string | null, status: string }

const rows = ref<Row[]>([])
const templates = ref<Template[]>([])
const accounts = ref<Account[]>([])
const tab = ref<'vacancies' | 'templates' | 'integrations'>(route.query.tab === 'integrations' ? 'integrations' : 'vacancies')
const q = ref('')
const state = ref<'' | VacancyState>('')
const error = ref('')
const busy = ref(false)

const connectForm = reactive({ provider: 'work_ua' as 'work_ua' | 'robota_ua' | 'telegram', ownerType: 'company' as 'company' | 'personal' | 'recruiter', label: '' })

async function loadAccounts() {
  try { accounts.value = (await api<{ items: Account[] }>('/job-board-accounts')).items }
  catch { accounts.value = [] }
}

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
  await loadAccounts()
}
onMounted(load)

/** Підключення (docs/v2/29 §7.14): синхронне, заглушка не робить мережевого виклику. */
async function connectAccount() {
  error.value = ''
  busy.value = true
  try {
    await api('/job-board-accounts', { method: 'POST', body: { ...connectForm, label: connectForm.label || null } })
    connectForm.label = ''
    await loadAccounts()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function disconnectAccount(id: string) {
  busy.value = true
  try {
    await api(`/job-board-accounts/${id}/disconnect`, { method: 'POST' })
    await loadAccounts()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

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

const dateOf = (v: string) => formatDate(new Date(v), { day: '2-digit', month: '2-digit', year: 'numeric' })
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
      <button role="tab" :aria-selected="tab === 'integrations'" :class="['tab', { on: tab === 'integrations' }]" @click="tab = 'integrations'">
        {{ t('vacancies.tab.integrations') }}
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

    <section v-else-if="tab === 'templates'" class="panel">
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

    <section v-else class="panel">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('vacancies.pub.account') }}</th>
            <th>{{ t('vacancies.integrations.ownerType') }}</th>
            <th>{{ t('vacancies.col.state') }}</th>
            <th><span class="sr-only">{{ t('vacancies.integrations.disconnect') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in accounts" :key="a.id">
            <td>{{ t(`vacancy.jobBoardProvider.${a.provider}`) }}{{ a.label ? ` — ${a.label}` : '' }}</td>
            <td>{{ t(`vacancy.jobBoardOwnerType.${a.ownerType}`) }}{{ a.ownerName ? ` (${a.ownerName})` : '' }}</td>
            <td>{{ t(`vacancy.jobBoardStatus.${a.status}`) }}</td>
            <td>
              <button v-if="a.status !== 'disabled' && a.status !== 'revoked'" class="btn ghost" type="button" :disabled="busy" @click="disconnectAccount(a.id)">
                {{ t('vacancies.integrations.disconnect') }}
              </button>
            </td>
          </tr>
          <tr v-if="!accounts.length"><td colspan="4" class="sub">{{ t('vacancies.integrations.empty') }}</td></tr>
        </tbody>
      </table>

      <form class="grid connect-form" @submit.prevent="connectAccount">
        <label>{{ t('vacancies.integrations.provider') }}
          <select v-model="connectForm.provider">
            <option v-for="p in (['work_ua', 'robota_ua', 'telegram'] as const)" :key="p" :value="p">{{ t(`vacancy.jobBoardProvider.${p}`) }}</option>
          </select>
        </label>
        <label>{{ t('vacancies.pub.account') }}
          <select v-model="connectForm.ownerType">
            <option v-for="o in (['company', 'personal', 'recruiter'] as const)" :key="o" :value="o">{{ t(`vacancy.jobBoardOwnerType.${o}`) }}</option>
          </select>
        </label>
        <label>{{ t('vacancies.integrations.label') }}
          <input v-model="connectForm.label" maxlength="120">
        </label>
        <button class="btn primary" type="submit" :disabled="busy">{{ t('vacancies.integrations.connect') }}</button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.grow { flex: 1 1 14rem; }
.tabs { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { color: var(--color-ink); border-color: var(--color-ink); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: var(--space-2); }
.connect-form { align-items: end; margin-top: var(--space-3); }
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
  .grid { grid-template-columns: 1fr; }
}
</style>

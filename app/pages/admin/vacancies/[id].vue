<script setup lang="ts">
/**
 * Картка вакансії — `/admin/vacancies/:id` (docs/v2/29-vacancies.md §5.2, §6.1, §7.9–§7.17,
 * Г-29.2, Г-29.3, план `45` PR-17).
 *
 * Три речі, заради яких екран існує саме таким:
 * 1. **Публікація — окрема дія**, а не побічний ефект збереження (Г-29.2). Сервер перевіряє
 *    курс, точку, рекрутера й неперевірений ШІ-текст і повертає, чого саме бракує.
 * 2. **Правка не чіпає створених призначень** (§7.12). Тому поруч із блоком параметрів
 *    стоїть рядок «Зміни вплинуть лише на нові відгуки. Кандидатів у роботі: N» — число
 *    рахує сервер, сторінка його лише показує.
 * 3. **ШІ генерує текст, людина відповідає за нього** (інваріант 18): кнопка «Створити з AI»
 *    поруч із кожним блоком, а публікація заблокована, поки блок не відредаговано або не
 *    підтверджено — сервер це перевіряє незалежно від того, що показує ця сторінка.
 */
import type { VacancyState } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'vacancy.view' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const id = route.params.id as string

interface Criterion { id: string, name: string, weight: string, scaleMin: string, scaleMax: string, isCritical: boolean, origin: string }
interface AiBlockMeta { editedAt: string | null, acknowledged: boolean }
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
  descriptionHtml: string | null
  requirementsHtml: string | null
  dutiesHtml: string | null
  extraHtml: string | null
  aiBlocks: Record<string, AiBlockMeta>
  assignmentTemplate: { dueMode: string, dueDays: number | null, isMandatory: boolean, params: Record<string, unknown> }
  criteria: Criterion[]
}
interface Option { id: string, title?: string, name?: string }
interface Account { id: string, provider: string, ownerType: string, ownerUserId: string | null, ownerName: string | null, label: string | null, status: string }
interface Publication { id: string, accountId: string, provider: string, ownerType: string, state: string, externalUrl: string | null, lastError: string | null }
interface Application { id: string, fullName: string, phone: string | null, email: string | null, source: string, spamReasons: string[], resumeAssetId: string | null, createdAt: string }

/** Поле форми ↔ ціль генерації (`vacancy_ai_generations.target`, `29` §3.10). */
const AI_FIELDS = [
  ['descriptionHtml', 'description'],
  ['requirementsHtml', 'requirements'],
  ['dutiesHtml', 'duties'],
  ['extraHtml', 'extra'],
] as const
type AiField = typeof AI_FIELDS[number][0]

const card = ref<Card | null>(null)
const courses = ref<Option[]>([])
const locations = ref<Option[]>([])
const accounts = ref<Account[]>([])
const publications = ref<Publication[]>([])
const applications = ref<Application[]>([])
const appTab = ref<'pending' | 'pending_review' | 'accepted' | 'spam' | 'rejected'>('pending')
const error = ref('')
const notice = ref('')
const busy = ref('')

const form = reactive({
  title: '', courseId: '', locationId: '', city: '', employmentType: '', dueDays: 3, passScore: '',
  descriptionHtml: '', requirementsHtml: '', dutiesHtml: '', extraHtml: '',
})
const criterion = reactive({ name: '', weight: 1, scaleMin: 0, scaleMax: 5, isCritical: false })
const criteriaDraft = ref<{ name: string, description: string, weight: number }[]>([])
const lastGenerationId = reactive<Partial<Record<AiField, string>>>({})
const selectedAccountIds = ref<string[]>([])
const manualPub = reactive({ accountId: '', externalUrl: '' })

function fill(v: Card) {
  card.value = v
  form.title = v.title
  form.courseId = v.courseId ?? ''
  form.locationId = v.locationId ?? ''
  form.city = v.city ?? ''
  form.employmentType = v.employmentType ?? ''
  form.dueDays = v.assignmentTemplate.dueDays ?? 3
  form.passScore = v.assignmentTemplate.params.passScore === undefined ? '' : String(v.assignmentTemplate.params.passScore)
  form.descriptionHtml = v.descriptionHtml ?? ''
  form.requirementsHtml = v.requirementsHtml ?? ''
  form.dutiesHtml = v.dutiesHtml ?? ''
  form.extraHtml = v.extraHtml ?? ''
}

async function loadPublications() {
  try { publications.value = (await api<{ items: Publication[] }>(`/vacancies/${id}/publications`)).items }
  catch { publications.value = [] }
}

async function loadApplications() {
  try { applications.value = (await api<{ items: Application[] }>(`/vacancies/${id}/applications`, { query: { state: appTab.value } })).items }
  catch { applications.value = [] }
}
watch(appTab, loadApplications)

async function load() {
  error.value = ''
  busy.value = 'load'
  try {
    fill(await api<Card>(`/vacancies/${id}`))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
  // Довідники й інтеграції — окремими спробами: у рекрутера може не бути прав на них,
  // і це не привід не показати картку. Порожній список чесніший за порожній екран.
  try {
    courses.value = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(c => c.status === 'published')
    locations.value = await api<Option[]>('/refs/locations')
  }
  catch { /* нет прав на справочник — селекты остаются пустыми */ }
  try {
    accounts.value = (await api<{ items: Account[] }>('/job-board-accounts')).items
  }
  catch { /* нет скоупа jobboard.connect */ }
  await Promise.all([loadPublications(), loadApplications()])
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
      descriptionHtml: form.descriptionHtml || null,
      requirementsHtml: form.requirementsHtml || null,
      dutiesHtml: form.dutiesHtml || null,
      extraHtml: form.extraHtml || null,
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

// ── ШІ: текст блоку і чернетка критеріїв (§7.10–§7.11) ────────────────────────────────────

async function generateAi(field: AiField, target: string) {
  error.value = ''
  busy.value = `ai:${field}`
  try {
    const r = await api<{ html: string, generationId: string }>(`/vacancies/${id}/ai-text`, { method: 'POST', body: { target } })
    form[field] = r.html
    lastGenerationId[field] = r.generationId
    fill(await api<Card>(`/vacancies/${id}`))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

function isUnreviewed(target: string): boolean {
  const meta = card.value?.aiBlocks?.[target]
  return !!meta && !meta.editedAt && !meta.acknowledged
}

async function acknowledgeAi(field: AiField) {
  const gid = lastGenerationId[field]
  if (!gid) return
  busy.value = `ack:${field}`
  try {
    fill(await api<Card>(`/vacancies/${id}/ai-text/${gid}/acknowledge`, { method: 'POST' }))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function generateCriteria() {
  error.value = ''
  busy.value = 'criteria-ai'
  try {
    const r = await api<{ criteria: { name: string, description: string, weight: number }[] }>(`/vacancies/${id}/criteria/generate`, { method: 'POST' })
    criteriaDraft.value = r.criteria
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function acceptDraft(i: number) {
  const d = criteriaDraft.value[i]!
  busy.value = `draft:${i}`
  try {
    await api(`/vacancies/${id}/criteria`, { method: 'POST', body: { name: d.name, description: d.description, weight: d.weight, scaleMin: 0, scaleMax: 5, isCritical: false, origin: 'ai' } })
    criteriaDraft.value = criteriaDraft.value.filter((_, idx) => idx !== i)
    fill(await api<Card>(`/vacancies/${id}`))
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

// ── Публікації на майданчиках (§7.13–§7.17) ────────────────────────────────────────────────

async function publish() {
  error.value = ''
  busy.value = 'pub'
  try {
    await api(`/vacancies/${id}/publications`, { method: 'POST', body: { confirm: true, accountIds: selectedAccountIds.value } })
    selectedAccountIds.value = []
    await loadPublications()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function publishManual() {
  error.value = ''
  busy.value = 'pub-manual'
  try {
    await api(`/vacancies/${id}/publications`, { method: 'POST', body: { confirm: true, manual: { accountId: manualPub.accountId, externalUrl: manualPub.externalUrl } } })
    manualPub.accountId = ''
    manualPub.externalUrl = ''
    await loadPublications()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

async function removePublication(pid: string) {
  busy.value = pid
  try {
    await api(`/vacancies/${id}/publications/${pid}`, { method: 'DELETE' })
    await loadPublications()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

// ── Відгуки (карточка §5.5, API вже готовий з PR-16) ───────────────────────────────────────

async function decide(aid: string, action: 'accept' | 'reject' | 'spam') {
  busy.value = aid
  try {
    await api(`/vacancies/${id}/applications/${aid}/${action}`, { method: 'POST', body: action === 'reject' ? { reason: 'no_fit' } : {} })
    await loadApplications()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

const tone = (s: VacancyState) => (s === 'published' ? 'teal' : s === 'paused' ? 'sun' : s === 'draft' ? 'ink' : 'muted')
const activeAccounts = computed(() => accounts.value.filter(a => a.status === 'active'))
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
      <h2>{{ t('vacancies.sec.blocks') }}</h2>
      <div v-for="[field, target] in AI_FIELDS" :key="field" class="ai-block">
        <div class="ai-head">
          <label class="grow">{{ t(`vacancy.blocks.${target}`) }}</label>
          <button class="btn ghost small" type="button" :disabled="busy === `ai:${field}`" @click="generateAi(field, target)">
            {{ busy === `ai:${field}` ? t('vacancies.ai.generating') : t('vacancies.ai.generate') }}
          </button>
        </div>
        <textarea v-model="form[field]" rows="4" maxlength="20000" />
        <p v-if="isUnreviewed(target)" class="note coral">
          {{ t('vacancies.ai.unreviewed') }}
          <button class="btn ghost small" type="button" :disabled="!lastGenerationId[field] || busy === `ack:${field}`" @click="acknowledgeAi(field)">
            {{ t('vacancies.ai.acknowledge') }}
          </button>
        </p>
      </div>
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
      <div class="actions">
        <button class="btn" type="button" :disabled="busy === 'criterion' || !criterion.name" @click="addCriterion">
          {{ t('common.add') }}
        </button>
        <button class="btn ghost" type="button" :disabled="busy === 'criteria-ai'" @click="generateCriteria">
          {{ t('vacancies.ai.criteriaGenerate') }}
        </button>
      </div>
      <div v-if="criteriaDraft.length" class="draft">
        <p class="sub">{{ t('vacancies.ai.criteriaDraftHint') }}</p>
        <div v-for="(d, i) in criteriaDraft" :key="i" class="draft-row">
          <div class="grow">
            <strong>{{ d.name }}</strong>
            <p class="sub">{{ d.description }}</p>
          </div>
          <button class="btn ghost small" type="button" :disabled="busy === `draft:${i}`" @click="acceptDraft(i)">{{ t('vacancies.ai.addDraft') }}</button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h2>{{ t('vacancies.pub.title') }}</h2>
      <p v-if="!accounts.length" class="sub">
        {{ t('vacancies.pub.noAccounts') }}
        <NuxtLink class="link" to="/admin/vacancies?tab=integrations">{{ t('vacancies.pub.goIntegrations') }}</NuxtLink>
      </p>
      <table v-if="publications.length" class="table">
        <thead>
          <tr>
            <th>{{ t('vacancies.pub.account') }}</th>
            <th>{{ t('vacancies.col.state') }}</th>
            <th><span class="sr-only">{{ t('vacancies.pub.removeAction') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in publications" :key="p.id">
            <td>{{ t(`vacancy.jobBoardProvider.${p.provider}`) }} · {{ t(`vacancy.jobBoardOwnerType.${p.ownerType}`) }}</td>
            <td>
              <a v-if="p.externalUrl" :href="p.externalUrl" target="_blank" rel="noopener">{{ t(`vacancy.publicationState.${p.state}`) }}</a>
              <span v-else>{{ t(`vacancy.publicationState.${p.state}`) }}</span>
            </td>
            <td>
              <button
                v-if="['queued', 'active', 'manual', 'conflict', 'failed'].includes(p.state)" class="btn ghost" type="button"
                :disabled="busy === p.id" @click="removePublication(p.id)"
              >
                {{ t('vacancies.pub.removeAction') }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="sub">{{ t('vacancies.pub.empty') }}</p>

      <div v-if="activeAccounts.length" class="grid">
        <label v-for="a in activeAccounts" :key="a.id" class="check">
          <input v-model="selectedAccountIds" type="checkbox" :value="a.id">
          {{ t(`vacancy.jobBoardProvider.${a.provider}`) }} — {{ a.label || t(`vacancy.jobBoardOwnerType.${a.ownerType}`) }}
        </label>
      </div>
      <button v-if="activeAccounts.length" class="btn" type="button" :disabled="!selectedAccountIds.length || busy === 'pub'" @click="publish">
        {{ t('vacancies.pub.publish') }}
      </button>

      <details class="manual">
        <summary>{{ t('vacancies.pub.manualTitle') }}</summary>
        <div class="grid">
          <label>{{ t('vacancies.pub.account') }}
            <select v-model="manualPub.accountId">
              <option value="">{{ t('vacancies.f.notChosen') }}</option>
              <option v-for="a in accounts" :key="a.id" :value="a.id">{{ t(`vacancy.jobBoardProvider.${a.provider}`) }} — {{ a.label || t(`vacancy.jobBoardOwnerType.${a.ownerType}`) }}</option>
            </select>
          </label>
          <label>{{ t('vacancies.pub.manualUrl') }}
            <input v-model="manualPub.externalUrl" type="url" maxlength="2000">
          </label>
        </div>
        <button class="btn ghost" type="button" :disabled="!manualPub.accountId || !manualPub.externalUrl || busy === 'pub-manual'" @click="publishManual">
          {{ t('vacancies.pub.publish') }}
        </button>
      </details>
    </section>

    <section class="panel">
      <h2>{{ t('vacancies.applications.title') }}</h2>
      <div class="tabs" role="tablist">
        <button
          v-for="s in (['pending', 'pending_review', 'accepted', 'spam', 'rejected'] as const)" :key="s" role="tab"
          :aria-selected="appTab === s" :class="['tab', { on: appTab === s }]" @click="appTab = s"
        >
          {{ t(`vacancy.applicationState.${s}`) }}
        </button>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('vacancies.applications.name') }}</th>
            <th>{{ t('vacancies.applications.contact') }}</th>
            <th>{{ t('vacancies.applications.source') }}</th>
            <th>{{ t('vacancies.applications.reasons') }}</th>
            <th><span class="sr-only">{{ t('common.actions') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="app in applications" :key="app.id">
            <td>{{ app.fullName }}</td>
            <td>{{ app.phone || app.email }}</td>
            <td>{{ app.source }}</td>
            <td>{{ app.spamReasons.join(', ') }}</td>
            <td class="row-actions">
              <template v-if="appTab === 'pending' || appTab === 'pending_review'">
                <button class="btn ghost small" type="button" :disabled="busy === app.id" @click="decide(app.id, 'accept')">{{ t('vacancies.applications.accept') }}</button>
                <button class="btn ghost small" type="button" :disabled="busy === app.id" @click="decide(app.id, 'reject')">{{ t('vacancies.applications.reject') }}</button>
                <button class="btn ghost small" type="button" :disabled="busy === app.id" @click="decide(app.id, 'spam')">{{ t('vacancies.applications.spam') }}</button>
              </template>
            </td>
          </tr>
          <tr v-if="!applications.length"><td colspan="5" class="sub">{{ t('vacancies.applications.empty') }}</td></tr>
        </tbody>
      </table>
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
.ai-block { margin-bottom: var(--space-3); }
.ai-head { display: flex; align-items: center; gap: var(--space-2); margin-bottom: var(--space-1); }
.ai-block textarea { width: 100%; font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-md); background: var(--color-bg); color: var(--color-ink); }
.note.coral { background: var(--color-coral-soft); padding: var(--space-2); border-radius: var(--radius-md); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.btn.small { padding: var(--space-1) var(--space-2); font-size: 0.9em; }
.draft { margin-top: var(--space-2); border-top: 1px solid var(--color-bg-line); padding-top: var(--space-2); }
.draft-row { display: flex; align-items: flex-start; gap: var(--space-2); padding: var(--space-1) 0; }
.manual { margin-top: var(--space-3); }
.row-actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.tabs { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-3); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { color: var(--color-ink); border-color: var(--color-ink); }
@media (max-width: 480px) {
  .grid { grid-template-columns: 1fr; }
  .actions { flex-direction: column; align-items: stretch; }
  .panel { overflow-x: auto; }
}
</style>

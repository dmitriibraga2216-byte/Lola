<script setup lang="ts">
/**
 * Сценарій співбесіди — форма docs/v2/30-ai-interview.md §6.1 і критерії §6.2.
 *
 * Опублікований сценарій на місці не правиться: збереження створює нову версію-чернетку з
 * копією критеріїв (`versionCreated`), і екран переходить до неї — ідучі співбесіди тримають
 * свою версію (§12 п. 9). Опублікувати без альтернативи для тих, хто відмовиться від ШІ, чи без
 * критеріїв сервер не дасть (`422 scenario.alternative_required`, `422 criteria.required`) — екран
 * показує текст відмови як є: він пояснює, що зробити.
 */
import { INTERVIEW_ALTERNATIVE_PATHS, INTERVIEW_ANSWER_MODES } from '#shared/enums'
import type { InterviewAlternativePath, InterviewAnswerMode } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'interview.configure' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()

interface Criterion { id: string, name: string, description: string, weight: number, scaleMax: number, isCritical: boolean, source: string }
interface Scenario {
  id: string
  quizTitle: string | null
  name: string
  interviewerName: string
  introText: string
  outroText: string
  answerModes: InterviewAnswerMode[]
  minAnswerSec: number
  maxAnswerSec: number
  thinkTimeSec: number
  retakeLimit: number
  transcribeLang: 'uk' | 'en' | 'ru'
  minConfidence: number
  alternativePath: InterviewAlternativePath | null
  status: 'draft' | 'published' | 'archived'
  version: number
  criteria: Criterion[]
  versionCreated?: boolean
}

const scenario = ref<Scenario | null>(null)
const form = ref<Scenario | null>(null)
const error = ref('')
const notice = ref('')
const busy = ref(false)
const crit = reactive({ name: '', description: '', weight: 1, scaleMax: 5, isCritical: false })

const editable = computed(() => scenario.value?.status !== 'archived')
const draft = computed(() => scenario.value?.status === 'draft')

function take(s: Scenario) {
  scenario.value = s
  form.value = JSON.parse(JSON.stringify(s)) as Scenario
}

async function load() {
  error.value = ''
  try { take(await api<Scenario>(`/interview-scenarios/${route.params.id}`)) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function save(status?: 'published' | 'archived') {
  if (!form.value) return
  busy.value = true
  error.value = ''
  notice.value = ''
  const f = form.value
  try {
    const body = status === 'archived'
      ? { status }
      : {
          name: f.name, interviewerName: f.interviewerName, introText: f.introText, outroText: f.outroText,
          answerModes: f.answerModes, minAnswerSec: f.minAnswerSec, maxAnswerSec: f.maxAnswerSec, thinkTimeSec: f.thinkTimeSec,
          retakeLimit: f.retakeLimit, transcribeLang: f.transcribeLang, minConfidence: f.minConfidence, alternativePath: f.alternativePath,
          ...(status ? { status } : {}),
        }
    const s = await api<Scenario>(`/interview-scenarios/${scenario.value!.id}`, { method: 'PUT', body })
    if (s.id !== scenario.value!.id) {
      // Правка опублікованого — нова версія: переходимо до неї
      await navigateTo(`/admin/settings/interviews/${s.id}`, { replace: true })
      take(s)
      notice.value = t('interviewAdmin.versionCreated', { n: s.version })
      return
    }
    take(s)
    notice.value = status === 'published' ? t('interviewAdmin.published') : t('interviewAdmin.saved')
  }
  catch (err) {
    const e = apiErrorOf(err)
    error.value = e.message
    if (typeof e.details?.draftId === 'string') await navigateTo(`/admin/settings/interviews/${e.details.draftId}`, { replace: true })
  }
  finally { busy.value = false }
}

async function addCriterion() {
  if (!scenario.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/interview-scenarios/${scenario.value.id}/criteria`, { method: 'POST', body: { ...crit, name: crit.name.trim(), description: crit.description.trim() } })
    Object.assign(crit, { name: '', description: '', weight: 1, scaleMax: 5, isCritical: false })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function removeCriterion(id: string) {
  if (!scenario.value) return
  busy.value = true
  try {
    await api(`/interview-scenarios/${scenario.value.id}/criteria/${id}`, { method: 'DELETE' })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

function toggleMode(m: InterviewAnswerMode, on: boolean) {
  if (!form.value) return
  const set = new Set(form.value.answerModes)
  if (on) set.add(m)
  else set.delete(m)
  form.value.answerModes = INTERVIEW_ANSWER_MODES.filter(x => set.has(x))
}
</script>

<template>
  <div v-if="form && scenario">
    <PageHeader
      :title="scenario.name"
      :subtitle="`${scenario.quizTitle ?? '—'} · ${t('interviewAdmin.version', { n: scenario.version })}`"
      :crumbs="[{ label: t('admin.section.people') }, { label: t('interviewAdmin.title'), to: '/admin/settings/interviews' }]"
    >
      <template #actions>
        <span :class="['badge', scenario.status === 'published' ? 'teal' : 'muted']">{{ t(`interviewAdmin.status.${scenario.status}`) }}</span>
        <button v-if="draft" class="btn primary" type="button" :disabled="busy" @click="save('published')">{{ t('interviewAdmin.publish') }}</button>
        <button v-if="editable" class="btn ghost" type="button" :disabled="busy" @click="save('archived')">{{ t('interviewAdmin.archive') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
    <p v-if="scenario.status === 'published'" class="note sun">{{ t('interviewAdmin.publishedHint') }}</p>

    <div class="split">
      <form class="card stack" @submit.prevent="save()">
        <h2 class="panel-title">{{ t('interviewAdmin.form') }}</h2>
        <label class="stack">
          <span class="label">{{ t('interviewAdmin.name') }}</span>
          <input v-model="form.name" class="field" minlength="3" maxlength="200" required :disabled="!editable">
        </label>
        <label class="stack">
          <span class="label">{{ t('interviewAdmin.interviewerName') }}</span>
          <input v-model="form.interviewerName" class="field" minlength="2" maxlength="40" required :disabled="!editable">
          <span class="help">{{ t('interviewAdmin.interviewerHint') }}</span>
        </label>
        <label class="stack">
          <span class="label">{{ t('interviewAdmin.intro') }}</span>
          <textarea v-model="form.introText" class="field" rows="4" minlength="50" maxlength="1500" required :disabled="!editable" />
          <span class="help">{{ t('interviewAdmin.introHint') }}</span>
        </label>
        <label class="stack">
          <span class="label">{{ t('interviewAdmin.outro') }}</span>
          <textarea v-model="form.outroText" class="field" rows="3" minlength="20" maxlength="800" required :disabled="!editable" />
        </label>
        <fieldset class="stack">
          <legend class="label">{{ t('interviewAdmin.modes') }}</legend>
          <label v-for="m in INTERVIEW_ANSWER_MODES" :key="m" class="row">
            <input type="checkbox" :checked="form.answerModes.includes(m)" :disabled="!editable" @change="toggleMode(m, ($event.target as HTMLInputElement).checked)">
            <span>{{ t(`interviewAdmin.mode.${m}`) }}</span>
          </label>
          <span class="help">{{ t('interviewAdmin.modesHint') }}</span>
        </fieldset>
        <div class="grid">
          <label class="stack">
            <span class="label">{{ t('interviewAdmin.maxAnswer') }}</span>
            <input v-model.number="form.maxAnswerSec" class="field" type="number" min="30" max="600" :disabled="!editable">
          </label>
          <label class="stack">
            <span class="label">{{ t('interviewAdmin.think') }}</span>
            <input v-model.number="form.thinkTimeSec" class="field" type="number" min="0" max="120" :disabled="!editable">
          </label>
          <label class="stack">
            <span class="label">{{ t('interviewAdmin.retakes') }}</span>
            <input v-model.number="form.retakeLimit" class="field" type="number" min="0" max="5" :disabled="!editable">
          </label>
          <label class="stack">
            <span class="label">{{ t('interviewAdmin.minConfidence') }}</span>
            <input v-model.number="form.minConfidence" class="field" type="number" min="0.3" max="0.95" step="0.05" :disabled="!editable">
          </label>
        </div>
        <span class="help">{{ t('interviewAdmin.minConfidenceHint') }}</span>
        <label class="stack">
          <span class="label">{{ t('interviewAdmin.lang') }}</span>
          <select v-model="form.transcribeLang" class="field" :disabled="!editable">
            <option v-for="l in (['uk', 'en', 'ru'] as const)" :key="l" :value="l">{{ t(`interviewAdmin.langs.${l}`) }}</option>
          </select>
        </label>
        <label class="row">
          <input type="checkbox" disabled>
          <span>{{ t('interviewAdmin.video') }}</span>
        </label>
        <span class="help">{{ t('interviewAdmin.videoHint') }}</span>
        <fieldset class="stack">
          <legend class="label">{{ t('interviewAdmin.alternative') }}</legend>
          <label v-for="a in INTERVIEW_ALTERNATIVE_PATHS" :key="a" class="row">
            <input v-model="form.alternativePath" type="radio" name="alternative" :value="a" :disabled="!editable">
            <span>{{ t(`interviewAdmin.alt.${a}`) }}</span>
          </label>
          <span class="help">{{ t('interviewAdmin.alternativeHint') }}</span>
        </fieldset>
        <div v-if="editable" class="actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('common.save') }}</button>
        </div>
      </form>

      <section class="card stack">
        <h2 class="panel-title">{{ t('interviewAdmin.criteria') }}</h2>
        <p v-if="!scenario.criteria.length" class="muted">{{ t('interviewAdmin.criteriaEmpty') }}</p>
        <ul class="crit">
          <li v-for="c in scenario.criteria" :key="c.id">
            <div class="grow">
              <strong>{{ c.name }}</strong>
              <span v-if="c.isCritical" class="badge coral">{{ t('interviewAdmin.critical') }}</span>
              <p class="sub">{{ c.description }}</p>
              <p class="sub">{{ t('interviewAdmin.critMeta', { weight: c.weight, max: c.scaleMax }) }}</p>
            </div>
            <button v-if="draft" class="btn ghost small" type="button" :aria-label="t('interviewAdmin.removeCriterion', { name: c.name })" :disabled="busy" @click="removeCriterion(c.id)">✕</button>
          </li>
        </ul>
        <form v-if="draft" class="stack" @submit.prevent="addCriterion">
          <label class="stack">
            <span class="label">{{ t('interviewAdmin.critName') }}</span>
            <input v-model="crit.name" class="field" minlength="3" maxlength="100" required>
          </label>
          <label class="stack">
            <span class="label">{{ t('interviewAdmin.critDescription') }}</span>
            <textarea v-model="crit.description" class="field" rows="3" minlength="20" maxlength="500" required />
            <span class="help">{{ t('interviewAdmin.critDescriptionHint') }}</span>
          </label>
          <div class="grid">
            <label class="stack">
              <span class="label">{{ t('interviewAdmin.critWeight') }}</span>
              <input v-model.number="crit.weight" class="field" type="number" min="0.1" max="10" step="0.1">
            </label>
            <label class="stack">
              <span class="label">{{ t('interviewAdmin.critMax') }}</span>
              <input v-model.number="crit.scaleMax" class="field" type="number" min="2" max="100">
            </label>
          </div>
          <label class="row">
            <input v-model="crit.isCritical" type="checkbox">
            <span>{{ t('interviewAdmin.critical') }}</span>
          </label>
          <div class="actions">
            <button class="btn ghost" type="submit" :disabled="busy || crit.name.trim().length < 3 || crit.description.trim().length < 20">+ {{ t('interviewAdmin.addCriterion') }}</button>
          </div>
        </form>
      </section>
    </div>
  </div>
  <p v-else-if="error" class="note coral" role="alert">{{ error }}</p>
</template>

<style scoped>
.split { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--space-4); align-items: start; }
.stack { display: grid; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); align-items: center; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: var(--space-2); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.crit { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.crit li { display: flex; gap: var(--space-2); align-items: flex-start; border-bottom: 1px solid var(--color-bg-line-soft); padding-bottom: var(--space-2); }
.crit .sub { margin: var(--space-1) 0 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.grow { flex: 1; min-width: 0; }
fieldset { border: none; margin: 0; padding: 0; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
</style>

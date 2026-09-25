<script setup lang="ts">
import { RATER_KINDS, RATER_ROLE_DEFAULTS } from '#shared/enums'
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assessment.run' })
const { t } = useI18n()
const { api } = useApi()
interface Cycle { id: string, title: string, status: string, period_from: string, period_to: string, starts_at: string, ends_at: string, form_title: string, tasks_total: number, tasks_submitted: number, subjects_count: number, rater_kinds: string[] }
const items = ref<Cycle[]>([])
const forms = ref<{ id: string, title: string }[]>([])
const positions = ref<{ id: string, name: string }[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const error = ref('')
const notice = ref('')
const step = ref(1)
const route = useRoute()
/**
 * Запуск со ссылки «людина чекає на оцінювання» с шага траектории (docs/28 §28.21): анкета шага
 * выбрана, человек уже в аудитории — руководителю остаётся выбрать оценщиков и сроки.
 */
const subject = ref<{ id: string, name: string } | null>(null)
const form = reactive({ title: '', formId: '', periodFrom: '', periodTo: '', startsAt: '', endsAt: '', positionIds: [] as string[], locationIds: [] as string[], raterKinds: ['self', 'manager'] as string[], raterRoles: RATER_KINDS.map(k => ({ ...RATER_ROLE_DEFAULTS[k] })), peersCount: 2, anonymousForSubject: true, minRatersToShow: 3, selfFirst: false, calibration: false })
async function load() {
  try {
    items.value = await api('/assessment/cycles'); forms.value = await api('/assessment/forms'); positions.value = await api('/refs/positions'); locations.value = await api('/refs/locations')
    const wantedForm = typeof route.query.formId === 'string' ? route.query.formId : ''
    form.formId ||= forms.value.some(f => f.id === wantedForm) ? wantedForm : forms.value[0]?.id ?? ''
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function loadSubject() {
  const id = typeof route.query.subjectId === 'string' ? route.query.subjectId : ''
  if (!id) return
  try {
    const p = await api<{ id: string, fullName: string }>(`/people/${id}`)
    subject.value = { id: p.id, name: p.fullName }
    form.title ||= `${forms.value.find(f => f.id === form.formId)?.title ?? ''} — ${p.fullName}`
  }
  catch { /* человека нет или нет права смотреть людей — аудиторию выберут сами */ }
}
onMounted(async () => { await load(); await loadSubject() })
async function create() {
  error.value = ''
  const rules: unknown[] = []
  if (subject.value) rules.push({ type: 'user', ids: [subject.value.id] })
  if (form.positionIds.length) rules.push({ type: 'position', ids: form.positionIds, locationIds: form.locationIds.length ? form.locationIds : undefined })
  else if (form.locationIds.length) rules.push({ type: 'location', ids: form.locationIds })
  try {
    const c = await api<{ id: string }>('/assessment/cycles', { method: 'POST', body: { title: form.title, formId: form.formId, periodFrom: form.periodFrom, periodTo: form.periodTo, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(), subjects: { rules, match: 'any' }, raterKinds: form.raterKinds, raterRoles: form.raterRoles.filter(r => form.raterKinds.includes(r.kind)), peersCount: form.peersCount, anonymousForSubject: form.anonymousForSubject, minRatersToShow: form.minRatersToShow, selfFirst: form.selfFirst, calibration: form.calibration } })
    const r = await api<{ tasks: number, subjects: number }>(`/assessment/cycles/${c.id}/start`, { method: 'POST' })
    notice.value = t('assess.started', { subjects: r.subjects, tasks: r.tasks })
    step.value = 1; form.title = ''; subject.value = null
    await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string) => formatShortDate(new Date(d))
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.assessCycles') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('assess.form') }}</th><th>{{ t('assess.window') }}</th><th>{{ t('assess.filled') }}</th><th>{{ t('assign.col.status') }}</th></tr></thead>
      <tbody>
        <tr v-for="c in items" :key="c.id">
          <td><NuxtLink :to="`/admin/assessment/cycles/${c.id}`" class="link">{{ c.title }}</NuxtLink><div class="sub">{{ c.subjects_count }} {{ t('assess.people') }} · {{ c.rater_kinds.map(k => t(`assess.kind.${k}`)).join(', ') }}</div></td>
          <td class="sub">{{ c.form_title }}</td>
          <td class="sub">{{ fmt(c.starts_at) }} — {{ fmt(c.ends_at) }}</td>
          <td>{{ c.tasks_submitted }} / {{ c.tasks_total }}</td>
          <td><span :class="['badge', c.status]">{{ t(`assess.cycleStatus.${c.status}`) }}</span></td>
        </tr>
      </tbody>
    </table>

    <section class="card">
      <h2>{{ t('assess.newCycle') }} — {{ t('assess.step', { n: step }) }}: {{ t(`assess.steps.${step}`) }}</h2>
      <div v-if="step === 1" class="grid">
        <input v-model="form.title" class="field" :placeholder="t('assess.cycleTitle')" data-testid="cycle-title">
        <select v-model="form.formId" class="field"><option v-for="f in forms" :key="f.id" :value="f.id">{{ f.title }}</option></select>
        <label class="sub">{{ t('assess.period') }} <input v-model="form.periodFrom" class="field" type="date"> — <input v-model="form.periodTo" class="field" type="date"></label>
      </div>
      <div v-if="step === 2" class="grid">
        <p v-if="subject" class="row" data-testid="cycle-subject">
          <span class="subject">{{ t('assess.subjectFromTrajectory', { name: subject.name }) }}</span>
          <button type="button" class="chip" :aria-label="t('assess.subjectRemove')" :title="t('assess.subjectRemove')" @click="subject = null">×</button>
        </p>
        <label class="sub">{{ t('assess.subjectsPositions') }}</label>
        <div class="row"><label v-for="p in positions" :key="p.id" class="check"><input v-model="form.positionIds" type="checkbox" :value="p.id"> {{ p.name }}</label></div>
        <label class="sub">{{ t('assess.subjectsLocations') }}</label>
        <div class="row"><label v-for="l in locations" :key="l.id" class="check"><input v-model="form.locationIds" type="checkbox" :value="l.id"> {{ l.name }}</label></div>
      </div>
      <div v-if="step === 3" class="grid">
        <div class="row"><label v-for="k in RATER_KINDS" :key="k" class="check"><input v-model="form.raterKinds" type="checkbox" :value="k"> {{ t(`assess.kind.${k}`) }}</label></div>
        <!-- docs/33 D-036 (Г-20.1/Г-20.2): вага і анонімність — властивість ролі; керівник і самооцінка завжди іменні -->
        <table class="roles" data-testid="rater-roles">
          <thead><tr><th>{{ t('assess.role') }}</th><th>{{ t('assess.raterWeight') }}</th><th>{{ t('assess.raterAnonymous') }}</th></tr></thead>
          <tbody>
            <tr v-for="r in form.raterRoles.filter(r => form.raterKinds.includes(r.kind))" :key="r.kind">
              <td>{{ t(`assess.kind.${r.kind}`) }}</td>
              <td><input v-model.number="r.weight" class="field short" type="number" min="0" max="9.99" step="0.5" :aria-label="t('assess.raterWeight')"></td>
              <td><input v-model="r.isAnonymous" type="checkbox" :disabled="r.kind === 'manager' || r.kind === 'self'" :aria-label="t('assess.raterAnonymous')"></td>
            </tr>
          </tbody>
        </table>
        <label v-if="form.raterKinds.includes('peer')" class="sub">{{ t('assess.peersCount') }} <input v-model.number="form.peersCount" class="field short" type="number" min="1" max="10"></label>
        <label class="check"><input v-model="form.selfFirst" type="checkbox"> {{ t('assess.selfFirst') }}</label>
      </div>
      <div v-if="step === 4" class="grid">
        <label class="sub">{{ t('assess.window') }} <input v-model="form.startsAt" class="field" type="datetime-local"> — <input v-model="form.endsAt" class="field" type="datetime-local"></label>
      </div>
      <div v-if="step === 5" class="grid">
        <label class="check"><input v-model="form.anonymousForSubject" type="checkbox"> {{ t('assess.anonymous') }}</label>
        <label class="sub">{{ t('assess.minRaters') }} <input v-model.number="form.minRatersToShow" class="field short" type="number" min="1" max="10"></label>
        <label class="check"><input v-model="form.calibration" type="checkbox"> {{ t('assess.calibration') }}</label>
      </div>
      <div class="row">
        <button v-if="step > 1" class="chip" @click="step--">{{ t('common.back') }}</button>
        <button v-if="step < 5" class="primary" :disabled="step === 1 && (form.title.length < 3 || !form.formId || !form.periodFrom || !form.periodTo)" data-testid="cycle-next" @click="step++">{{ t('common.next') }}</button>
        <button v-else class="primary" :disabled="!form.startsAt || !form.endsAt || !form.raterKinds.length" data-testid="cycle-start" @click="create">{{ t('assess.createStart') }}</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.link { color: var(--color-ink); font-weight: 700; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.grid { display: grid; gap: var(--space-2); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.subject { font-weight: 700; overflow-wrap: anywhere; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.calibration { background: var(--color-sun); color: var(--color-sun-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>

<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()

interface Ref { id: string, name: string }
interface Course { id: string, title: string, status: string, estimatedMinutes: number | null }
type RuleType = 'user' | 'position' | 'location' | 'org_unit' | 'role' | 'tag'
interface Rule { type: RuleType, ids: string[], values: string[], codes: string[], locationIds: string[] }

const courses = ref<Course[]>([])
const refs = reactive<{ positions: Ref[], locations: Ref[], orgUnits: Ref[], roles: { code: string, name: string }[], tags: Ref[], people: Ref[] }>({
  positions: [], locations: [], orgUnits: [], roles: [], tags: [], people: [],
})

const form = reactive({
  subjectId: '',
  lockVersion: false,
  match: 'any' as 'any' | 'all',
  rules: [] as Rule[],
  startMode: 'now' as 'now' | 'date',
  startsAt: '',
  dueMode: 'relative' as 'none' | 'absolute' | 'relative',
  dueAt: '',
  dueDays: 14,
  recurrenceMonths: 0,
  isMandatory: true,
  autoSync: true,
  params: { passScore: 80, attemptsAllowed: 3, timeLimitMin: 0, showAnswers: 'after_attempt', strictOrder: true },
  reminders: { beforeDays: '3,1', onDueDay: true, afterDays: '1,3,7', channels: ['telegram'] as string[], notifyManagerAfterDays: 1, notifyOnAssign: true },
})
const paramsTab = ref<'params' | 'reminders'>('params')
const preview = ref<{ count: number, sample: { id: string, fullName: string }[] } | null>(null)
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  try {
    const [c, p, l, o, r, tg, ppl] = await Promise.all([
      api<Course[]>('/courses'), api<Ref[]>('/refs/positions'), api<Ref[]>('/refs/locations'), api<Ref[]>('/refs/org-units'),
      api<{ code: string, name: string }[]>('/settings/roles'), api<Ref[]>('/refs/tags'),
      api<{ id: string, fullName: string }[]>('/people', { query: { limit: 100 } }).then(r => r.map(x => ({ id: x.id, name: x.fullName }))),
    ])
    courses.value = c.filter(x => x.status === 'published')
    Object.assign(refs, { positions: p, locations: l, orgUnits: o, roles: r, tags: tg, people: ppl })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
})

function addRule(type: RuleType) {
  form.rules.push({ type, ids: [], values: [], codes: [], locationIds: [] })
}

function audiencePayload() {
  return {
    rules: form.rules.map((r) => {
      switch (r.type) {
        case 'role': return { type: 'role', codes: r.codes }
        case 'tag': return { type: 'tag', values: r.values }
        case 'position': return { type: 'position', ids: r.ids, ...(r.locationIds.length ? { locationIds: r.locationIds } : {}) }
        case 'org_unit': return { type: 'org_unit', ids: r.ids, includeChildren: true }
        default: return { type: r.type, ids: r.ids }
      }
    }).filter((r) => {
      const x = r as { ids?: string[], codes?: string[], values?: string[] }
      return (x.ids?.length ?? 0) > 0 || (x.codes?.length ?? 0) > 0 || (x.values?.length ?? 0) > 0
    }),
    match: form.match,
  }
}

let previewTimer: ReturnType<typeof setTimeout>
watch(() => JSON.stringify([form.rules, form.match]), () => {
  clearTimeout(previewTimer)
  previewTimer = setTimeout(async () => {
    const aud = audiencePayload()
    if (aud.rules.length === 0) { preview.value = null; return }
    try {
      preview.value = await api('/assignments/preview-audience', { method: 'POST', body: { audience: aud } })
    }
    catch { preview.value = null }
  }, 400)
}, { deep: true })

const canSubmit = computed(() => !!form.subjectId && (preview.value?.count ?? 0) > 0 && !busy.value)
const courseTitle = computed(() => courses.value.find(c => c.id === form.subjectId)?.title ?? '')

async function submit() {
  if (!confirm(t('assign.confirm', { course: courseTitle.value, n: preview.value?.count ?? 0 }))) return
  busy.value = true
  error.value = ''
  try {
    const parseDays = (s: string) => s.split(',').map(x => Number(x.trim())).filter(n => n > 0)
    const r = await api<{ assignmentId: string }>('/assignments', {
      method: 'POST',
      body: {
        subjectType: 'course', subjectId: form.subjectId, lockVersion: form.lockVersion,
        audience: audiencePayload(),
        startsAt: form.startMode === 'date' && form.startsAt ? new Date(form.startsAt).toISOString() : null,
        dueMode: form.dueMode, dueAt: form.dueMode === 'absolute' && form.dueAt ? new Date(form.dueAt).toISOString() : null, dueDays: form.dueDays,
        recurrence: form.recurrenceMonths > 0 ? { everyMonths: form.recurrenceMonths } : null,
        isMandatory: form.isMandatory, autoSync: form.autoSync,
        params: { passScore: form.params.passScore, attemptsAllowed: form.params.attemptsAllowed, timeLimitSec: form.params.timeLimitMin > 0 ? form.params.timeLimitMin * 60 : null, showAnswers: form.params.showAnswers, strictOrder: form.params.strictOrder },
        reminders: { beforeDays: parseDays(form.reminders.beforeDays), onDueDay: form.reminders.onDueDay, afterDays: parseDays(form.reminders.afterDays), channels: form.reminders.channels, notifyManagerAfterDays: form.reminders.notifyManagerAfterDays, notifyOnAssign: form.reminders.notifyOnAssign },
        tags: [], status: 'active',
      },
    })
    await navigateTo(`/admin/assignments/${r.assignmentId}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <NuxtLink to="/admin/assignments" class="back">← {{ t('admin.nav.assignments') }}</NuxtLink>
    <h1>{{ t('assign.new') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- 1. Що призначаємо -->
    <section class="block">
      <h2>1. {{ t('assign.what') }}</h2>
      <select v-model="form.subjectId">
        <option value="" disabled>{{ t('assign.pickCourse') }}</option>
        <option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option>
      </select>
      <label class="check"><input v-model="form.lockVersion" type="checkbox"> {{ t('assign.lockVersion') }}</label>
    </section>

    <!-- 2. Кому -->
    <section class="block">
      <h2>2. {{ t('assign.whom') }}</h2>
      <div class="rules">
        <div v-for="(rule, i) in form.rules" :key="i" class="rule">
          <span class="rule-type">{{ t(`assign.rule.${rule.type}`) }}</span>
          <select v-if="rule.type === 'user'" v-model="rule.ids" multiple size="4">
            <option v-for="p in refs.people" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
          <template v-else-if="rule.type === 'position'">
            <select v-model="rule.ids" multiple size="4">
              <option v-for="p in refs.positions" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <select v-model="rule.locationIds" multiple size="3" :title="t('assign.rule.location')">
              <option v-for="l in refs.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
            </select>
          </template>
          <select v-else-if="rule.type === 'location'" v-model="rule.ids" multiple size="3">
            <option v-for="l in refs.locations" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
          <select v-else-if="rule.type === 'org_unit'" v-model="rule.ids" multiple size="3">
            <option v-for="o in refs.orgUnits" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select>
          <select v-else-if="rule.type === 'role'" v-model="rule.codes" multiple size="3">
            <option v-for="r in refs.roles" :key="r.code" :value="r.code">{{ r.name }}</option>
          </select>
          <select v-else-if="rule.type === 'tag'" v-model="rule.values" multiple size="3">
            <option v-for="tg in refs.tags" :key="tg.id" :value="tg.name">{{ tg.name }}</option>
          </select>
          <button class="mini" @click="form.rules.splice(i, 1)">✕</button>
        </div>
      </div>
      <div class="add">
        <span class="sub">+ {{ t('assign.addRule') }}:</span>
        <button v-for="ty in (['user', 'position', 'location', 'org_unit', 'role', 'tag'] as RuleType[])" :key="ty" class="chip" @click="addRule(ty)">{{ t(`assign.rule.${ty}`) }}</button>
      </div>
      <div v-if="form.rules.length > 1" class="match">
        <label><input v-model="form.match" type="radio" value="any"> {{ t('assign.matchAny') }}</label>
        <label><input v-model="form.match" type="radio" value="all"> {{ t('assign.matchAll') }}</label>
      </div>
      <div :class="['counter', { zero: preview && preview.count === 0 }]">
        <template v-if="preview">
          <b>{{ t('assign.counter', { n: preview.count }) }}</b>
          <span v-if="preview.sample.length" class="sub"> — {{ preview.sample.map(s => s.fullName).slice(0, 5).join(', ') }}{{ preview.count > 5 ? '…' : '' }}</span>
        </template>
        <span v-else class="sub">{{ t('assign.counterHint') }}</span>
      </div>
    </section>

    <!-- 3. Коли -->
    <section class="block">
      <h2>3. {{ t('assign.when') }}</h2>
      <div class="grid2">
        <label>{{ t('assign.start') }}
          <select v-model="form.startMode"><option value="now">{{ t('assign.startNow') }}</option><option value="date">{{ t('assign.startDate') }}</option></select>
        </label>
        <input v-if="form.startMode === 'date'" v-model="form.startsAt" type="datetime-local">
        <label>{{ t('assign.deadline') }}
          <select v-model="form.dueMode"><option value="none">{{ t('assign.dueNone') }}</option><option value="relative">{{ t('assign.dueRelative') }}</option><option value="absolute">{{ t('assign.dueAbsolute') }}</option></select>
        </label>
        <input v-if="form.dueMode === 'relative'" v-model.number="form.dueDays" type="number" min="1" max="365">
        <input v-if="form.dueMode === 'absolute'" v-model="form.dueAt" type="datetime-local">
        <label>{{ t('assign.repeat') }} <input v-model.number="form.recurrenceMonths" type="number" min="0" max="120"></label>
        <label class="check"><input v-model="form.autoSync" type="checkbox"> {{ t('assign.autoSync') }}</label>
        <label class="check"><input v-model="form.isMandatory" type="checkbox"> {{ t('assign.mandatory') }}</label>
      </div>
    </section>

    <!-- 4. Як проходити -->
    <section class="block">
      <h2>4. {{ t('assign.how') }}</h2>
      <div class="tabs">
        <button :class="['tab', { on: paramsTab === 'params' }]" @click="paramsTab = 'params'">{{ t('assign.tabParams') }}</button>
        <button :class="['tab', { on: paramsTab === 'reminders' }]" @click="paramsTab = 'reminders'">{{ t('assign.tabReminders') }}</button>
      </div>
      <div v-if="paramsTab === 'params'" class="grid2">
        <label>{{ t('quizAdmin.passScore') }} <input v-model.number="form.params.passScore" type="number" min="1" max="100"></label>
        <label>{{ t('quizAdmin.attempts') }} <input v-model.number="form.params.attemptsAllowed" type="number" min="0" max="10"></label>
        <label>{{ t('quizAdmin.timeLimit') }} <input v-model.number="form.params.timeLimitMin" type="number" min="0" max="240"></label>
        <label>{{ t('quizAdmin.showAnswers') }}
          <select v-model="form.params.showAnswers"><option value="never">never</option><option value="after_attempt">after_attempt</option><option value="after_pass">after_pass</option></select>
        </label>
        <label class="check"><input v-model="form.params.strictOrder" type="checkbox"> {{ t('assign.strictOrder') }}</label>
      </div>
      <div v-else class="grid2">
        <label>{{ t('assign.beforeDays') }} <input v-model="form.reminders.beforeDays" placeholder="3,1"></label>
        <label>{{ t('assign.afterDays') }} <input v-model="form.reminders.afterDays" placeholder="1,3,7"></label>
        <label class="check"><input v-model="form.reminders.onDueDay" type="checkbox"> {{ t('assign.onDueDay') }}</label>
        <label class="check"><input v-model="form.reminders.notifyOnAssign" type="checkbox"> {{ t('assign.notifyOnAssign') }}</label>
        <label>{{ t('assign.notifyManager') }} <input v-model.number="form.reminders.notifyManagerAfterDays" type="number" min="0" max="30"></label>
        <div class="check-group">
          <label v-for="ch in ['telegram', 'sms', 'email']" :key="ch" class="check">
            <input v-model="form.reminders.channels" type="checkbox" :value="ch"> {{ ch }}
          </label>
        </div>
      </div>
    </section>

    <div class="actions">
      <button class="primary" :disabled="!canSubmit" @click="submit">{{ t('assign.submit') }}</button>
    </div>
  </div>
</template>

<style scoped>
.page { max-width: 860px; display: grid; gap: var(--space-4); }
.back { color: var(--color-ink-muted); text-decoration: none; font-size: var(--font-size-body-s); }
h1 { margin: 0; font-weight: 900; }
h2 { margin: 0 0 var(--space-3); font-size: var(--font-size-title-l); font-weight: 800; }
.block { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-5); display: grid; gap: var(--space-3); }
select, input:not([type="checkbox"]):not([type="radio"]) { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); width: 100%; box-sizing: border-box; }
select[multiple] { min-height: 90px; }
.check { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.check-group { display: flex; gap: var(--space-4); }
.rules { display: grid; gap: var(--space-2); }
.rule { display: grid; grid-template-columns: 120px 1fr auto; gap: var(--space-2); align-items: start; background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-3); }
.rule:has(select + select) { grid-template-columns: 120px 1fr 1fr auto; }
.rule-type { font-weight: 700; font-size: var(--font-size-body-s); padding-top: var(--space-2); }
.mini { font: inherit; border: 1px solid var(--color-bg-line); background: transparent; border-radius: var(--radius-pill); width: 28px; height: 28px; cursor: pointer; color: var(--color-coral-ink); }
.add { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.match { display: flex; gap: var(--space-4); font-size: var(--font-size-body-s); }
.match label { display: flex; gap: var(--space-2); align-items: center; }
.counter { background: var(--color-teal); color: var(--color-teal-deep); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); }
.counter.zero { background: var(--color-coral); color: var(--color-coral-deep); }
.counter .sub { color: inherit; opacity: 0.8; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); align-items: end; }
.grid2 label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.tabs { display: flex; gap: var(--space-2); }
.tab { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-4); cursor: pointer; }
.tab.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
.actions { display: flex; justify-content: flex-end; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-3) var(--space-6); cursor: pointer; }
.primary:disabled { opacity: 0.4; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
@media (max-width: 720px) { .grid2 { grid-template-columns: 1fr; } .rule, .rule:has(select + select) { grid-template-columns: 1fr; } }
</style>

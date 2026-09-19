<script setup lang="ts">
import { CONTENT_TYPES } from '#shared/enums'
import type { ContentType } from '#shared/enums'

/**
 * Создание назначения (docs/15 §5.2, §14.1): тип контента — из `?type=` меню «Додати призначення»
 * (одиннадцать типов), контент — «Обрати з існуючих» по типу. Правила прохождения и напоминания
 * задаются после создания на экране «Налаштування» карточки (пять групп, схема по типу).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()
const route = useRoute()

interface Ref { id: string, name: string }
interface Content { id: string, title: string, summary: string | null }
type RuleType = 'user' | 'position' | 'location' | 'org_unit' | 'role' | 'tag'
interface Rule { type: RuleType, ids: string[], values: string[], codes: string[], locationIds: string[] }

const contents = ref<Content[]>([])
const refs = reactive<{ positions: Ref[], locations: Ref[], orgUnits: Ref[], roles: { code: string, name: string }[], tags: Ref[], people: Ref[] }>({
  positions: [], locations: [], orgUnits: [], roles: [], tags: [], people: [],
})

const initialType = (CONTENT_TYPES as readonly string[]).includes(String(route.query.type)) ? route.query.type as ContentType : 'course'
const form = reactive({
  subjectType: initialType as ContentType,
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
  onLeaveCondition: 'keep' as 'keep' | 'cancel_unstarted' | 'cancel_all',
})
const preview = ref<{ count: number, sample: { id: string, fullName: string }[] } | null>(null)
const error = ref('')
const busy = ref(false)

async function loadContent() {
  try { contents.value = await api<Content[]>('/tasks/content', { query: { type: form.subjectType } }) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(async () => {
  try {
    const [p, l, o, r, tg, ppl] = await Promise.all([
      api<Ref[]>('/refs/positions'), api<Ref[]>('/refs/locations'), api<Ref[]>('/refs/org-units'),
      api<{ code: string, name: string }[]>('/settings/roles'), api<Ref[]>('/refs/tags'),
      api<{ id: string, fullName: string }[]>('/people', { query: { limit: 100 } }).then(r => r.map(x => ({ id: x.id, name: x.fullName }))),
    ])
    Object.assign(refs, { positions: p, locations: l, orgUnits: o, roles: r, tags: tg, people: ppl })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  await loadContent()
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
const courseTitle = computed(() => contents.value.find(c => c.id === form.subjectId)?.title ?? '')
watch(() => form.subjectType, () => { form.subjectId = ''; loadContent() })

async function submit() {
  if (!confirm(t('assign.confirm', { course: courseTitle.value, n: preview.value?.count ?? 0 }))) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ assignmentId: string }>('/tasks', {
      method: 'POST',
      body: {
        subjectType: form.subjectType, subjectId: form.subjectId, lockVersion: form.lockVersion,
        audience: audiencePayload(),
        startsAt: form.startMode === 'date' && form.startsAt ? new Date(form.startsAt).toISOString() : null,
        dueMode: form.dueMode, dueAt: form.dueMode === 'absolute' && form.dueAt ? new Date(form.dueAt).toISOString() : null, dueDays: form.dueDays,
        recurrence: form.recurrenceMonths > 0 ? { everyMonths: form.recurrenceMonths } : null,
        isMandatory: form.isMandatory, autoSync: form.autoSync, onLeaveCondition: form.onLeaveCondition,
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
      <div class="types" role="radiogroup">
        <label v-for="ct in CONTENT_TYPES" :key="ct" class="chip-radio"><input v-model="form.subjectType" type="radio" :value="ct"> {{ t(`contentType.${ct}`) }}</label>
      </div>
      <select v-model="form.subjectId" data-testid="assign-subject">
        <option value="" disabled>{{ t('assign.pickSubject') }}</option>
        <option v-for="c in contents" :key="c.id" :value="c.id">{{ c.title }}</option>
      </select>
      <label v-if="form.subjectType === 'course'" class="check"><input v-model="form.lockVersion" type="checkbox"> {{ t('assign.lockVersion') }}</label>
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
        <label>{{ t('assign.onLeave.label') }}
          <select v-model="form.onLeaveCondition"><option v-for="v in ['keep', 'cancel_unstarted', 'cancel_all']" :key="v" :value="v">{{ t(`assign.onLeave.${v}`) }}</option></select>
        </label>
      </div>
    </section>

    <!-- 4. Як проходити — после создания, на экране «Налаштування» карточки (пять групп по типу контента) -->
    <p class="hint">{{ t('assign.rulesHere') }}</p>

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
.types { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-bottom: var(--space-3); }
.chip-radio { display: inline-flex; align-items: center; gap: var(--space-1); border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); font-size: var(--font-size-body-s); cursor: pointer; }
.chip-radio:has(input:checked) { background: var(--color-ink); color: var(--color-bg-soft); border-color: var(--color-ink); }
.hint { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0 0 var(--space-2); }
</style>

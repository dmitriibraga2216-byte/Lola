<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'position_profile.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Req { competencyId: string, requiredLevel: number, isCritical?: boolean, positionLevelId?: string | null }
interface P { id: string, positionId: string, positionIds: string[], positionName: string, description: string | null, goals: ContentBlock[] | null, responsibilities: ContentBlock[] | null, usePositionLevels: boolean, competencyRequirements: Req[], mandatoryContent: { subjectType: string, subjectId: string, dueDays: number }[], probationDays: number | null }
const items = ref<P[]>([])
const positions = ref<{ id: string, name: string }[]>([])
const positionLevels = ref<{ id: string, name: string }[]>([])
const comps = ref<{ id: string, name: string, levels: { level: number }[], categoryId: string | null }[]>([])
const categories = ref<{ id: string, name: string }[]>([])
const courses = ref<{ id: string, title: string }[]>([])
const error = ref('')
const notice = ref('')
const emptyBlocks: ContentBlock[] = [{ id: 'b1', type: 'text', html: '<p></p>' } as unknown as ContentBlock]
const form = reactive({
  positionId: '', positionIds: [] as string[], description: '', goals: [...emptyBlocks] as ContentBlock[], responsibilities: [...emptyBlocks] as ContentBlock[], usePositionLevels: false,
  probationDays: 90 as number | null, competencyRequirements: [] as Req[], mandatoryContent: [] as { subjectType: string, subjectId: string, dueDays: number }[],
})

async function load() {
  try {
    items.value = await api<P[]>('/position-profiles')
    positions.value = await api('/refs/positions')
    positionLevels.value = await api('/refs/position-levels')
    comps.value = await api('/competencies')
    categories.value = await api('/competency-categories')
    courses.value = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(c => c.status === 'published')
  } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
function pick(positionId: string) {
  // docs/33 D-031: посада може бути додатковою в чужому профілі — відкриваємо той профіль (головна посада — його)
  const p = items.value.find(x => x.positionId === positionId) ?? items.value.find(x => (x.positionIds ?? []).includes(positionId))
  form.positionId = p?.positionId ?? positionId
  form.positionIds = p ? (p.positionIds ?? []).filter(id => id !== p.positionId) : []
  form.description = p?.description ?? ''
  form.goals = p?.goals?.length ? p.goals.map(b => ({ ...b })) : [...emptyBlocks]
  form.responsibilities = p?.responsibilities?.length ? p.responsibilities.map(b => ({ ...b })) : [...emptyBlocks]
  form.usePositionLevels = p?.usePositionLevels ?? false
  form.probationDays = p?.probationDays ?? 90
  form.competencyRequirements = p ? p.competencyRequirements.map(r => ({ ...r })) : []
  form.mandatoryContent = p ? p.mandatoryContent.map(m => ({ ...m })) : []
}
async function save() {
  error.value = ''; notice.value = ''
  try {
    await api('/position-profiles', { method: 'PUT', body: { ...form, description: form.description || undefined } })
    notice.value = t('common.saved'); await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
const compName = (id: string) => comps.value.find(c => c.id === id)?.name ?? '?'
/** Таблиця «Компетенції та норма» за мокапом PositionProfile: вимоги, згруповані по категорії компетенції. */
const requirementGroups = computed(() => {
  const catName = (id: string | null) => id ? (categories.value.find(c => c.id === id)?.name ?? t('dev.noCategory')) : t('dev.noCategory')
  const order: string[] = []
  const byCat = new Map<string, number[]>()
  form.competencyRequirements.forEach((r, i) => {
    const name = catName(comps.value.find(c => c.id === r.competencyId)?.categoryId ?? null)
    if (!byCat.has(name)) { byCat.set(name, []); order.push(name) }
    byCat.get(name)!.push(i)
  })
  return order.map(name => ({ name, indices: byCat.get(name)! }))
})
interface Coverage { people: number, fit: number, perPerson: { userId: string, fullName: string, percent: number, fit: boolean }[] }
const coverage = ref<Coverage | null>(null)
const current = computed(() => items.value.find(x => x.positionId === form.positionId))
/** Посади, які можна додати до профілю: не головна і не зайняті іншим профілем. */
const freePositions = computed(() => positions.value.filter(p => p.id !== form.positionId && !items.value.some(x => x.positionId !== form.positionId && (x.positionIds ?? [x.positionId]).includes(p.id))))
function togglePosition(id: string) { form.positionIds = form.positionIds.includes(id) ? form.positionIds.filter(x => x !== id) : [...form.positionIds, id] }
watch(current, async (p) => { coverage.value = p ? await api<Coverage>(`/position-profiles/${p.id}/coverage`).catch(() => null) : null }, { immediate: true })
async function applyToPeople() {
  if (!current.value) return
  error.value = ''; notice.value = ''
  try { const r = await api<{ assignments: number, enrolled: number }>(`/position-profiles/${current.value.id}/apply`, { method: 'POST' }); notice.value = t('dev.applied', { a: r.assignments, e: r.enrolled }) }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.positionProfiles') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <div class="grid">
      <aside class="list">
        <button v-for="p in positions" :key="p.id" :class="['item', { on: form.positionId === p.id }]" :data-testid="`pos-${p.id}`" @click="pick(p.id)">
          {{ p.name }}<span v-if="items.some(x => (x.positionIds ?? [x.positionId]).includes(p.id))" class="dot" />
        </button>
      </aside>
      <section v-if="form.positionId" class="card">
        <h2>{{ positions.find(p => p.id === form.positionId)?.name }}</h2>
        <p v-if="coverage" class="sub">{{ t('dev.coverage', { fit: coverage.fit, people: coverage.people }) }} <NuxtLink v-if="coverage.people" :to="{ path: '/admin/people', query: { positionId: form.positionId } }" class="link">→</NuxtLink></p>
        <div v-if="coverage && coverage.people" class="coverage-card">
          <div class="coverage-title upper">{{ t('dev.coverageTitle') }}</div>
          <ul class="coverage-list">
            <li v-for="person in coverage.perPerson" :key="person.userId" class="coverage-row" :data-testid="`coverage-${person.userId}`">
              <div class="coverage-head">
                <b class="coverage-pct">{{ t('dev.coveragePercent', { percent: person.percent }) }}</b>
                <span class="coverage-name">{{ person.fullName }}</span>
              </div>
              <div class="bar"><i :class="{ ok: person.fit }" :style="{ width: `${person.percent}%` }" /></div>
            </li>
          </ul>
        </div>
        <p v-else-if="coverage" class="sub">{{ t('dev.coverageEmpty') }}</p>
        <textarea v-model="form.description" class="field" rows="2" :placeholder="t('dev.profileDesc')" />
        <label class="sub">{{ t('dev.probation') }} <input v-model.number="form.probationDays" class="field short" type="number" min="1" max="365"></label>
        <h3>{{ t('dev.alsoPositions') }}</h3>
        <p class="sub">{{ t('dev.alsoPositionsHint') }}</p>
        <div class="chips">
          <label v-for="p in freePositions" :key="p.id" class="check chip-check" :data-testid="`also-pos-${p.id}`"><input type="checkbox" :checked="form.positionIds.includes(p.id)" @change="togglePosition(p.id)"> {{ p.name }}</label>
          <span v-if="!freePositions.length" class="sub">{{ t('dev.alsoPositionsNone') }}</span>
        </div>
        <h3>{{ t('dev.positionGoals') }}</h3>
        <BlockEditor v-model="form.goals" />
        <h3>{{ t('dev.responsibilities') }}</h3>
        <BlockEditor v-model="form.responsibilities" />
        <label class="check"><input v-model="form.usePositionLevels" type="checkbox"> {{ t('dev.usePositionLevels') }}</label>
        <p class="sub">{{ t('dev.usePositionLevelsHint') }}</p>
        <h3 class="upper">{{ t('dev.reqTable') }}</h3>
        <div v-for="g in requirementGroups" :key="g.name" class="reqgroup">
          <div class="reqgroup-title">{{ g.name }}</div>
          <div v-for="i in g.indices" :key="i" class="row">
            <select v-model="form.competencyRequirements[i]!.competencyId" class="field grow"><option v-for="c in comps" :key="c.id" :value="c.id">{{ c.name }}</option></select>
            <label class="sub">{{ t('dev.level') }} <select v-model.number="form.competencyRequirements[i]!.requiredLevel" class="field"><option v-for="l in (comps.find(c => c.id === form.competencyRequirements[i]!.competencyId)?.levels ?? [{ level: 1 }, { level: 2 }, { level: 3 }])" :key="l.level" :value="l.level">{{ l.level }}</option></select></label>
            <select v-if="form.usePositionLevels" v-model="form.competencyRequirements[i]!.positionLevelId" class="field">
              <option :value="null">{{ t('dev.anyLevel') }}</option>
              <option v-for="pl in positionLevels" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
            </select>
            <label class="check"><input v-model="form.competencyRequirements[i]!.isCritical" type="checkbox"> {{ t('dev.critical') }}</label>
            <button class="chip" @click="form.competencyRequirements.splice(i, 1)">✕</button>
          </div>
        </div>
        <button class="chip" data-testid="req-add" @click="form.competencyRequirements.push({ competencyId: comps[0]?.id ?? '', requiredLevel: 2, positionLevelId: null })">+ {{ t('dev.competency') }}</button>
        <p class="sub sourcehint">{{ t('dev.sourceHint') }}<br>{{ t('dev.sourceHintExpiry') }}<br>1. {{ t('dev.source.assessment') }} — {{ t('dev.sourceHintAssessment') }}<br>2. {{ t('dev.source.task') }} — {{ t('dev.sourceHintTask') }}<br>3. {{ t('dev.source.manual') }} — {{ t('dev.sourceHintManual') }}</p>
        <h3>{{ t('dev.mandatory') }}</h3>
        <div v-for="(m, i) in form.mandatoryContent" :key="i" class="row">
          <select v-model="m.subjectId" class="field grow"><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
          <label class="sub">{{ t('dev.dueDays') }} <input v-model.number="m.dueDays" class="field short" type="number" min="1"></label>
          <button class="chip" @click="form.mandatoryContent.splice(i, 1)">✕</button>
        </div>
        <button class="chip" @click="form.mandatoryContent.push({ subjectType: 'course', subjectId: courses[0]?.id ?? '', dueDays: 14 })">+ {{ t('dev.course') }}</button>
        <button class="primary" data-testid="profile-save" @click="save">{{ t('common.save') }}</button>
        <button v-if="current" class="chip" @click="applyToPeople">{{ t('dev.applyToPeople') }}</button>
      </section>
      <p v-else class="sub">{{ t('dev.pickPosition') }}</p>
    </div>
    <p class="sub">{{ items.map(p => `${p.positionName}: ${p.competencyRequirements.map(r => `${compName(r.competencyId)} ≥${r.requiredLevel}`).join(', ')}`).join(' | ') }}</p>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2, h3 { margin: 0; font-weight: 800; }
h3 { font-size: var(--font-size-body); margin-top: var(--space-2); }
h3.upper { text-transform: uppercase; letter-spacing: 0.06em; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.reqgroup { display: grid; gap: var(--space-1); margin-bottom: var(--space-2); }
.reqgroup-title { font-weight: 800; }
.grid { display: grid; grid-template-columns: 220px 1fr; gap: var(--space-3); margin-bottom: var(--space-3); }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
.list { display: grid; gap: var(--space-1); align-content: start; }
.item { font: inherit; text-align: left; border: 1px solid var(--color-bg-line); background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
.item.on { border-color: var(--color-ink); font-weight: 800; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: var(--color-teal); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 80px; }
.grow { flex: 1; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.chip-check { border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.chip-check:has(input:checked) { border-color: var(--color-ink); font-weight: 800; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; justify-self: start; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.coverage-card { background: var(--color-bg); border: 2px solid var(--color-teal); border-radius: var(--radius-l); padding: var(--space-3) var(--space-4); display: grid; gap: var(--space-2); }
.coverage-title { font-size: var(--font-size-body-s); font-weight: 900; color: var(--color-ink); letter-spacing: 0.06em; }
.coverage-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); max-height: 260px; overflow-y: auto; }
.coverage-row { display: grid; gap: var(--space-1); }
.coverage-head { display: flex; align-items: baseline; gap: var(--space-2); }
.coverage-pct { font-variant-numeric: tabular-nums; font-weight: 900; }
.coverage-name { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.coverage-row .bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; }
.coverage-row .bar i { display: block; height: 100%; background: var(--color-sun); border-radius: var(--radius-pill); }
.coverage-row .bar i.ok { background: var(--color-teal); }
</style>

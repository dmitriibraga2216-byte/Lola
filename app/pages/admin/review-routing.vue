<script setup lang="ts">
/**
 * «Правила розподілу» — `/review/routing-rules` (docs/v2/37 §3.3, §5.3, §7.16–7.17).
 *
 * Список по приоритету: назва, область, типи завдань, стратегія, перевіряючі, SLA, перемикач
 * активності; «Вище» / «Нижче» меняют приоритет (обмен с соседом — перетаскивание §5.3 на
 * клавиатуре недоступно, кнопки доступны). Внизу — что будет, если ни одно правило не подошло.
 * Руководитель точки правит только правила своей области: правило на всю сеть сервер отклонит
 * `422 routing.scope_empty` с объяснением.
 */
import { REVIEW_ROUTING_STRATEGIES, REVIEW_TASK_TYPES } from '#shared/enums'
import type { ReviewRoutingStrategy, ReviewTaskType } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.routing.manage' })

const { t } = useI18n()
const { api } = useApi()

interface Rule {
  id: string
  nameUk: string
  priority: number
  matchScope: { location_ids?: string[] }
  matchSubjectKind: 'employee' | 'candidate' | null
  matchTaskTypes: ReviewTaskType[]
  strategy: ReviewRoutingStrategy
  reviewerIds: string[]
  reviewerNames: string[]
  fallbackUserId: string | null
  fallbackName: string | null
  slaHoursOverride: number | null
  isActive: boolean
}
interface Location { id: string, name: string }
interface Reviewer { userId: string, fullName: string }

const rules = ref<Rule[]>([])
const locations = ref<Location[]>([])
const reviewers = ref<Reviewer[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const editing = ref<Rule | 'new' | null>(null)
const form = reactive({
  nameUk: '',
  priority: 100,
  locationIds: [] as string[],
  taskTypes: [] as ReviewTaskType[],
  subjectKind: '' as '' | 'employee' | 'candidate',
  strategy: 'round_robin' as ReviewRoutingStrategy,
  reviewerIds: [] as string[],
  fallbackUserId: '',
  slaHours: '' as number | '',
  isActive: true,
})

async function load() {
  error.value = ''
  try {
    rules.value = await api<Rule[]>('/review/routing-rules')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(async () => {
  locations.value = await api<Location[]>('/refs/locations').catch(() => [])
  reviewers.value = await api<Reviewer[]>('/review/workload').catch(() => [])
  await load()
})

const locationName = (id: string) => locations.value.find(l => l.id === id)?.name ?? '—'
const scopeText = (r: Rule) => r.matchScope.location_ids?.length ? r.matchScope.location_ids.map(locationName).join(', ') : t('reviewRouting.wholeTenant')
const typesText = (r: Rule) => r.matchTaskTypes.length ? r.matchTaskTypes.map(x => t(`reviewQueue.taskType.${x}`)).join(', ') : t('reviewRouting.anyTask')

function open(rule: Rule | 'new') {
  editing.value = rule
  const r = rule === 'new' ? null : rule
  Object.assign(form, {
    nameUk: r?.nameUk ?? '',
    priority: r?.priority ?? (rules.value.length ? Math.max(...rules.value.map(x => x.priority)) + 10 : 100),
    locationIds: [...(r?.matchScope.location_ids ?? [])],
    taskTypes: [...(r?.matchTaskTypes ?? [])],
    subjectKind: r?.matchSubjectKind ?? '',
    strategy: r?.strategy ?? 'round_robin',
    reviewerIds: [...(r?.reviewerIds ?? [])],
    fallbackUserId: r?.fallbackUserId ?? '',
    slaHours: r?.slaHoursOverride ?? '',
    isActive: r?.isActive ?? true,
  })
}

function bodyOf(src: typeof form) {
  return {
    nameUk: src.nameUk,
    priority: src.priority,
    matchScope: src.locationIds.length ? { locationIds: src.locationIds } : {},
    matchSubjectKind: src.subjectKind || null,
    matchTaskTypes: src.taskTypes,
    strategy: src.strategy,
    reviewerIds: src.reviewerIds,
    fallbackUserId: src.fallbackUserId || null,
    slaHoursOverride: src.slaHours === '' ? null : Number(src.slaHours),
    isActive: src.isActive,
  }
}
const formOf = (r: Rule): typeof form => ({
  nameUk: r.nameUk, priority: r.priority, locationIds: r.matchScope.location_ids ?? [], taskTypes: r.matchTaskTypes,
  subjectKind: r.matchSubjectKind ?? '', strategy: r.strategy, reviewerIds: r.reviewerIds, fallbackUserId: r.fallbackUserId ?? '',
  slaHours: r.slaHoursOverride ?? '', isActive: r.isActive,
})

async function save() {
  busy.value = true
  error.value = ''
  try {
    if (editing.value === 'new') await api('/review/routing-rules', { method: 'POST', body: bodyOf(form) })
    else if (editing.value) await api(`/review/routing-rules/${editing.value.id}`, { method: 'PATCH', body: bodyOf(form) })
    notice.value = t('reviewRouting.saved')
    editing.value = null
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function patch(r: Rule, change: Partial<typeof form>) {
  error.value = ''
  try {
    await api(`/review/routing-rules/${r.id}`, { method: 'PATCH', body: bodyOf({ ...formOf(r), ...change }) })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

/** Обмен приоритетами с соседом: порядок правил — это их приоритет (§3.3). */
async function move(i: number, dir: -1 | 1) {
  const a = rules.value[i]
  const b = rules.value[i + dir]
  if (!a || !b) return
  const pa = a.priority === b.priority ? b.priority + dir : b.priority
  await patch(a, { priority: pa })
  await patch(b, { priority: a.priority })
  await load()
}

async function toggle(r: Rule) {
  await patch(r, { isActive: !r.isActive })
  await load()
}

async function remove(r: Rule) {
  if (!confirm(t('reviewRouting.deleteConfirm', { name: r.nameUk }))) return
  try {
    await api(`/review/routing-rules/${r.id}`, { method: 'DELETE' })
    notice.value = t('reviewRouting.deleted')
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
</script>

<template>
  <div>
    <PageHeader :title="t('reviewRouting.title')" :subtitle="t('reviewRouting.hint')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('reviewRouting.title') }]">
      <template #actions>
        <button class="btn primary" type="button" @click="open('new')">{{ t('reviewRouting.add') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div v-if="!rules.length" class="card muted">{{ t('reviewRouting.empty') }}</div>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('reviewRouting.col.name') }}</th>
            <th>{{ t('reviewRouting.col.scope') }}</th>
            <th>{{ t('reviewRouting.col.taskTypes') }}</th>
            <th>{{ t('reviewRouting.col.strategy') }}</th>
            <th>{{ t('reviewRouting.col.reviewers') }}</th>
            <th class="num">{{ t('reviewRouting.col.sla') }}</th>
            <th>{{ t('reviewRouting.col.active') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in rules" :key="r.id" :class="{ off: !r.isActive }">
            <td><b>{{ r.nameUk }}</b></td>
            <td>{{ scopeText(r) }}</td>
            <td>{{ typesText(r) }}</td>
            <td>{{ t(`reviewRouting.strategy.${r.strategy}`) }}</td>
            <td>{{ r.reviewerNames.filter(Boolean).join(', ') || '—' }}</td>
            <td class="num">{{ r.slaHoursOverride ?? '—' }}</td>
            <td>
              <label class="toggle">
                <input type="checkbox" :checked="r.isActive" :aria-label="t('reviewRouting.active')" @change="toggle(r)">
              </label>
            </td>
            <td class="actions">
              <button class="btn ghost small" type="button" :disabled="i === 0" @click="move(i, -1)">{{ t('reviewRouting.up') }}</button>
              <button class="btn ghost small" type="button" :disabled="i === rules.length - 1" @click="move(i, 1)">{{ t('reviewRouting.down') }}</button>
              <button class="btn ghost small" type="button" @click="open(r)">{{ t('reviewRouting.edit') }}</button>
              <button class="btn ghost small" type="button" @click="remove(r)">{{ t('reviewRouting.delete') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="sub fallback">{{ t('reviewRouting.fallbackLine') }}</p>

    <div v-if="editing" class="overlay" @click.self="editing = null" @keydown.esc="editing = null">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="rule-title" @submit.prevent="save">
        <h2 id="rule-title">{{ t('reviewRouting.form.title') }}</h2>
        <label>{{ t('reviewRouting.form.name') }}
          <input v-model="form.nameUk" class="field" maxlength="200" required>
        </label>
        <label>{{ t('reviewRouting.form.priority') }}
          <input v-model.number="form.priority" class="field" type="number" min="0" max="10000" required>
        </label>
        <fieldset>
          <legend>{{ t('reviewRouting.form.locations') }}</legend>
          <label v-for="l in locations" :key="l.id" class="check">
            <input v-model="form.locationIds" type="checkbox" :value="l.id">
            {{ l.name }}
          </label>
        </fieldset>
        <fieldset>
          <legend>{{ t('reviewRouting.form.taskTypes') }}</legend>
          <label v-for="tt in REVIEW_TASK_TYPES" :key="tt" class="check">
            <input v-model="form.taskTypes" type="checkbox" :value="tt">
            {{ t(`reviewQueue.taskType.${tt}`) }}
          </label>
        </fieldset>
        <label>{{ t('reviewRouting.form.subjectKind') }}
          <select v-model="form.subjectKind" class="field">
            <option value="">{{ t('reviewQueue.filter.subjectAll') }}</option>
            <option value="employee">{{ t('reviewQueue.filter.subjectEmployee') }}</option>
            <option value="candidate">{{ t('reviewQueue.filter.subjectCandidate') }}</option>
          </select>
        </label>
        <label>{{ t('reviewRouting.form.strategy') }}
          <select v-model="form.strategy" class="field" required>
            <option v-for="s in REVIEW_ROUTING_STRATEGIES" :key="s" :value="s">{{ t(`reviewRouting.strategy.${s}`) }}</option>
          </select>
        </label>
        <fieldset v-if="form.strategy === 'specific_list' || form.strategy === 'round_robin' || form.strategy === 'least_loaded'">
          <legend>{{ t('reviewRouting.form.reviewers') }}</legend>
          <label v-for="p in reviewers" :key="p.userId" class="check">
            <input v-model="form.reviewerIds" type="checkbox" :value="p.userId">
            {{ p.fullName }}
          </label>
        </fieldset>
        <label>{{ t('reviewRouting.form.fallback') }}
          <select v-model="form.fallbackUserId" class="field">
            <option value="">{{ t('reviewRouting.form.fallbackNone') }}</option>
            <option v-for="p in reviewers" :key="p.userId" :value="p.userId">{{ p.fullName }}</option>
          </select>
        </label>
        <label>{{ t('reviewRouting.form.sla') }}
          <input v-model="form.slaHours" class="field" type="number" min="1" max="720" :aria-describedby="'sla-hint'">
          <span id="sla-hint" class="sub">{{ t('reviewRouting.form.slaHint') }}</span>
        </label>
        <label class="check">
          <input v-model="form.isActive" type="checkbox">
          {{ t('reviewRouting.active') }}
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('reviewRouting.form.save') }}</button>
          <button class="btn ghost" type="button" @click="editing = null">{{ t('reviewRouting.form.cancel') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
tr.off td { color: var(--color-ink-faint); }
.fallback { margin-top: var(--space-3); color: var(--color-ink-muted); }
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(520px, 100%); max-height: 90dvh; overflow: auto; box-sizing: border-box; }
.modal h2 { margin: 0; font-weight: 900; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.modal fieldset { border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); display: grid; gap: var(--space-1); }
.modal legend { font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: 0 var(--space-1); }
.modal .sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>

<script setup lang="ts">
/**
 * «Навантаження перевіряючих» — `/review/workload` (docs/v2/37 §5.3, форма отсутствия §6.2).
 *
 * Таблица проверяющих области: відкрито / ліміт (полоса, коралловая при перегрузе), перевірено
 * за 7 днів, медіана реакції, прострочено, делеговано мені / мною, присутність. Действия в
 * строке: «Перекинути чергу» (отсутствие с этого дня с перебросом), «Позначити відсутність»,
 * «Змінити ліміт». Лимит — сигнал распределению, а не запрет (§12, Г-37.8).
 */
import { REVIEWER_ABSENCE_KINDS } from '#shared/enums'
import type { ReviewerAbsenceKind } from '#shared/enums'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'review.workload.view' })

const { t } = useI18n()
const { api } = useApi()
const { formatShortDate } = useFormat()

interface Row {
  userId: string
  fullName: string
  open: number
  max: number
  overloaded: boolean
  reviewed7d: number
  medianReactHours: number | null
  overdue: number
  delegatedToMe: number
  delegatedByMe: number
  acceptsDelegation: boolean
  absence: { id: string, kind: ReviewerAbsenceKind, endsOn: string | null } | null
}
interface Location { id: string, name: string }

const rows = ref<Row[]>([])
const locations = ref<Location[]>([])
const locationId = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)

const today = () => new Date().toISOString().slice(0, 10)
const absence = ref<Row | null>(null)
const absenceForm = reactive({ kind: 'vacation' as ReviewerAbsenceKind, startsOn: today(), endsOn: '', substituteId: '', moveOpenItems: true })
const limit = ref<Row | null>(null)
const limitForm = reactive({ maxOpenItems: 20, dailyTarget: 10, acceptsDelegation: true })

async function load() {
  error.value = ''
  try {
    rows.value = await api<Row[]>('/review/workload', { query: locationId.value ? { locationId: locationId.value } : {} })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(async () => {
  locations.value = await api<Location[]>('/refs/locations').catch(() => [])
  await load()
})
watch(locationId, load)

/**
 * «Позначити відсутність» — форма §6.2. «Перекинути чергу» — та же форма, заполненная для
 * переброса прямо сейчас (вид «Інше», с сегодняшнего дня): переброс очереди в модели `37`
 * §7.18 — это отсутствие с `move_open_items`, отдельной сущности у него нет.
 */
function openAbsence(r: Row, moveNow = false) {
  absence.value = r
  Object.assign(absenceForm, { kind: moveNow ? 'other' : 'vacation', startsOn: today(), endsOn: moveNow ? today() : '', substituteId: '', moveOpenItems: true })
}
async function saveAbsence() {
  if (!absence.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ movedCount: number }>('/review/absences', {
      method: 'POST',
      body: {
        userId: absence.value.userId,
        kind: absenceForm.kind,
        startsOn: absenceForm.startsOn,
        ...(absenceForm.kind !== 'dismissal' && absenceForm.endsOn ? { endsOn: absenceForm.endsOn } : {}),
        ...(absenceForm.substituteId ? { substituteId: absenceForm.substituteId } : {}),
        moveOpenItems: absenceForm.moveOpenItems,
      },
    })
    notice.value = t('reviewWorkload.moved', { n: r.movedCount })
    absence.value = null
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
async function cancelAbsence(r: Row) {
  if (!r.absence) return
  try {
    await api(`/review/absences/${r.absence.id}`, { method: 'DELETE' })
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

function openLimit(r: Row) {
  limit.value = r
  Object.assign(limitForm, { maxOpenItems: r.max, dailyTarget: 10, acceptsDelegation: r.acceptsDelegation })
}
async function saveLimit() {
  if (!limit.value) return
  busy.value = true
  error.value = ''
  try {
    await api(`/review/capacity/${limit.value.userId}`, { method: 'PATCH', body: { ...limitForm } })
    notice.value = t('reviewWorkload.saved')
    limit.value = null
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

const fill = (r: Row) => `${Math.min(100, Math.round(r.open / Math.max(1, r.max) * 100))}%`
function presence(r: Row) {
  if (!r.absence) return t('reviewWorkload.present')
  const kind = t(`reviewAbsence.kinds.${r.absence.kind}`)
  return r.absence.endsOn ? t('reviewWorkload.absentUntil', { kind, date: formatShortDate(r.absence.endsOn) }) : t('reviewWorkload.absentOpen', { kind })
}
</script>

<template>
  <div>
    <PageHeader :title="t('reviewWorkload.title')" :subtitle="t('reviewWorkload.hint')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('reviewWorkload.title') }]" />

    <div class="filters">
      <label>{{ t('reviewWorkload.location') }}
        <select v-model="locationId" class="field small">
          <option value="">{{ t('reviewWorkload.allLocations') }}</option>
          <option v-for="l in locations" :key="l.id" :value="l.id">{{ l.name }}</option>
        </select>
      </label>
    </div>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div v-if="!rows.length" class="card muted">{{ t('reviewWorkload.empty') }}</div>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('reviewWorkload.col.name') }}</th>
            <th>{{ t('reviewWorkload.col.open') }}</th>
            <th class="num">{{ t('reviewWorkload.col.reviewed7d') }}</th>
            <th class="num">{{ t('reviewWorkload.col.react') }}</th>
            <th class="num">{{ t('reviewWorkload.col.overdue') }}</th>
            <th class="num">{{ t('reviewWorkload.col.delegated') }}</th>
            <th>{{ t('reviewWorkload.col.presence') }}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.userId">
            <td><b>{{ r.fullName }}</b></td>
            <td>
              <span class="load" :aria-label="`${r.open} / ${r.max}`"><span :class="['load-fill', { over: r.overloaded }]" :style="{ width: fill(r) }" /></span>
              <span :class="{ 'late-text': r.overloaded }">{{ r.open }} / {{ r.max }}</span>
            </td>
            <td class="num">{{ r.reviewed7d }}</td>
            <td class="num">{{ r.medianReactHours === null ? '—' : t('reviewWorkload.hours', { n: r.medianReactHours }) }}</td>
            <td class="num"><span :class="{ 'late-text': r.overdue > 0 }">{{ r.overdue }}</span></td>
            <td class="num">{{ r.delegatedToMe }} / {{ r.delegatedByMe }}</td>
            <td>{{ presence(r) }}</td>
            <td class="actions">
              <button class="btn ghost small" type="button" @click="openAbsence(r, true)">{{ t('reviewWorkload.moveQueue') }}</button>
              <button v-if="!r.absence" class="btn ghost small" type="button" @click="openAbsence(r)">{{ t('reviewWorkload.markAbsence') }}</button>
              <button v-else class="btn ghost small" type="button" @click="cancelAbsence(r)">{{ t('reviewWorkload.cancelAbsence') }}</button>
              <button class="btn ghost small" type="button" @click="openLimit(r)">{{ t('reviewWorkload.changeLimit') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="absence" class="overlay" @click.self="absence = null" @keydown.esc="absence = null">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="absence-title" @submit.prevent="saveAbsence">
        <h2 id="absence-title">{{ t('reviewAbsence.title') }}</h2>
        <p class="sub">{{ absence.fullName }}</p>
        <label>{{ t('reviewAbsence.kind') }}
          <select v-model="absenceForm.kind" class="field" required>
            <option v-for="k in REVIEWER_ABSENCE_KINDS" :key="k" :value="k">{{ t(`reviewAbsence.kinds.${k}`) }}</option>
          </select>
        </label>
        <label>{{ t('reviewAbsence.from') }}
          <input v-model="absenceForm.startsOn" class="field" type="date" required>
        </label>
        <label v-if="absenceForm.kind !== 'dismissal'">{{ t('reviewAbsence.to') }}
          <input v-model="absenceForm.endsOn" class="field" type="date" :min="absenceForm.startsOn" required>
        </label>
        <p v-else class="sub">{{ t('reviewAbsence.toHint') }}</p>
        <label>{{ t('reviewAbsence.substitute') }}
          <select v-model="absenceForm.substituteId" class="field">
            <option value="">{{ t('reviewAbsence.noSubstitute') }}</option>
            <option v-for="p in rows.filter(x => x.userId !== absence!.userId && !x.absence)" :key="p.userId" :value="p.userId">{{ p.fullName }}</option>
          </select>
        </label>
        <label class="check">
          <input v-model="absenceForm.moveOpenItems" type="checkbox" :disabled="absenceForm.kind === 'dismissal'">
          {{ t('reviewAbsence.move') }}
        </label>
        <p class="sub">{{ t('reviewAbsence.moveHint') }}</p>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('reviewAbsence.submit') }}</button>
          <button class="btn ghost" type="button" @click="absence = null">{{ t('reviewDelegate.cancel') }}</button>
        </div>
      </form>
    </div>

    <div v-if="limit" class="overlay" @click.self="limit = null" @keydown.esc="limit = null">
      <form class="modal" role="dialog" aria-modal="true" aria-labelledby="limit-title" @submit.prevent="saveLimit">
        <h2 id="limit-title">{{ t('reviewWorkload.limitTitle') }}</h2>
        <p class="sub">{{ limit.fullName }}</p>
        <label>{{ t('reviewWorkload.maxOpen') }}
          <input v-model.number="limitForm.maxOpenItems" class="field" type="number" min="1" max="200" required>
        </label>
        <label>{{ t('reviewWorkload.dailyTarget') }}
          <input v-model.number="limitForm.dailyTarget" class="field" type="number" min="1" max="200" required>
        </label>
        <label class="check">
          <input v-model="limitForm.acceptsDelegation" type="checkbox">
          {{ t('reviewWorkload.acceptsDelegation') }}
        </label>
        <p v-if="error" class="error-text" role="alert">{{ error }}</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('reviewWorkload.save') }}</button>
          <button class="btn ghost" type="button" @click="limit = null">{{ t('reviewDelegate.cancel') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.load { display: block; width: calc(var(--space-7) * 2); height: var(--space-2); border-radius: var(--radius-pill); background: var(--color-bg-line-soft); overflow: hidden; margin-bottom: var(--space-1); }
.load-fill { display: block; height: 100%; background: var(--color-teal); }
.load-fill.over { background: var(--color-coral); }
.late-text { color: var(--color-coral-ink); font-weight: 800; }
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 20; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(480px, 100%); box-sizing: border-box; }
.modal h2 { margin: 0; font-weight: 900; }
.modal label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.modal .check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); }
.modal .sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
}
</style>

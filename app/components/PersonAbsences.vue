<script setup lang="ts">
import { ABSENCE_KINDS, ABSENCE_LIMITS, ABSENCE_NORM_KINDS } from '#shared/enums'
import type { AbsenceKind, AbsenceNormKind, AbsenceSource, AbsenceStatus } from '#shared/enums'
import { absenceDays, validateAbsenceRange } from '#shared/domain/absences'
import { ABSENCE_DEFAULTS } from '#shared/schemas/absences'

/**
 * Блок «Відсутності» карточки человека (docs/v2/38 §5.1, §6.3, §6.4, §12; PR-33).
 *
 * По отпуску и больничному — «Норма · Використано · Залишок» с источником нормы («Норма
 * компанії» / «Норма точки» / «Індивідуально…»), «Скоригувати» и «Внести відсутність» по правам
 * смотрящего, записи за год и прошедшие во время отсутствия дедлайны с «Перенести». Числа и права
 * считает сервер (`GET /people/:id/absences`); живой расчёт формы §6.3 — только подсказка.
 * Постоянная строка про справочный характер данных — граница §7.12.
 */
const props = defineProps<{ personId: string, autoOpen?: boolean }>()

type NormSource = 'tenant' | 'location' | 'user' | 'system'
type Level = 'tenant' | 'location' | 'user'
interface NormView { value: number, source: NormSource, setAt: string | null, setBy: string | null, reason: string | null }
interface NormLevel { vacationDays: number | null, sickDays: number | null }
interface Rec {
  id: string
  kind: AbsenceKind
  dateFrom: string
  dateTo: string
  daysCount: number
  daysInYear: number
  status: AbsenceStatus
  source: AbsenceSource
  comment: string | null
  createdBy: { id: string, name: string } | null
}
interface Card {
  year: number
  person: { id: string, locationId: string | null, locationName: string | null, archived: boolean }
  norms: Record<AbsenceNormKind, NormView>
  levels: Record<Level, NormLevel | null>
  used: Record<AbsenceKind, number>
  remaining: Record<AbsenceNormKind, number>
  records: Rec[]
  missedDeadlines: { enrollmentId: string, title: string, dueAt: string, absence: { dateFrom: string, dateTo: string } }[]
  can: { record: boolean, adjust: Record<Level, boolean>, extend: boolean }
}

const { t, te } = useI18n()
const { api, apiRaw } = useApi()
const { formatShortDate, formatNumber } = useFormat()

const open = ref(false)
const card = ref<Card | null>(null)
const year = ref<number | null>(null)
const thisYear = ref<number | null>(null)
const loading = ref(false)
const loadFailed = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')

/** Дата без времени — в полдень по местному времени: смещение пояса не перекинет её на соседний день. */
const fmtDate = (d: string) => formatShortDate(`${d}T12:00:00`)
const fmtDays = (n: number) => formatNumber(n, { maximumFractionDigits: 1 })
const statusClass: Record<AbsenceStatus, string> = { planned: 'planned', approved: 'teal', cancelled: 'muted' }
const years = computed(() => thisYear.value ? [thisYear.value - 1, thisYear.value, thisYear.value + 1] : [])
const adjustYears = computed(() => thisYear.value ? [thisYear.value, thisYear.value + 1] : [])
const canAdjust = computed(() => !!card.value && Object.values(card.value.can.adjust).some(Boolean))
const otherUsed = computed(() => (card.value ? (['unpaid', 'other'] as const).filter(k => card.value!.used[k] > 0) : []))

function errText(err: unknown): string {
  const e = apiErrorOf(err)
  if (e.code === 'absence_overlap') {
    const c = e.details?.conflict as { dateFrom: string, dateTo: string } | undefined
    return c ? t('absence.err.overlap', { from: fmtDate(c.dateFrom), to: fmtDate(c.dateTo) }) : e.message
  }
  if (e.code === 'absence_record.range_invalid') return t(e.details?.reason === 'too_long' ? 'absence.err.tooLong' : 'absence.err.order')
  return te(`absence.err.${e.code}`) ? t(`absence.err.${e.code}`) : e.message
}

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const c = await api<Card>(`/people/${props.personId}/absences`, { query: year.value ? { year: year.value } : {} })
    card.value = c
    year.value = c.year
    thisYear.value ??= c.year
  }
  catch { loadFailed.value = true }
  finally { loading.value = false }
}

async function toggle() {
  open.value = !open.value
  if (open.value && !card.value) await load()
}

onMounted(async () => {
  if (props.autoOpen) open.value = true
  await load()
})

function sourceText(n: NormView): string {
  if (n.source === 'user') return t('absence.source.user', { who: n.setBy || '—', date: n.setAt ? formatShortDate(n.setAt) : '—' })
  return t(`absence.source.${n.source}`)
}

// ── «Скоригувати норму відсутностей» (§6.3) ─────────────────────────────────────────────
const adjust = reactive({ open: false, kind: 'vacation' as AbsenceNormKind, level: 'user' as Level, value: '' as string | number, reason: '' })
const adjustLevels = computed<Level[]>(() => (['tenant', 'location', 'user'] as const).filter(l => card.value?.can.adjust[l]))
const levelLabel = (l: Level) => l === 'location' ? t('absence.adjust.levelLocation', { name: card.value?.person.locationName ?? '—' }) : t(`absence.adjust.level.${l}`)
const field = (k: AbsenceNormKind) => (k === 'vacation' ? 'vacationDays' : 'sickDays') as keyof NormLevel

async function startAdjust() {
  // Норму правят на текущий или следующий год (§6.3): из прошлого года карточка переходит на текущий
  if (thisYear.value && !adjustYears.value.includes(year.value ?? 0)) {
    year.value = thisYear.value
    await load()
  }
  const levels = adjustLevels.value
  adjust.level = levels.includes('user') ? 'user' : levels[0] ?? 'user'
  adjust.kind = 'vacation'
  adjust.reason = ''
  fillAdjustValue()
  error.value = ''
  notice.value = ''
  adjust.open = true
}
function fillAdjustValue() {
  const v = card.value?.levels[adjust.level]?.[field(adjust.kind)]
  adjust.value = v ?? ''
}
watch(() => [adjust.kind, adjust.level, card.value], fillAdjustValue)

/** Живой расчёт под формой (§6.3): какая норма станет у человека, если сохранить. */
const preview = computed(() => {
  const c = card.value
  if (!c) return null
  const f = field(adjust.kind)
  const typed = adjust.value === '' ? null : Number(adjust.value)
  const at = (l: Level) => (adjust.level === l ? typed : c.levels[l]?.[f] ?? null)
  const norm = at('user') ?? at('location') ?? at('tenant') ?? ABSENCE_DEFAULTS[f]
  const used = c.used[adjust.kind]
  return { norm, used, remaining: Math.round((norm - used) * 10) / 10 }
})
const adjustReasonRequired = computed(() => adjust.level === 'user')
const adjustValueInvalid = computed(() => {
  if (adjust.value === '') return false
  const v = Number(adjust.value)
  return !Number.isFinite(v) || v < 0 || v > 365 || !Number.isInteger(v * 2)
})

async function saveAdjust() {
  const c = card.value
  if (!c || adjustValueInvalid.value) return
  if (adjustReasonRequired.value && adjust.reason.trim().length < ABSENCE_LIMITS.reasonMin) {
    error.value = t('absence.adjust.reasonRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    const scopeId = adjust.level === 'tenant' ? null : adjust.level === 'location' ? c.person.locationId : c.person.id
    await api('/absence-norms', {
      method: 'PUT',
      body: {
        scopeType: adjust.level,
        scopeId,
        year: c.year,
        [field(adjust.kind)]: adjust.value === '' ? null : Number(adjust.value),
        ...(adjust.reason.trim() ? { reason: adjust.reason.trim() } : {}),
      },
    })
    adjust.open = false
    notice.value = t('absence.saved')
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}

// ── «Внести відсутність» (§6.4) ─────────────────────────────────────────────────────────
const recordForm = reactive({ open: false, editId: '', wasApproved: false, kind: 'vacation' as AbsenceKind, dateFrom: '', dateTo: '', status: 'approved' as 'planned' | 'approved', comment: '' })
const rangeError = computed(() => {
  if (!recordForm.dateFrom || !recordForm.dateTo) return ''
  const e = validateAbsenceRange(recordForm.dateFrom, recordForm.dateTo)
  return e === 'order' ? t('absence.err.order') : e === 'too_long' ? t('absence.err.tooLong') : ''
})
const formDays = computed(() => (recordForm.dateFrom && recordForm.dateTo && !rangeError.value ? absenceDays(recordForm.dateFrom, recordForm.dateTo) : null))

function startRecord(r?: Rec) {
  Object.assign(recordForm, r
    ? { open: true, editId: r.id, wasApproved: r.status === 'approved', kind: r.kind, dateFrom: r.dateFrom, dateTo: r.dateTo, status: r.status === 'planned' ? 'planned' : 'approved', comment: r.comment ?? '' }
    : { open: true, editId: '', wasApproved: false, kind: 'vacation', dateFrom: '', dateTo: '', status: 'approved', comment: '' })
  error.value = ''
  notice.value = ''
}

function shiftedNotice(n: number) {
  return n ? t('absence.savedShifted', { n }) : t('absence.recordSaved')
}

async function saveRecord() {
  if (!recordForm.dateFrom || !recordForm.dateTo) {
    error.value = t('absence.err.periodRequired')
    return
  }
  if (rangeError.value) return
  busy.value = true
  error.value = ''
  try {
    const body = { kind: recordForm.kind, dateFrom: recordForm.dateFrom, dateTo: recordForm.dateTo, status: recordForm.status, comment: recordForm.comment.trim() || null }
    const res = recordForm.editId
      ? await apiRaw<{ meta: { shifted: number } }>(`/people/${props.personId}/absences/${recordForm.editId}`, { method: 'PATCH', body })
      : await apiRaw<{ meta: { shifted: number } }>(`/people/${props.personId}/absences`, { method: 'POST', body })
    recordForm.open = false
    notice.value = shiftedNotice(res.meta.shifted)
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}

async function setStatus(r: Rec, status: 'approved' | 'cancelled') {
  if (status === 'cancelled' && !confirm(t('absence.cancelConfirm'))) return
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    const res = await apiRaw<{ meta: { shifted: number } }>(`/people/${props.personId}/absences/${r.id}`, { method: 'PATCH', body: { status } })
    notice.value = status === 'cancelled' ? t('absence.cancelled') : shiftedNotice(res.meta.shifted)
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}

// ── «Дедлайн минув під час відсутності» → «Перенести» (§12) ─────────────────────────────
const extending = ref<{ enrollmentId: string, dueAt: string, reason: string } | null>(null)
function startExtend(enrollmentId: string) {
  extending.value = { enrollmentId, dueAt: '', reason: t('absence.missed.reasonDefault') }
  error.value = ''
}
async function saveExtend() {
  const e = extending.value
  if (!e?.dueAt) {
    error.value = t('absence.missed.dateRequired')
    return
  }
  busy.value = true
  error.value = ''
  try {
    // Конец выбранного дня по времени устройства — как поле срока в форме назначения
    await api(`/manage/enrollments/${e.enrollmentId}/extend`, { method: 'POST', body: { dueAt: new Date(`${e.dueAt}T23:59:00`).toISOString(), reason: e.reason.trim(), notify: true } })
    extending.value = null
    notice.value = t('absence.missed.moved')
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}
</script>

<template>
  <section class="absences card" :aria-busy="loading">
    <button type="button" class="head" :aria-expanded="open" aria-controls="person-absences-body" @click="toggle">
      <span class="panel-title">{{ card ? t('absence.card.title', { year: card.year }) : t('absence.card.titleShort') }}</span>
      <span class="chevron" aria-hidden="true">{{ open ? '−' : '+' }}</span>
    </button>

    <div v-if="open" id="person-absences-body" class="body">
      <p class="note sun">{{ t('absence.card.plaque') }}</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
      <p v-if="loadFailed" class="error-text">
        {{ t('absence.card.loadError') }}
        <button type="button" class="btn ghost small" @click="load">{{ t('absence.card.retry') }}</button>
      </p>

      <template v-if="card">
        <div class="row">
          <label class="label inline-label" for="absences-year">{{ t('absence.year') }}</label>
          <select id="absences-year" v-model.number="year" class="field year" @change="load">
            <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
          </select>
        </div>

        <div class="tiles">
          <div v-for="k in ABSENCE_NORM_KINDS" :key="k" class="tile">
            <h3 class="tile-title">{{ t(`absence.kind.${k}`) }}</h3>
            <p class="numbers">{{ t('absence.card.numbers', { norm: fmtDays(card.norms[k].value), used: fmtDays(card.used[k]), remaining: fmtDays(card.remaining[k]) }) }}</p>
            <p v-if="card.remaining[k] < 0" class="error-text small">{{ t('absence.card.exceeded', { n: fmtDays(-card.remaining[k]) }) }}</p>
            <p class="help">{{ sourceText(card.norms[k]) }}</p>
            <p v-if="card.norms[k].source === 'user' && card.norms[k].reason" class="help">{{ t('absence.card.reason', { reason: card.norms[k].reason }) }}</p>
          </div>
        </div>
        <p v-if="otherUsed.length" class="help">
          <span v-for="k in otherUsed" :key="k" class="other">{{ t('absence.card.usedOther', { kind: t(`absence.kind.${k}`), n: fmtDays(card.used[k]) }) }}</span>
        </p>

        <div class="row">
          <button v-if="canAdjust && !adjust.open" type="button" class="btn ghost" @click="startAdjust">{{ t('absence.adjust.open') }}</button>
          <button v-if="card.can.record && !recordForm.open" type="button" class="btn primary" @click="startRecord()">{{ t('absence.record.add') }}</button>
        </div>

        <form v-if="adjust.open" class="form" novalidate @submit.prevent="saveAdjust">
          <h3 class="panel-title">{{ t('absence.adjust.title') }}</h3>
          <div class="grid">
            <label class="label">{{ t('absence.adjust.kind') }}
              <select v-model="adjust.kind" class="field">
                <option v-for="k in ABSENCE_NORM_KINDS" :key="k" :value="k">{{ t(`absence.kind.${k}`) }}</option>
              </select>
            </label>
            <label class="label">{{ t('absence.adjust.levelLabel') }}
              <select v-model="adjust.level" class="field">
                <option v-for="l in adjustLevels" :key="l" :value="l">{{ levelLabel(l) }}</option>
              </select>
            </label>
            <label class="label">{{ t('absence.year') }}
              <select v-model.number="year" class="field" @change="load">
                <option v-for="y in adjustYears" :key="y" :value="y">{{ y }}</option>
              </select>
            </label>
            <label class="label">{{ t('absence.adjust.value') }}
              <input v-model="adjust.value" type="number" min="0" max="365" step="0.5" class="field" :placeholder="t('absence.adjust.inherit')" :aria-invalid="adjustValueInvalid" aria-describedby="absence-adjust-value-hint">
              <span id="absence-adjust-value-hint" class="help">{{ t('absence.adjust.valueHint') }}</span>
            </label>
          </div>
          <label class="label">{{ adjustReasonRequired ? t('absence.adjust.reasonRequiredLabel') : t('absence.adjust.reason') }}
            <input v-model="adjust.reason" class="field" :maxlength="ABSENCE_LIMITS.reasonMax" :aria-required="adjustReasonRequired">
          </label>
          <p v-if="adjustValueInvalid" class="error-text small">{{ t('absence.adjust.valueInvalid') }}</p>
          <p v-if="preview" class="calc" aria-live="polite">{{ t('absence.adjust.preview', { norm: fmtDays(preview.norm), used: fmtDays(preview.used), remaining: fmtDays(preview.remaining) }) }}</p>
          <p v-if="preview && preview.remaining < 0" class="note coral">{{ t('absence.adjust.negative', { n: fmtDays(-preview.remaining) }) }}</p>
          <div class="row">
            <button type="submit" class="btn primary" :disabled="busy || adjustValueInvalid">{{ t('common.save') }}</button>
            <button type="button" class="btn ghost" @click="adjust.open = false">{{ t('common.cancel') }}</button>
          </div>
        </form>

        <form v-if="recordForm.open" class="form" novalidate @submit.prevent="saveRecord">
          <h3 class="panel-title">{{ recordForm.editId ? t('absence.record.edit') : t('absence.record.add') }}</h3>
          <div class="grid">
            <label class="label">{{ t('absence.record.kind') }}
              <select v-model="recordForm.kind" class="field">
                <option v-for="k in ABSENCE_KINDS" :key="k" :value="k">{{ t(`absence.kind.${k}`) }}</option>
              </select>
            </label>
            <label class="label">{{ t('absence.record.from') }}
              <input v-model="recordForm.dateFrom" type="date" class="field" required :aria-invalid="!!rangeError">
            </label>
            <label class="label">{{ t('absence.record.to') }}
              <input v-model="recordForm.dateTo" type="date" class="field" required :min="recordForm.dateFrom || undefined" :aria-invalid="!!rangeError">
            </label>
            <label class="label">{{ t('absence.record.status') }}
              <select v-model="recordForm.status" class="field">
                <!-- Подтверждённое не становится снова «Заплановано» (§4) -->
                <option v-if="!recordForm.wasApproved" value="planned">{{ t('absence.status.planned') }}</option>
                <option value="approved">{{ t('absence.status.approved') }}</option>
              </select>
            </label>
          </div>
          <p v-if="rangeError" class="error-text small">{{ rangeError }}</p>
          <p v-else-if="formDays" class="help">{{ t('absence.record.days', { n: formDays }) }}</p>
          <label class="label">{{ t('absence.record.comment') }}
            <input v-model="recordForm.comment" class="field" :maxlength="ABSENCE_LIMITS.commentMax">
          </label>
          <p class="help">{{ t('absence.record.hint') }}</p>
          <div class="row">
            <button type="submit" class="btn primary" :disabled="busy || !!rangeError">{{ t('common.save') }}</button>
            <button type="button" class="btn ghost" @click="recordForm.open = false">{{ t('common.cancel') }}</button>
          </div>
        </form>

        <h3 class="panel-title">{{ t('absence.record.listTitle') }}</h3>
        <p v-if="!card.records.length" class="muted">{{ t('absence.record.empty', { year: card.year }) }}</p>
        <div v-else class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">{{ t('absence.record.period') }}</th>
                <th scope="col">{{ t('absence.record.kind') }}</th>
                <th scope="col">{{ t('absence.record.daysCol') }}</th>
                <th scope="col">{{ t('absence.record.status') }}</th>
                <th scope="col">{{ t('absence.record.comment') }}</th>
                <th scope="col">{{ t('absence.record.createdBy') }}</th>
                <th scope="col"><span class="sr-only">{{ t('absence.record.actions') }}</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in card.records" :key="r.id" :class="{ cancelled: r.status === 'cancelled' }">
                <td class="nowrap">{{ fmtDate(r.dateFrom) }} — {{ fmtDate(r.dateTo) }}</td>
                <td>{{ t(`absence.kind.${r.kind}`) }}</td>
                <td>{{ fmtDays(r.daysInYear) }}<span v-if="r.daysInYear !== r.daysCount" class="sub">{{ t('absence.record.ofTotal', { n: fmtDays(r.daysCount) }) }}</span></td>
                <td><span :class="['badge', statusClass[r.status]]">{{ t(`absence.status.${r.status}`) }}</span></td>
                <td>{{ r.comment || '—' }}</td>
                <td>{{ r.createdBy?.name || '—' }}<span v-if="r.source !== 'manual'" class="sub">{{ t(`absence.sourceKind.${r.source}`) }}</span></td>
                <td class="actions">
                  <template v-if="card.can.record && r.status !== 'cancelled'">
                    <button v-if="r.status === 'planned'" type="button" class="btn ghost small" :disabled="busy" @click="setStatus(r, 'approved')">{{ t('absence.record.approve') }}</button>
                    <button type="button" class="btn ghost small" :disabled="busy" @click="startRecord(r)">{{ t('absence.record.change') }}</button>
                    <button type="button" class="btn ghost small" :disabled="busy" @click="setStatus(r, 'cancelled')">{{ t('absence.record.cancel') }}</button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <template v-if="card.missedDeadlines.length">
          <h3 class="panel-title">{{ t('absence.missed.title') }}</h3>
          <ul class="missed">
            <li v-for="m in card.missedDeadlines" :key="m.enrollmentId">
              <span><b>{{ m.title }}</b> — {{ t('absence.missed.line', { due: formatShortDate(m.dueAt), from: fmtDate(m.absence.dateFrom), to: fmtDate(m.absence.dateTo) }) }}</span>
              <button v-if="card.can.extend && extending?.enrollmentId !== m.enrollmentId" type="button" class="btn ghost small" @click="startExtend(m.enrollmentId)">{{ t('absence.missed.move') }}</button>
              <form v-if="extending?.enrollmentId === m.enrollmentId" class="inline" @submit.prevent="saveExtend">
                <label class="label">{{ t('absence.missed.newDate') }}
                  <input v-model="extending.dueAt" type="date" class="field" required>
                </label>
                <label class="label grow">{{ t('absence.missed.reason') }}
                  <input v-model="extending.reason" class="field" maxlength="300">
                </label>
                <button type="submit" class="btn primary small" :disabled="busy || extending.reason.trim().length < ABSENCE_LIMITS.reasonMin">{{ t('absence.missed.move') }}</button>
                <button type="button" class="btn ghost small" @click="extending = null">{{ t('common.cancel') }}</button>
              </form>
            </li>
          </ul>
        </template>
      </template>
    </div>
  </section>
</template>

<style scoped>
.absences { display: grid; gap: var(--space-3); }
.head { font: inherit; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); background: transparent; border: none; padding: 0; cursor: pointer; color: var(--color-ink); text-align: left; }
.head .panel-title { margin: 0; }
.head:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; border-radius: var(--radius-s); }
.chevron { font-weight: 900; font-size: var(--font-size-title-l); color: var(--color-ink-muted); }
.body { display: grid; gap: var(--space-3); min-width: 0; }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.inline-label { margin: 0; }
.year { max-width: 160px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); }
.tile { border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-s); padding: var(--space-3); display: grid; gap: var(--space-1); }
.tile-title { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.numbers { margin: 0; font-weight: 800; }
.tile .help { margin: 0; }
.other + .other::before { content: ' · '; }
.form { display: grid; gap: var(--space-2); border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-3); }
.form .panel-title { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-2); }
.label { display: grid; gap: var(--space-1); }
.label.grow { flex: 1 1 220px; min-width: 0; }
.calc { margin: 0; font-weight: 800; }
.small { font-size: var(--font-size-body-s); margin: 0; }
.nowrap { white-space: nowrap; }
.sub { display: block; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.cancelled td { color: var(--color-ink-muted); }
.actions { white-space: nowrap; }
.actions .btn + .btn { margin-left: var(--space-1); }
.missed { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.missed li { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.inline { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: flex-end; width: 100%; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

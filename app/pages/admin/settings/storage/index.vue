<script setup lang="ts">
/**
 * «Сховище» (docs/v2/34-storage.md §5.1). Путь — `/admin/settings/storage`, а не `/storage`
 * документа: все тенантные настройки в этой кодовой базе живут под `/admin/settings/*`, так же
 * решил PR-10 для `/settings/billing` (пометка у `35` §5).
 *
 * Сервер считает, экран показывает (CLAUDE.md п. 3): занятое — оперативный счётчик, лимит и
 * допуск — одна функция `effectiveLimits()`, та же, что у баннера и счёта (`44` В-5). Удаление —
 * только заявкой с подсчётом доказательств (В-17): выделение → черновик → подтверждение §6.1.
 */
import { MEDIA_ORIGINS, STORAGE_OTHER_KEY } from '#shared/enums'
import { STORAGE_CONFIRM_PHRASE, STORAGE_STAGE_KEYS } from '#shared/schemas/storage'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'storage.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatBytes, formatShortDate, formatDateTime, formatNumber } = useFormat()

interface BreakdownRow { key: string, label: string | null, bytes: number, filesCount: number }
interface Summary {
  usedBytes: number
  limitBytes: number | null
  graceBytes: number
  pct: number | null
  tone: 'teal' | 'sun' | 'coral'
  blocked: boolean
  groupBy: 'origin' | 'stage'
  breakdown: BreakdownRow[]
  otherShare: number
  otherFiles: number
  updatedAt: string | null
  collectedAt: string | null
  driftBytes: number | null
  trash: { files: number, bytes: number }
  pending: { files: number, bytes: number }
  stageLabels: Record<string, string>
  trashDays: number
}
interface FileRow {
  id: string, originalName: string, kind: string, mime: string, bytes: number, origin: string, stageCode: string | null
  isEvidence: boolean, lifecycle: string, status: string, createdAt: string, ownerUserId: string | null, ownerName: string | null
  courseId: string | null, courseTitle: string | null, notDeletable: 'not_deletable' | 'under_review' | 'already_deleted' | null
}
interface DeletionRequest { id: string, plannedFiles: number, plannedBytes: number, evidenceCount: number, notDeletableCount: number, deletedFiles: number, deletedBytes: number, skipped: unknown[] }

const summary = ref<Summary | null>(null)
const summaryError = ref('')
const groupBy = ref<'origin' | 'stage'>('origin')

async function loadSummary() {
  summaryError.value = ''
  try { summary.value = await api<Summary>('/storage/summary', { query: { groupBy: groupBy.value } }) }
  catch (err) { summaryError.value = apiErrorOf(err).message }
}
watch(groupBy, loadSummary)

const filters = reactive({ origin: '' as string, stage: '' as string, from: '', to: '', status: 'active' as 'active' | 'orphaned' | 'failed', evidenceOnly: false })
const files = ref<FileRow[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(true)
const listError = ref(false)
const selected = ref<Set<string>>(new Set())
const notice = ref('')

function query(cursor?: string | null): Record<string, string> {
  const q: Record<string, string> = { status: filters.status }
  if (filters.origin) q.origin = filters.origin
  if (filters.stage) q.stage = filters.stage
  if (filters.from) q.from = filters.from
  if (filters.to) q.to = filters.to
  if (filters.evidenceOnly) q.evidenceOnly = 'true'
  if (cursor) q.cursor = cursor
  return q
}

async function loadFiles(reset = true) {
  listError.value = false
  if (reset) { loading.value = true; selected.value = new Set() }
  try {
    const page = await api<{ items: FileRow[], nextCursor: string | null }>('/storage/files', { query: query(reset ? null : nextCursor.value) })
    files.value = reset ? page.items : [...files.value, ...page.items]
    nextCursor.value = page.nextCursor
  }
  catch { listError.value = true }
  finally { loading.value = false }
}
function resetFilters() {
  Object.assign(filters, { origin: '', stage: '', from: '', to: '', status: 'active', evidenceOnly: false })
  loadFiles()
}

onMounted(() => { loadSummary(); loadFiles() })

// ── Сводка ──
const GIB = 1024 ** 3
const barWidth = computed(() => Math.min(100, summary.value?.pct ?? 0))
const usedLine = computed(() => {
  const s = summary.value
  if (!s) return ''
  const used = formatBytes(s.usedBytes)
  return s.limitBytes == null ? t('storage.usedUnlimited', { used }) : t('storage.used', { used, limit: formatBytes(s.limitBytes, { maximumFractionDigits: s.limitBytes % GIB === 0 ? 0 : 1 }) })
})
const maxBar = computed(() => Math.max(1, ...(summary.value?.breakdown ?? []).map(r => r.bytes)))
/** Подпись ключа этапа — из справочника тенанта; девятый ключ — «Інше» из словаря. */
function stageLabel(key: string) {
  return key === STORAGE_OTHER_KEY ? t('storage.breakdown.other') : (summary.value?.stageLabels[key] ?? key)
}
function breakdownLabel(r: BreakdownRow) {
  return summary.value?.groupBy === 'stage' ? stageLabel(r.key) : t(`storage.origin.${r.key}`)
}
const otherPct = computed(() => formatNumber(summary.value?.otherShare ?? 0, { style: 'percent', maximumFractionDigits: 1 }))

// ── Таблица и выделение ──
const selectable = computed(() => files.value.filter(f => !f.notDeletable))
const selectedRows = computed(() => files.value.filter(f => selected.value.has(f.id)))
const selectedBytes = computed(() => selectedRows.value.reduce((s, f) => s + f.bytes, 0))
const allChecked = computed(() => selectable.value.length > 0 && selectable.value.every(f => selected.value.has(f.id)))
function toggle(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}
function toggleAll(on: boolean) {
  selected.value = on ? new Set(selectable.value.map(f => f.id)) : new Set()
}
const fileLabel = (f: FileRow) => f.originalName || `${f.kind}.${f.mime.split('/')[1] ?? ''}`

// ── Удаление заявкой (§6.1) ──
const request = ref<DeletionRequest | null>(null)
const trashDays = computed(() => summary.value?.trashDays ?? 30)
const form = reactive({ reason: '', phrase: '', ack: false })
const dialog = ref<HTMLFormElement | null>(null)
// Фокус — внутрь диалога: с клавиатуры подтверждение доступно без мыши
watch(request, (r) => { if (r) nextTick(() => dialog.value?.querySelector<HTMLElement>('textarea, input, button')?.focus()) })
const formError = ref('')
const busy = ref(false)

async function startDelete() {
  formError.value = ''
  notice.value = ''
  busy.value = true
  try {
    request.value = await api<DeletionRequest>('/storage/deletions', { method: 'POST', body: { mode: 'selection', mediaIds: [...selected.value] } })
    Object.assign(form, { reason: '', phrase: '', ack: false })
  }
  catch (err) { notice.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
async function cancelDelete() {
  if (request.value) await api(`/storage/deletions/${request.value.id}/cancel`, { method: 'POST' }).catch(() => null)
  request.value = null
}
async function confirmDelete() {
  if (!request.value) return
  formError.value = ''
  const evidence = request.value.evidenceCount > 0
  if (evidence && (form.reason.trim().length < 10 || form.reason.trim().length > 500)) { formError.value = t('storage.confirm.reasonError'); return }
  if (evidence && form.phrase !== STORAGE_CONFIRM_PHRASE) { formError.value = t('storage.confirm.phraseError'); return }
  if (!form.ack) { formError.value = t('storage.confirm.ackError'); return }
  busy.value = true
  try {
    const done = await api<DeletionRequest>(`/storage/deletions/${request.value.id}/confirm`, {
      method: 'POST',
      body: { acknowledged: true, reason: form.reason.trim() || undefined, confirmPhrase: form.phrase || undefined },
    })
    notice.value = t('storage.confirm.done', { n: done.deletedFiles, size: formatBytes(done.deletedBytes), skipped: done.skipped.length })
    request.value = null
    await Promise.all([loadSummary(), loadFiles()])
  }
  catch (err) { formError.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
function onDialogKey(e: KeyboardEvent) { if (e.key === 'Escape') cancelDelete() }

const showIncrease = ref(false)
</script>

<template>
  <div>
    <PageHeader :title="t('storage.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('storage.title') }]">
      <template v-if="hasScope('storage.addon')" #actions>
        <button type="button" class="btn primary" :aria-expanded="showIncrease" @click="showIncrease = !showIncrease">{{ t('storage.increase') }}</button>
      </template>
    </PageHeader>
    <p v-if="showIncrease" class="note sun">{{ t('storage.increaseHint') }}</p>

    <StorageTabs />

    <!-- Сводка (§5.1): «Використовується: 12.4 Gb / 100 Gb», полоса бирюза / солнце / коралл -->
    <section v-if="summary" class="card summary" :class="summary.tone">
      <p class="used">{{ usedLine }}</p>
      <div v-if="summary.limitBytes !== null" class="bar" role="progressbar" :aria-valuenow="Math.round(barWidth)" aria-valuemin="0" aria-valuemax="100" :aria-label="usedLine">
        <i :style="{ width: `${barWidth}%` }" />
      </div>
      <p class="help">
        {{ t('storage.updatedNow') }} ·
        <small>{{ summary.collectedAt ? t('storage.collectedAt', { date: formatShortDate(summary.collectedAt) }) : t('storage.notCollected') }}</small>
        <small v-if="summary.driftBytes"> · {{ t('storage.drift', { size: formatBytes(Math.abs(summary.driftBytes)) }) }}</small>
      </p>
      <p v-if="summary.blocked" class="note coral" role="status">{{ t('storage.blocked') }}</p>
      <p v-if="summary.pending.files" class="note sun">{{ t('storage.pending', { n: summary.pending.files, size: formatBytes(summary.pending.bytes) }) }}</p>
      <p v-if="summary.otherShare > 0.05" class="note sun">{{ t('storage.otherShareHigh', { pct: otherPct }) }}</p>
      <p v-if="summary.otherFiles" class="help">{{ t('storage.unclassified', { n: summary.otherFiles }) }}</p>
      <p v-if="summary.trash.files" class="help">{{ t('storage.trashSummary', { n: summary.trash.files, size: formatBytes(summary.trash.bytes) }) }}</p>
    </section>
    <p v-else-if="summaryError" class="error-text" role="alert">{{ summaryError }}</p>

    <!-- Разбивка: «За походженням» (по умолчанию) и «За етапом» — девять ключей (В-10) -->
    <section v-if="summary" class="card breakdown">
      <div class="breakdown-head">
        <h2 class="panel-title">{{ t('storage.breakdown.title') }}</h2>
        <div class="segmented" role="group" :aria-label="t('storage.breakdown.title')">
          <button type="button" :class="{ on: groupBy === 'origin' }" :aria-pressed="groupBy === 'origin'" @click="groupBy = 'origin'">{{ t('storage.breakdown.byOrigin') }}</button>
          <button type="button" :class="{ on: groupBy === 'stage' }" :aria-pressed="groupBy === 'stage'" @click="groupBy = 'stage'">{{ t('storage.breakdown.byStage') }}</button>
        </div>
      </div>
      <p v-if="!summary.breakdown.length" class="help">{{ t('storage.breakdown.empty') }}</p>
      <ul v-else class="bars">
        <li v-for="r in summary.breakdown" :key="r.key" class="bar-row">
          <span class="bar-label">{{ breakdownLabel(r) }}</span>
          <span class="bar-track" aria-hidden="true"><i :style="{ width: `${Math.round(r.bytes / maxBar * 100)}%` }" /></span>
          <span class="bar-value">{{ formatBytes(r.bytes) }} <small>· {{ t('storage.breakdown.files', { n: r.filesCount }) }}</small></span>
        </li>
      </ul>
    </section>

    <!-- Фильтры (§5.1) -->
    <form class="filters" @submit.prevent="loadFiles()">
      <label class="filter">
        <span>{{ t('storage.filters.origin') }}</span>
        <select v-model="filters.origin" class="field">
          <option value="">{{ t('storage.filters.anyOrigin') }}</option>
          <option v-for="o in MEDIA_ORIGINS" :key="o" :value="o">{{ t(`storage.origin.${o}`) }}</option>
        </select>
      </label>
      <label class="filter">
        <span>{{ t('storage.filters.stage') }}</span>
        <select v-model="filters.stage" class="field">
          <option value="">{{ t('storage.filters.anyStage') }}</option>
          <option v-for="k in STORAGE_STAGE_KEYS" :key="k" :value="k">{{ stageLabel(k) }}</option>
        </select>
      </label>
      <label class="filter">
        <span>{{ t('storage.filters.from') }}</span>
        <input v-model="filters.from" type="date" class="field">
      </label>
      <label class="filter">
        <span>{{ t('storage.filters.to') }}</span>
        <input v-model="filters.to" type="date" class="field">
      </label>
      <label class="filter">
        <span>{{ t('storage.filters.status') }}</span>
        <select v-model="filters.status" class="field">
          <option value="active">{{ t('storage.statusOf.active') }}</option>
          <option value="orphaned">{{ t('storage.statusOf.orphaned') }}</option>
          <option value="failed">{{ t('storage.statusOf.failed') }}</option>
        </select>
      </label>
      <label class="toggle evidence-toggle">
        <input v-model="filters.evidenceOnly" type="checkbox">
        <span>{{ t('storage.filters.evidenceOnly') }}</span>
      </label>
      <div class="filter-actions">
        <button type="submit" class="btn ghost">{{ t('storage.filters.apply') }}</button>
        <button type="button" class="btn ghost" @click="resetFilters">{{ t('storage.filters.reset') }}</button>
      </div>
    </form>

    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <!-- Таблица, курсор по 50 (§5.1). Загрузка — скелет из 8 строк; сводка при этом показывает последний счётчик -->
    <div v-if="loading" class="skeletons" aria-busy="true">
      <div v-for="i in 8" :key="i" class="skeleton" />
    </div>
    <template v-else-if="listError">
      <p class="error-text" role="alert">{{ t('storage.loadError') }}</p>
      <button type="button" class="btn ghost" @click="loadFiles()">{{ t('storage.retry') }}</button>
    </template>
    <p v-else-if="!files.length" class="help empty">{{ t('storage.empty') }}</p>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">
              <input
                v-if="hasScope('storage.delete')"
                type="checkbox"
                :checked="allChecked"
                :disabled="!selectable.length"
                :aria-label="t('storage.selectAll')"
                @change="toggleAll(($event.target as HTMLInputElement).checked)"
              >
            </th>
            <th scope="col">{{ t('storage.col.file') }}</th>
            <th scope="col">{{ t('storage.col.origin') }}</th>
            <th scope="col">{{ t('storage.col.owner') }}</th>
            <th scope="col">{{ t('storage.col.track') }}</th>
            <th scope="col">{{ t('storage.col.date') }}</th>
            <th scope="col" class="num">{{ t('storage.col.size') }}</th>
            <th scope="col">{{ t('storage.col.evidence') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in files" :key="f.id">
            <td>
              <input
                v-if="hasScope('storage.delete')"
                type="checkbox"
                :checked="selected.has(f.id)"
                :disabled="!!f.notDeletable"
                :title="f.notDeletable ? t(`storage.notDeletable.${f.notDeletable}`) : undefined"
                :aria-label="t('storage.selectRow', { name: fileLabel(f) })"
                @change="toggle(f.id, ($event.target as HTMLInputElement).checked)"
              >
            </td>
            <td class="file-cell">
              <span class="file-name">{{ fileLabel(f) }}</span>
              <span v-if="f.notDeletable" class="sub">{{ t(`storage.notDeletable.${f.notDeletable}`) }}</span>
            </td>
            <td>{{ t(`storage.origin.${f.origin}`) }}</td>
            <td>{{ f.ownerName ?? (f.ownerUserId ? '—' : t('storage.ownerDeleted')) }}</td>
            <td>{{ f.courseTitle ?? '—' }}</td>
            <td class="nowrap"><time :datetime="f.createdAt" :title="formatDateTime(f.createdAt)">{{ formatShortDate(f.createdAt) }}</time></td>
            <td class="num nowrap">{{ formatBytes(f.bytes) }}</td>
            <td>
              <span v-if="f.isEvidence" class="badge sun" :title="t('storage.evidence')">🔒 <span class="sr-only">{{ t('storage.evidence') }}</span></span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <button v-if="nextCursor && !loading" type="button" class="btn ghost" @click="loadFiles(false)">{{ t('common.loadMore') }}</button>

    <!-- При выделении внизу «Обрано {n} файлів · {size}» и «Видалити» (коралл) -->
    <div v-if="selected.size && hasScope('storage.delete')" class="selection-bar" role="region" :aria-label="t('storage.selected', { n: selected.size, size: formatBytes(selectedBytes) })">
      <span>{{ t('storage.selected', { n: selected.size, size: formatBytes(selectedBytes) }) }}</span>
      <button type="button" class="btn danger" :disabled="busy" @click="startDelete">{{ t('storage.delete') }}</button>
    </div>

    <!-- Подтверждение удаления (§6.1) -->
    <div v-if="request" class="overlay" @click.self="cancelDelete" @keydown="onDialogKey">
      <form ref="dialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="del-title" @submit.prevent="confirmDelete">
        <h2 id="del-title">{{ t('storage.confirm.title') }}</h2>
        <p>{{ t('storage.selected', { n: request.plannedFiles, size: formatBytes(request.plannedBytes) }) }}</p>
        <p v-if="request.notDeletableCount" class="help">{{ t('storage.confirm.skipped', { n: request.notDeletableCount }) }}</p>
        <p v-if="request.evidenceCount" class="note coral">{{ t('storage.confirm.evidenceWarning', { k: request.evidenceCount }) }}</p>
        <template v-if="request.evidenceCount">
          <label class="label" for="del-reason">{{ t('storage.confirm.reason') }}</label>
          <textarea id="del-reason" v-model="form.reason" class="field" rows="3" maxlength="500" :placeholder="t('storage.confirm.reasonHint')" />
          <label class="label" for="del-phrase">{{ t('storage.confirm.phrase') }}</label>
          <input id="del-phrase" v-model="form.phrase" class="field" autocomplete="off" spellcheck="false">
        </template>
        <label class="ack">
          <input v-model="form.ack" type="checkbox">
          <span>{{ t('storage.confirm.ack', { days: trashDays }) }}</span>
        </label>
        <p v-if="formError" class="error-text" role="alert">{{ formError }}</p>
        <div class="modal-actions">
          <button type="button" class="btn ghost" @click="cancelDelete">{{ t('storage.confirm.cancel') }}</button>
          <button type="submit" class="btn danger" :disabled="busy || !request.plannedFiles">{{ t('storage.confirm.submit') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.summary { margin-bottom: var(--space-4); }
.used { margin: 0; font-size: 22px; font-weight: 900; letter-spacing: -0.01em; }
.bar { height: 8px; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); margin: var(--space-3) 0 var(--space-2); overflow: hidden; }
.bar i { display: block; height: 100%; background: var(--color-teal); }
.summary.sun .bar i { background: var(--color-sun); }
.summary.coral .bar i { background: var(--color-coral); }
.summary .note { margin: var(--space-2) 0 0; }
.breakdown { margin-bottom: var(--space-4); }
.breakdown-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); }
.breakdown-head .panel-title { margin: 0; }
.bars { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.bar-row { display: grid; grid-template-columns: minmax(120px, 220px) minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; }
.bar-label { font-weight: 700; font-size: var(--font-size-body-s); overflow-wrap: anywhere; }
.bar-track { height: 10px; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); overflow: hidden; }
.bar-track i { display: block; height: 100%; background: var(--color-teal); }
.bar-value { font-weight: 800; font-size: var(--font-size-body-s); white-space: nowrap; }
.bar-value small { font-weight: 700; color: var(--color-ink-muted); }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: end; margin-bottom: var(--space-4); }
.filter { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); min-width: 140px; }
.filter .field { padding: var(--space-2) var(--space-3); }
.evidence-toggle { padding-bottom: var(--space-2); }
.filter-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.file-cell { max-width: 280px; }
.file-name { font-weight: 700; overflow-wrap: anywhere; }
.nowrap { white-space: nowrap; }
.empty { margin: var(--space-4) 0; }
.skeletons { display: grid; gap: var(--space-2); }
.skeleton { height: 44px; border-radius: var(--radius-s); background: var(--color-bg-line-soft); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.selection-bar { position: sticky; bottom: 0; display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); margin-top: var(--space-3); font-weight: 800; }
.overlay { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: var(--space-4); background: color-mix(in srgb, var(--color-ink) 45%, transparent); }
.modal { width: min(520px, 100%); max-height: calc(100dvh - 2 * var(--space-4)); overflow-y: auto; box-sizing: border-box; background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-5); display: grid; gap: var(--space-3); }
.modal h2 { margin: 0; font-size: 20px; font-weight: 900; }
.modal p { margin: 0; }
.ack { display: flex; gap: var(--space-2); align-items: flex-start; font-weight: 700; font-size: var(--font-size-body-s); }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); flex-wrap: wrap; }
@media (max-width: 600px) {
  .bar-row { grid-template-columns: minmax(0, 1fr) auto; }
  .bar-track { grid-column: 1 / -1; grid-row: 2; }
  .filter { min-width: 0; flex: 1 1 140px; }
  .modal { padding: var(--space-4); }
}
</style>

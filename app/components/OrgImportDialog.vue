<script setup lang="ts">
/**
 * «Імпорт» оргструктуры CSV (docs/v2/32 §6.2, §9, критерий приёмки 6; PR-31).
 *
 * Шаги `docs/16` §5.4: загрузка → сопоставление колонок → предпросмотр («створити» бирюзой,
 * «оновити» солнцем, «помилка» кораллом) → опции → запуск. Применяет файл фоновая задача
 * одной транзакцией; экран опрашивает статус и показывает итог словами сервера, а после
 * импорта предлагает «Відкотити імпорт» — к снимку `pre_import`, сделанному перед записью.
 *
 * Что считать ошибкой, решает сервер (`shared/domain/orgImport.ts`): здесь только коды
 * и их перевод. Петли и висячие узлы в дерево не попадают — они в «Конфлікти структури».
 */
import { ORG_IMPORT_COLUMNS } from '#shared/domain/orgImport'

interface Issue { code: string, params?: Record<string, string | number> }
interface RowResult { line: number, key: string, parentKey: string, title: string, employee: string, action: 'create' | 'update' | 'same' | 'error', errors: Issue[], warnings: Issue[] }
interface Options { createPositions: boolean, archiveMissing: boolean, snapshot: boolean }
interface Stats {
  total?: number, create?: number, update?: number, same?: number, errors?: number, archive?: number, assignmentsChanged?: number
  created?: number, updated?: number, archived?: number, snapshotId?: string | null, error?: string
}
interface View { jobId: string, fileName: string, status: string, headers: string[], mapping: Record<string, string>, options: Options, snapshotForced: boolean, unmapped: string[], stats: Stats, rows: RowResult[] }

const emit = defineEmits<{ close: [], changed: [message: string] }>()

const { t } = useI18n()
const { api } = useApi()

const file = ref<File | null>(null)
const view = ref<View | null>(null)
const mapping = ref<Record<string, string>>({})
const options = reactive<Options>({ createPositions: false, archiveMissing: false, snapshot: true })
const busy = ref(false)
const error = ref('')
const notice = ref('')
const onlyErrors = ref(false)
const dialog = ref<HTMLElement | null>(null)
let poll: ReturnType<typeof setInterval> | undefined

const SHOWN = 200
const step = computed(() => !view.value ? 'file' : view.value.status === 'ready' ? 'review' : ['queued', 'applying'].includes(view.value.status) ? 'running' : 'done')
const visibleRows = computed(() => (view.value?.rows ?? []).filter(r => !onlyErrors.value || r.errors.length).slice(0, SHOWN))
const filteredTotal = computed(() => (view.value?.rows ?? []).filter(r => !onlyErrors.value || r.errors.length).length)
const hasChanges = computed(() => {
  const s = view.value?.stats ?? {}
  return (s.create ?? 0) + (s.update ?? 0) + (s.archive ?? 0) + (s.assignmentsChanged ?? 0) > 0
})

onMounted(() => dialog.value?.querySelector<HTMLElement>('input')?.focus())
onBeforeUnmount(() => clearInterval(poll))

function messageOf(err: unknown): string {
  const e = apiErrorOf(err)
  const key = `orgStructure.err.${e.code}`
  return t(key) === key ? e.message : t(key)
}

/** Текст проблемы строки: колонка формата — её подписью, остальное — как пришло. */
function issueText(kind: 'err' | 'warn', i: Issue): string {
  const params: Record<string, string | number> = { ...(i.params ?? {}) }
  if (typeof params.column === 'string') params.column = t(`orgImport.col.${params.column}`)
  return t(`orgImport.${kind}.${i.code}`, params)
}

function take(v: View) {
  view.value = v
  mapping.value = { ...v.mapping }
  Object.assign(options, v.options)
}

function onFile(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function upload() {
  if (!file.value) return
  busy.value = true
  error.value = ''
  try {
    const form = new FormData()
    form.append('file', file.value)
    take(await api<View>('/org-structure/import', { method: 'POST', body: form }))
  }
  catch (err) { error.value = messageOf(err) }
  finally { busy.value = false }
}

/** Сопоставление и опции → та же проверка тех же строк на сервере. */
async function recheck() {
  if (!view.value) return
  busy.value = true
  error.value = ''
  try {
    take(await api<View>(`/org-structure/import/${view.value.jobId}/mapping`, { method: 'POST', body: { mapping: mapping.value, options: { ...options } } }))
  }
  catch (err) { error.value = messageOf(err) }
  finally { busy.value = false }
}

async function refresh() {
  if (!view.value) return
  try {
    const v = await api<View>(`/org-structure/import/${view.value.jobId}`)
    view.value = v
    if (!['queued', 'applying'].includes(v.status)) {
      clearInterval(poll)
      if (v.status === 'applied') emit('changed', doneText.value)
    }
  }
  catch { /* следующий опрос */ }
}

async function run() {
  if (!view.value) return
  if (options.archiveMissing && !confirm(t('orgImport.archiveWarn'))) return
  busy.value = true
  error.value = ''
  try {
    await api(`/org-structure/import/${view.value.jobId}/apply`, { method: 'POST' })
    view.value = { ...view.value, status: 'queued' }
    poll = setInterval(refresh, 1500)
  }
  catch (err) { error.value = messageOf(err) }
  finally { busy.value = false }
}

const doneText = computed(() => {
  const s = view.value?.stats ?? {}
  const base = t('orgImport.done', { created: s.created ?? 0, updated: s.updated ?? 0, errors: s.errors ?? 0 })
  return s.archived ? `${base} ${t('orgImport.archivedDone', { n: s.archived })}` : base
})

async function rollbackImport() {
  const id = view.value?.stats.snapshotId
  if (!id || !confirm(t('orgImport.rollbackImportConfirm'))) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ nodes: number, assignmentsCreated: number, assignmentsEnded: number }>(`/org-structure/snapshots/${id}/rollback`, { method: 'POST' })
    notice.value = t('orgStructure.rollbackDone', { nodes: r.nodes, created: r.assignmentsCreated, ended: r.assignmentsEnded })
    emit('changed', notice.value)
  }
  catch (err) { error.value = messageOf(err) }
  finally { busy.value = false }
}

function restart() {
  clearInterval(poll)
  view.value = null
  file.value = null
  error.value = ''
  notice.value = ''
}

const ACTION_BADGE: Record<RowResult['action'], string> = { create: 'teal', update: 'sun', same: 'muted', error: 'coral' }
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section ref="dialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
      <h2 id="import-title">{{ t('orgImport.title') }}</h2>
      <p class="sub">{{ t('orgImport.hint') }}</p>

      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

      <!-- Шаг 1: загрузка -->
      <form v-if="step === 'file'" class="grid" @submit.prevent="upload">
        <label>{{ t('orgImport.file') }}
          <input class="field" type="file" accept=".csv,text/csv" @change="onFile">
        </label>
        <div class="actions">
          <button class="btn primary" type="submit" :disabled="busy || !file">{{ t('orgImport.upload') }}</button>
          <button class="btn ghost" type="button" @click="emit('close')">{{ t('orgImport.close') }}</button>
        </div>
      </form>

      <!-- Шаги 2–5: сопоставление, предпросмотр, опции, запуск -->
      <template v-else-if="view && step === 'review'">
        <p class="file"><b>{{ view.fileName }}</b></p>

        <fieldset class="group">
          <legend>{{ t('orgImport.mapping') }}</legend>
          <p class="sub">{{ t('orgImport.mappingHint') }}</p>
          <div class="mapping">
            <label v-for="h in view.headers" :key="h">{{ h }}
              <select v-model="mapping[h]" class="field">
                <option value="">{{ t('orgImport.skip') }}</option>
                <option v-for="c in ORG_IMPORT_COLUMNS" :key="c" :value="c">{{ t(`orgImport.col.${c}`) }}</option>
              </select>
            </label>
          </div>
          <p v-if="view.unmapped.length" class="error-text">{{ t('orgImport.unmapped', { columns: view.unmapped.map(c => t(`orgImport.col.${c}`)).join(', ') }) }}</p>
          <div class="actions start">
            <button class="btn ghost small" type="button" :disabled="busy" @click="recheck">{{ t('orgImport.recheck') }}</button>
          </div>
        </fieldset>

        <div class="chips" role="status">
          <span class="badge">{{ t('orgImport.stats.total', { n: view.stats.total ?? 0 }) }}</span>
          <span class="badge teal">{{ t('orgImport.stats.create', { n: view.stats.create ?? 0 }) }}</span>
          <span class="badge sun">{{ t('orgImport.stats.update', { n: view.stats.update ?? 0 }) }}</span>
          <span class="badge muted">{{ t('orgImport.stats.same', { n: view.stats.same ?? 0 }) }}</span>
          <span :class="['badge', (view.stats.errors ?? 0) ? 'coral' : 'muted']">{{ t('orgImport.stats.errors', { n: view.stats.errors ?? 0 }) }}</span>
          <span v-if="view.stats.assignmentsChanged" class="badge">{{ t('orgImport.stats.assignments', { n: view.stats.assignmentsChanged }) }}</span>
          <span v-if="view.stats.archive" class="badge">{{ t('orgImport.stats.archive', { n: view.stats.archive }) }}</span>
        </div>

        <fieldset class="group">
          <legend>{{ t('orgImport.options') }}</legend>
          <label class="check"><input v-model="options.createPositions" type="checkbox" :disabled="busy" @change="recheck"> {{ t('orgImport.createPositions') }}</label>
          <label class="check"><input v-model="options.archiveMissing" type="checkbox" :disabled="busy" @change="recheck"> {{ t('orgImport.archiveMissing') }}</label>
          <label class="check"><input v-model="options.snapshot" type="checkbox" :disabled="busy || view.snapshotForced" @change="recheck"> {{ t('orgImport.snapshot') }}</label>
          <p v-if="view.snapshotForced" class="sub">{{ t('orgImport.snapshotForced') }}</p>
        </fieldset>

        <h3>{{ t('orgImport.preview') }}</h3>
        <label class="check"><input v-model="onlyErrors" type="checkbox"> {{ t('orgImport.onlyErrors') }}</label>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>{{ t('orgImport.line') }}</th>
                <th>{{ t('orgImport.key') }}</th>
                <th>{{ t('orgImport.nodeTitle') }}</th>
                <th>{{ t('orgImport.parent') }}</th>
                <th>{{ t('orgImport.action') }}</th>
                <th>{{ t('orgImport.messages') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in visibleRows" :key="r.line">
                <td class="num">{{ r.line }}</td>
                <td class="wrap">{{ r.key }}</td>
                <td class="wrap">{{ r.title }}<span v-if="r.employee" class="sub">{{ r.employee }}</span></td>
                <td class="wrap">{{ r.parentKey || t('orgStructure.noValue') }}</td>
                <td><span :class="['badge', ACTION_BADGE[r.action]]">{{ t(`orgImport.acts.${r.action}`) }}</span></td>
                <td class="wrap">
                  <span v-for="(e, i) in r.errors" :key="`e${i}`" class="msg err">{{ issueText('err', e) }}</span>
                  <span v-for="(w, i) in r.warnings" :key="`w${i}`" class="msg">{{ issueText('warn', w) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="filteredTotal > SHOWN" class="sub">{{ t('orgImport.moreRows', { n: SHOWN, total: filteredTotal }) }}</p>

        <div class="actions">
          <button class="btn primary" type="button" :disabled="busy || !hasChanges || view.unmapped.length > 0" @click="run">{{ t('orgImport.run') }}</button>
          <button class="btn ghost" type="button" :disabled="busy" @click="restart">{{ t('orgImport.back') }}</button>
          <button class="btn ghost" type="button" @click="emit('close')">{{ t('orgImport.close') }}</button>
        </div>
      </template>

      <!-- Применение идёт фоном -->
      <p v-else-if="step === 'running'" class="note sun" role="status" aria-live="polite">{{ t('orgImport.running') }}</p>

      <!-- Итог -->
      <template v-else-if="view">
        <p v-if="view.status === 'applied'" class="note teal" role="status">{{ doneText }}</p>
        <p v-else class="note coral" role="alert">{{ t('orgImport.failed', { error: view.stats.error ?? '' }) }}</p>
        <div class="actions">
          <NuxtLink v-if="view.status === 'applied' && (view.stats.errors ?? 0) > 0" to="/admin/org-conflicts" class="btn ghost">{{ t('orgImport.conflicts') }}</NuxtLink>
          <button v-if="view.status === 'applied' && view.stats.snapshotId && !notice" class="btn ghost" type="button" :disabled="busy" @click="rollbackImport">{{ t('orgImport.rollbackImport') }}</button>
          <button class="btn ghost" type="button" @click="restart">{{ t('orgImport.back') }}</button>
          <button class="btn primary" type="button" @click="emit('close')">{{ t('orgImport.close') }}</button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(960px, 100%); box-sizing: border-box; max-height: calc(100vh - 2 * var(--space-3)); overflow: auto; min-width: 0; }
.modal h2 { margin: 0; font-weight: 900; }
.modal h3 { margin: 0; font-size: var(--font-size-body); font-weight: 800; }
.grid { display: grid; gap: var(--space-3); }
.grid label, .mapping label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); min-width: 0; overflow-wrap: anywhere; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.file { margin: 0; overflow-wrap: anywhere; }
.group { border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); display: grid; gap: var(--space-2); margin: 0; min-width: 0; }
.group legend { font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: 0 var(--space-1); }
.mapping { display: grid; gap: var(--space-2); grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
.check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); font-size: var(--font-size-body-s); }
.table td.wrap { overflow-wrap: anywhere; min-width: 6em; }
.table .sub { display: block; }
.msg { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.msg.err { color: var(--color-coral-ink); font-weight: 700; }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
.actions.start { justify-content: flex-start; }
</style>

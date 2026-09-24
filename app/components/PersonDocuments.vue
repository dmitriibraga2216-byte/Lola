<script setup lang="ts">
import { PERSON_DOCUMENT_LIMITS } from '#shared/enums'
import type { PersonDocumentStatus } from '#shared/enums'
import { addMonths, daysBetween, documentFileAllowed } from '#shared/domain/personRecords'

/**
 * Блок «Документи (N)» карточки человека (docs/v2/38-people-extensions.md §5.1, §6.2, §7.7, §7.8).
 *
 * Таблица документов, строки-заглушки «Відсутній» для обязательных типов без документа (иначе
 * отсутствие невидимо) и форма «Додати документ». Для типа «лише факт» поля файла нет вовсе —
 * вместо него плашка (§6.2); файл к такому типу сервер всё равно отвергнет. Права — с сервера:
 * `types` (что можно добавить этому человеку), `can.edit`, `can.delete`.
 */
const props = defineProps<{ personId: string, autoOpen?: boolean }>()

interface Doc {
  id: string
  typeId: string
  type: { code: string, name: string, isFactOnly: boolean, isRequired: boolean }
  title: string | null
  numberMasked: string | null
  issuedAt: string | null
  expiresAt: string | null
  status: PersonDocumentStatus
  uploadedBy: { id: string, name: string } | null
  selfUploaded: boolean
  note: string | null
  revokeReason: string | null
  replacedBy: { id: string, issuedAt: string | null } | null
  file: { mime: string, name: string, bytes: number } | null
  can: { edit: boolean, delete: boolean }
}
interface TypeOption { id: string, code: string, name: string, isFactOnly: boolean, validityMonths: number | null, isRequired: boolean }

const { t, te } = useI18n()
const { api, apiRaw } = useApi()
const { hasScope } = useAuth()
const { upload } = useMediaUpload()
const { formatShortDate } = useFormat()

const open = ref(false)
const items = ref<Doc[]>([])
const missing = ref<{ typeId: string, code: string, name: string }[]>([])
const types = ref<TypeOption[]>([])
const total = ref<number | null>(null)
const loading = ref(false)
const loadFailed = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const showRevoked = ref(false)

const adding = ref(false)
const form = reactive({ typeId: '', title: '', number: '', issuedAt: '', expiresAt: '', note: '' })
const file = ref<File | null>(null)
const formErrors = reactive({ typeId: '', file: '', issuedAt: '', expiresAt: '', number: '' })
const editing = ref<{ id: string, mode: 'extend' | 'revoke', expiresAt: string, reason: string } | null>(null)

const active = computed(() => items.value.filter(d => d.status !== 'revoked'))
const revoked = computed(() => items.value.filter(d => d.status === 'revoked'))
const selectedType = computed(() => types.value.find(x => x.id === form.typeId) ?? null)
/** Сегодня по часам устройства — для подсказки в форме; окончательную проверку делает сервер по поясу тенанта. */
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fmt = (d: string | null) => d ? formatShortDate(d) : '—'
const statusClass: Record<PersonDocumentStatus, string> = { valid: 'teal', expiring: 'sun', expired: 'coral', revoked: 'muted' }
const errText = (err: unknown) => {
  const e = apiErrorOf(err)
  return te(`personDocs.err.${e.code}`) ? t(`personDocs.err.${e.code}`) : e.message
}

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const r = await api<{ items: Doc[], missing: typeof missing.value, total: number, types: TypeOption[] }>(`/people/${props.personId}/documents`)
    items.value = r.items
    missing.value = r.missing
    total.value = r.total
    types.value = r.types
  }
  catch { loadFailed.value = true }
  finally { loading.value = false }
}

async function toggle() {
  open.value = !open.value
  if (open.value) await load()
}

onMounted(async () => {
  if (props.autoOpen) open.value = true
  await load()
})

function startAdd(typeId = '') {
  Object.assign(form, { typeId, title: '', number: '', issuedAt: '', expiresAt: '', note: '' })
  Object.assign(formErrors, { typeId: '', file: '', issuedAt: '', expiresAt: '', number: '' })
  file.value = null
  error.value = ''
  notice.value = ''
  adding.value = true
}

/** «Дійсний до» подставляется из срока типа (§6.2), человек его правит. */
watch(() => [form.typeId, form.issuedAt] as const, ([, issued]) => {
  const tp = selectedType.value
  if (tp?.validityMonths && issued && !form.expiresAt) form.expiresAt = addMonths(issued, tp.validityMonths)
  if (tp?.isFactOnly) file.value = null
})

function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  file.value = f
  formErrors.file = f && !documentFileAllowed(f.type, f.size) ? t('personDocs.fileInvalid') : ''
}

function validate(): boolean {
  const tp = selectedType.value
  formErrors.typeId = tp ? '' : t('personDocs.chooseType')
  formErrors.file = !tp || tp.isFactOnly ? '' : !file.value ? t('personDocs.fileRequired') : documentFileAllowed(file.value.type, file.value.size) ? '' : t('personDocs.fileInvalid')
  formErrors.issuedAt = !form.issuedAt ? t('personDocs.issuedRequired') : daysBetween(today(), form.issuedAt) > 0 ? t('personDocs.issuedFuture') : ''
  formErrors.expiresAt = tp?.validityMonths && !form.expiresAt
    ? t('personDocs.expiresRequired')
    : form.expiresAt && form.issuedAt && daysBetween(form.issuedAt, form.expiresAt) <= 0 ? t('personDocs.expiresBefore') : ''
  formErrors.number = form.number.length > PERSON_DOCUMENT_LIMITS.numberMax ? t('personDocs.numberTooLong') : ''
  return !Object.values(formErrors).some(Boolean)
}

async function submit() {
  if (!validate()) return
  busy.value = true
  error.value = ''
  try {
    const tp = selectedType.value!
    const mediaId = !tp.isFactOnly && file.value ? await upload(file.value, file.value.name, 'person_document') : null
    const res = await apiRaw<{ data: Doc, meta: { warnings: string[] } }>(`/people/${props.personId}/documents`, {
      method: 'POST',
      body: { typeId: tp.id, mediaId, title: form.title || null, number: form.number || null, issuedAt: form.issuedAt, expiresAt: form.expiresAt || null, note: form.note || null },
    })
    notice.value = res.meta.warnings.includes('already_expired') ? t('personDocs.alreadyExpired') : t('personDocs.saved')
    adding.value = false
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}

/** Файл — только через документ и его права; `?redirect=1` отдаёт 302 на подписанную ссылку. */
const fileUrl = (d: Doc) => `/api/v1/people/${props.personId}/documents/${d.id}/file?redirect=1`

async function saveEdit() {
  const e = editing.value
  if (!e) return
  busy.value = true
  error.value = ''
  try {
    const body = e.mode === 'revoke' ? { status: 'revoked', reason: e.reason } : { expiresAt: e.expiresAt || null }
    await api(`/people/${props.personId}/documents/${e.id}`, { method: 'PATCH', body })
    editing.value = null
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}

async function remove(d: Doc) {
  if (!confirm(t('personDocs.deleteConfirm'))) return
  busy.value = true
  error.value = ''
  try {
    await api(`/people/${props.personId}/documents/${d.id}`, { method: 'DELETE' })
    await load()
  }
  catch (err) { error.value = errText(err) }
  finally { busy.value = false }
}

const canAddType = (typeId: string) => types.value.some(x => x.id === typeId)
const revokedNote = (d: Doc) => d.replacedBy
  ? (d.replacedBy.issuedAt ? t('personDocs.replacedBy', { date: fmt(d.replacedBy.issuedAt) }) : t('personDocs.replaced'))
  : d.revokeReason ? t('personDocs.revokedReason', { reason: d.revokeReason }) : ''
</script>

<template>
  <section class="docs card" :aria-busy="loading">
    <button type="button" class="head" :aria-expanded="open" aria-controls="person-docs-body" @click="toggle">
      <span class="panel-title">{{ t('personDocs.title', { n: total ?? '…' }) }}</span>
      <span class="chevron" aria-hidden="true">{{ open ? '−' : '+' }}</span>
    </button>

    <div v-if="open" id="person-docs-body" class="body">
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
      <p v-if="loadFailed" class="error-text">
        {{ t('personDocs.loadError') }}
        <button type="button" class="btn ghost small" @click="load">{{ t('personDocs.retry') }}</button>
      </p>
      <p v-else-if="!loading && !active.length && !missing.length" class="muted">{{ t('personDocs.empty') }}</p>

      <div v-if="active.length || missing.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">{{ t('personDocs.col.type') }}</th>
              <th scope="col">{{ t('personDocs.col.title') }}</th>
              <th scope="col">{{ t('personDocs.col.issued') }}</th>
              <th scope="col">{{ t('personDocs.col.expires') }}</th>
              <th scope="col">{{ t('personDocs.col.status') }}</th>
              <th scope="col">{{ t('personDocs.col.uploadedBy') }}</th>
              <th scope="col"><span class="sr-only">{{ t('personDocs.col.actions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="d in active" :key="d.id">
              <tr>
                <td>{{ d.type.name }}<span v-if="d.numberMasked" class="sub">{{ d.numberMasked }}</span></td>
                <td>
                  {{ d.title || '—' }}
                  <span v-if="d.type.isFactOnly" class="sub">{{ t('personDocs.factRecorded') }}</span>
                  <a v-else-if="d.file" :href="fileUrl(d)" target="_blank" rel="noopener" class="linkish">{{ t('personDocs.openFile') }}</a>
                </td>
                <td>{{ fmt(d.issuedAt) }}</td>
                <td>{{ fmt(d.expiresAt) }}</td>
                <td><span :class="['badge', statusClass[d.status]]">{{ t(`personDocs.status.${d.status}`) }}</span></td>
                <td>{{ d.uploadedBy?.name || '—' }}<span v-if="d.selfUploaded" class="sub">{{ t('personDocs.selfUploaded') }}</span></td>
                <td class="actions">
                  <button v-if="d.can.edit" type="button" class="btn ghost small" @click="editing = { id: d.id, mode: 'extend', expiresAt: d.expiresAt ?? '', reason: '' }">{{ t('personDocs.extend') }}</button>
                  <button v-if="d.can.edit" type="button" class="btn ghost small" @click="editing = { id: d.id, mode: 'revoke', expiresAt: '', reason: '' }">{{ t('personDocs.revoke') }}</button>
                  <button v-if="d.can.delete" type="button" class="btn ghost small" :disabled="busy" @click="remove(d)">{{ t('personDocs.delete') }}</button>
                </td>
              </tr>
              <tr v-if="editing?.id === d.id">
                <td colspan="7">
                  <form class="inline" @submit.prevent="saveEdit">
                    <label v-if="editing.mode === 'extend'" class="label">{{ t('personDocs.expires') }}
                      <input v-model="editing.expiresAt" type="date" class="field">
                    </label>
                    <label v-else class="label grow">{{ t('personDocs.revokeReason') }}
                      <input v-model="editing.reason" class="field" maxlength="300">
                      <span class="help">{{ t('personDocs.revokeHint') }}</span>
                    </label>
                    <button type="submit" :class="['btn', 'small', editing.mode === 'revoke' ? 'danger' : 'primary']" :disabled="busy || (editing.mode === 'revoke' && editing.reason.trim().length < PERSON_DOCUMENT_LIMITS.reasonMin)">
                      {{ editing.mode === 'revoke' ? t('personDocs.revoke') : t('personDocs.save') }}
                    </button>
                    <button type="button" class="btn ghost small" @click="editing = null">{{ t('personDocs.cancel') }}</button>
                  </form>
                </td>
              </tr>
            </template>
            <tr v-for="m in missing" :key="`missing-${m.typeId}`" class="missing">
              <td>{{ m.name }}</td>
              <td>—</td>
              <td>—</td>
              <td>—</td>
              <td><span class="badge coral">{{ t('personDocs.status.missing') }}</span></td>
              <td>—</td>
              <td class="actions">
                <button v-if="canAddType(m.typeId)" type="button" class="btn primary small" @click="startAdd(m.typeId)">{{ t('personDocs.upload') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="revoked.length">
        <button type="button" class="btn ghost small" :aria-expanded="showRevoked" @click="showRevoked = !showRevoked">
          {{ showRevoked ? t('personDocs.hideRevoked') : t('personDocs.showRevoked', { n: revoked.length }) }}
        </button>
        <ul v-if="showRevoked" class="revoked">
          <li v-for="d in revoked" :key="d.id">
            <b>{{ d.type.name }}</b> · {{ fmt(d.issuedAt) }} — {{ fmt(d.expiresAt) }}
            <span class="badge muted">{{ t('personDocs.status.revoked') }}</span>
            <span class="faint">{{ revokedNote(d) }}</span>
            <a v-if="d.file" :href="fileUrl(d)" target="_blank" rel="noopener" class="linkish">{{ t('personDocs.openFile') }}</a>
          </li>
        </ul>
      </div>

      <div class="row">
        <button v-if="types.length && !adding" type="button" class="btn primary" @click="startAdd()">{{ t('personDocs.add') }}</button>
        <NuxtLink v-if="hasScope('person.document.manage')" to="/admin/people/document-types" class="link small">{{ t('personDocs.typesLink') }}</NuxtLink>
      </div>

      <form v-if="adding" class="add" novalidate @submit.prevent="submit">
        <h3 class="panel-title">{{ t('personDocs.add') }}</h3>
        <label class="label" for="doc-type">{{ t('personDocs.type') }}</label>
        <select id="doc-type" v-model="form.typeId" class="field" :aria-invalid="!!formErrors.typeId">
          <option value="" disabled>{{ t('personDocs.chooseType') }}</option>
          <option v-for="tp in types" :key="tp.id" :value="tp.id">{{ tp.name }}</option>
        </select>
        <p v-if="formErrors.typeId" class="error-text small">{{ formErrors.typeId }}</p>

        <p v-if="selectedType?.isFactOnly" class="note sun">{{ t('personDocs.factOnlyPlaque') }}</p>
        <template v-else-if="selectedType">
          <label class="label" for="doc-file">{{ t('personDocs.file') }}</label>
          <input id="doc-file" type="file" class="field" accept="application/pdf,image/jpeg,image/png" aria-describedby="doc-file-hint" @change="onFile">
          <p id="doc-file-hint" class="help">{{ t('personDocs.fileHint') }}</p>
          <p v-if="formErrors.file" class="error-text small">{{ formErrors.file }}</p>
        </template>

        <div class="grid">
          <label class="label">{{ t('personDocs.name') }}
            <input v-model="form.title" class="field" :maxlength="PERSON_DOCUMENT_LIMITS.titleMax">
          </label>
          <label class="label">{{ t('personDocs.number') }}
            <input v-model="form.number" class="field" autocomplete="off" aria-describedby="doc-number-hint">
            <span id="doc-number-hint" class="help">{{ t('personDocs.numberHint') }}</span>
            <span v-if="formErrors.number" class="error-text small">{{ formErrors.number }}</span>
          </label>
          <label class="label">{{ t('personDocs.issued') }}
            <input v-model="form.issuedAt" type="date" class="field" :max="today()" :aria-invalid="!!formErrors.issuedAt">
            <span v-if="formErrors.issuedAt" class="error-text small">{{ formErrors.issuedAt }}</span>
          </label>
          <label class="label">{{ t('personDocs.expires') }}
            <input v-model="form.expiresAt" type="date" class="field" :aria-invalid="!!formErrors.expiresAt">
            <span v-if="formErrors.expiresAt" class="error-text small">{{ formErrors.expiresAt }}</span>
          </label>
        </div>
        <label class="label">{{ t('personDocs.note') }}
          <input v-model="form.note" class="field" :maxlength="PERSON_DOCUMENT_LIMITS.noteMax">
        </label>
        <div class="row">
          <button type="submit" class="btn primary" :disabled="busy">{{ busy ? t('personDocs.uploading') : t('personDocs.save') }}</button>
          <button type="button" class="btn ghost" @click="adding = false">{{ t('personDocs.cancel') }}</button>
        </div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.docs { display: grid; gap: var(--space-3); }
.head { font: inherit; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); background: transparent; border: none; padding: 0; cursor: pointer; color: var(--color-ink); text-align: left; }
.head .panel-title { margin: 0; }
.head:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; border-radius: var(--radius-s); }
.chevron { font-weight: 900; font-size: var(--font-size-title-l); color: var(--color-ink-muted); }
.body { display: grid; gap: var(--space-3); min-width: 0; }
.actions { white-space: nowrap; }
.actions .btn + .btn { margin-left: var(--space-1); }
.missing td { color: var(--color-ink-muted); }
.linkish { font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-teal-ink); display: block; }
.linkish:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; }
.revoked { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: grid; gap: var(--space-2); font-size: var(--font-size-body-s); }
.revoked li { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; }
.inline { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: flex-end; }
.label { display: grid; gap: var(--space-1); }
.label.grow { flex: 1 1 220px; min-width: 0; }
.add { display: grid; gap: var(--space-2); border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-3); }
.add .panel-title { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-2); }
.small { font-size: var(--font-size-body-s); margin: 0; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

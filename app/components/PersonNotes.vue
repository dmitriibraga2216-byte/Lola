<script setup lang="ts">
import { PERSON_NOTE_CATEGORIES, PERSON_NOTE_LIMITS, PERSON_NOTE_VISIBILITIES } from '#shared/enums'
import type { PersonNoteCategory, PersonNoteVisibility } from '#shared/enums'

/**
 * Блок «Нотатки (N)» карточки человека (docs/v2/38-people-extensions.md §5.1, §6.1, §7.4–§7.6).
 *
 * Свёрнут, пока его не развернули: число в заголовке приходит отдельным запросом без чтения
 * содержания, а сам разворот — это `GET /people/:id/notes`, который пишет `person_note.read`
 * в журнал (§7.6). `autoOpen` — для вкладки, где открыть вкладку и значит развернуть.
 *
 * Что можно сделать с заметкой, решает сервер (`can.edit`, `can.delete`, `canCreate`);
 * экран только показывает. Скрин чувствительного содержания мягкий (§7.5): сервер отвечает
 * `note_sensitive_suspected` с признаками, форма показывает подтверждение и повторяет
 * запрос с `confirmSensitive`.
 */
const props = defineProps<{ personId: string, autoOpen?: boolean }>()

interface Note {
  id: string
  body: string
  category: PersonNoteCategory
  visibility: PersonNoteVisibility
  isPinned: boolean
  flagged: boolean
  sharedAt: string | null
  createdAt: string
  author: { id: string, name: string, archived: boolean } | null
  can: { edit: boolean, delete: boolean }
}

const { t, te } = useI18n()
const { api, apiRaw } = useApi()
const { me } = useAuth()
const { formatDateTime, formatShortDate } = useFormat()

const open = ref(false)
const total = ref<number | null>(null)
const canCreate = ref(false)
const items = ref<Note[]>([])
/** Курсор следующей страницы ленты (docs/04 §4.1); `null` — дальше заметок нет. */
const cursor = ref<string | null>(null)
const loadingMore = ref(false)
const loading = ref(false)
const loadFailed = ref(false)
const busy = ref(false)
const error = ref('')
const self = computed(() => me.value?.user.id === props.personId)

const form = reactive({ body: '', category: '' as PersonNoteCategory | '', visibility: 'manager' as PersonNoteVisibility, isPinned: false })
const formErrors = reactive({ body: '', category: '' })
const editing = ref<{ id: string, body: string, category: PersonNoteCategory, visibility: PersonNoteVisibility, isPinned: boolean, wasShared: boolean } | null>(null)
const deleting = ref<{ id: string, own: boolean, reason: string } | null>(null)
/** Подтверждение скрина (§6.1): признаки и повтор того же запроса с `confirmSensitive`. */
const sensitive = ref<{ signs: string[], retry: () => Promise<void> } | null>(null)

const errText = (err: unknown) => {
  const e = apiErrorOf(err)
  return te(`personNotes.err.${e.code}`) ? t(`personNotes.err.${e.code}`) : e.message
}

async function loadCount() {
  try {
    const r = await api<{ total: number, canCreate: boolean }>(`/people/${props.personId}/notes/count`)
    total.value = r.total
    canCreate.value = r.canCreate
  }
  catch { total.value = null }
}

type Page = { data: Note[], meta: { cursor: string | null, total: number, canCreate: boolean } }

/** Разворот секции — чтение заметок, сервер пишет его в журнал (§7.6). Первая страница. */
async function loadList() {
  loading.value = true
  loadFailed.value = false
  try {
    const r = await apiRaw<Page>(`/people/${props.personId}/notes`)
    items.value = r.data
    cursor.value = r.meta.cursor
    total.value = r.meta.total
    canCreate.value = r.meta.canCreate
  }
  catch { loadFailed.value = true }
  finally { loading.value = false }
}

/** «Показати ще» — следующая страница по курсору сервера; тоже чтение и тоже в журнал. */
async function loadMore() {
  if (!cursor.value) return
  loadingMore.value = true
  try {
    const r = await apiRaw<Page>(`/people/${props.personId}/notes`, { query: { cursor: cursor.value } })
    items.value = [...items.value, ...r.data]
    cursor.value = r.meta.cursor
    total.value = r.meta.total
  }
  catch (err) { error.value = errText(err) }
  finally { loadingMore.value = false }
}

async function toggle() {
  open.value = !open.value
  if (open.value) await loadList()
}

onMounted(async () => {
  if (props.autoOpen) {
    open.value = true
    await loadList()
  }
  else await loadCount()
})

/** Запрос с учётом мягкого скрина: при `note_sensitive_suspected` — подтверждение и повтор. */
async function send(run: (confirmSensitive: boolean) => Promise<unknown>, done: () => void) {
  error.value = ''
  busy.value = true
  try {
    await run(false)
    done()
    await loadList()
  }
  catch (err) {
    const e = apiErrorOf(err)
    if (e.code === 'note_sensitive_suspected') {
      sensitive.value = {
        signs: (e.details?.signs as string[] | undefined) ?? [],
        retry: async () => {
          sensitive.value = null
          busy.value = true
          try {
            await run(true)
            done()
            await loadList()
          }
          catch (err2) { error.value = errText(err2) }
          finally { busy.value = false }
        },
      }
    }
    else error.value = errText(err)
  }
  finally { busy.value = false }
}

function validate(): boolean {
  formErrors.category = form.category ? '' : t('personNotes.chooseCategory')
  const len = form.body.trim().length
  formErrors.body = len >= PERSON_NOTE_LIMITS.bodyMin && len <= PERSON_NOTE_LIMITS.bodyMax ? '' : t('personNotes.err.note_body_invalid')
  return !formErrors.category && !formErrors.body
}

function create() {
  if (!validate()) return
  const payload = { body: form.body, category: form.category, visibility: form.visibility, isPinned: form.isPinned }
  return send(
    confirmSensitive => api(`/people/${props.personId}/notes`, { method: 'POST', body: { ...payload, confirmSensitive } }),
    () => Object.assign(form, { body: '', category: '', visibility: 'manager', isPinned: false }),
  )
}

function startEdit(n: Note) {
  editing.value = { id: n.id, body: n.body, category: n.category, visibility: n.visibility, isPinned: n.isPinned, wasShared: n.visibility === 'shared_with_person' }
}

function saveEdit() {
  const e = editing.value
  if (!e) return
  const len = e.body.trim().length
  if (len < PERSON_NOTE_LIMITS.bodyMin || len > PERSON_NOTE_LIMITS.bodyMax) {
    error.value = t('personNotes.err.note_body_invalid')
    return
  }
  const cur = items.value.find(i => i.id === e.id)
  if (e.visibility === 'shared_with_person' && cur?.visibility !== 'shared_with_person' && !confirm(t('personNotes.shareConfirm'))) return
  return send(
    confirmSensitive => api(`/people/${props.personId}/notes/${e.id}`, { method: 'PATCH', body: { body: e.body, category: e.category, visibility: e.visibility, isPinned: e.isPinned, confirmSensitive } }),
    () => { editing.value = null },
  )
}

function share(n: Note) {
  if (!confirm(t('personNotes.shareConfirm'))) return
  return send(() => api(`/people/${props.personId}/notes/${n.id}`, { method: 'PATCH', body: { visibility: 'shared_with_person' } }), () => {})
}

function startDelete(n: Note) {
  // Своя и ещё правимая — без причины; всё остальное (чужая, заметка уволенного) удаляет только
  // администратор и с причиной (§7.5) — сервер это и проверяет, форма лишь не заставляет угадывать
  const own = n.author?.id === me.value?.user.id && n.can.edit
  if (own) {
    if (confirm(t('personNotes.deleteConfirm'))) return send(() => api(`/people/${props.personId}/notes/${n.id}`, { method: 'DELETE' }), () => {})
    return
  }
  deleting.value = { id: n.id, own, reason: '' }
}

function confirmDelete() {
  const d = deleting.value
  if (!d) return
  return send(() => api(`/people/${props.personId}/notes/${d.id}`, { method: 'DELETE', body: { reason: d.reason } }), () => { deleting.value = null })
}

const authorLabel = (n: Note) => !n.author ? t('personNotes.noAuthor') : n.author.archived ? t('personNotes.authorArchived', { name: n.author.name }) : n.author.name
const signsLabel = (signs: string[]) => signs.map(s => te(`personNotes.sign.${s}`) ? t(`personNotes.sign.${s}`) : s).join(', ')
const bodyLen = computed(() => form.body.trim().length)
</script>

<template>
  <section class="notes card" :aria-busy="loading">
    <button type="button" class="head" :aria-expanded="open" aria-controls="person-notes-body" @click="toggle">
      <span class="panel-title">{{ t('personNotes.title', { n: total ?? '…' }) }}</span>
      <span class="chevron" aria-hidden="true">{{ open ? '−' : '+' }}</span>
    </button>

    <div v-if="open" id="person-notes-body" class="body">
      <p class="note sun plaque">{{ self ? t('personNotes.selfHint') : t('personNotes.plaque') }}</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>

      <p v-if="loading" class="muted">…</p>
      <p v-else-if="loadFailed" class="error-text">
        {{ t('personNotes.loadError') }}
        <button type="button" class="btn ghost small" @click="loadList">{{ t('personNotes.retry') }}</button>
      </p>
      <p v-else-if="!items.length" class="muted">{{ t('personNotes.empty') }}</p>

      <ul v-else class="feed">
        <li v-for="n in items" :key="n.id" :class="['item', { pinned: n.isPinned }]">
          <template v-if="editing?.id === n.id">
            <label class="label" :for="`note-edit-${n.id}`">{{ t('personNotes.text') }}</label>
            <textarea :id="`note-edit-${n.id}`" v-model="editing.body" class="field" rows="3" :maxlength="PERSON_NOTE_LIMITS.bodyMax" />
            <div class="row">
              <label class="label inline">{{ t('personNotes.category') }}
                <select v-model="editing.category" class="field">
                  <option v-for="c in PERSON_NOTE_CATEGORIES" :key="c" :value="c">{{ t(`personNotes.cats.${c}`) }}</option>
                </select>
              </label>
              <label class="label inline">{{ t('personNotes.visibility') }}
                <select v-model="editing.visibility" class="field">
                  <!-- Открытое человеку назад не сужается (§4) — варианты просто недоступны -->
                  <option v-for="v in PERSON_NOTE_VISIBILITIES" :key="v" :value="v" :disabled="editing.wasShared && v !== 'shared_with_person'">{{ t(`personNotes.vis.${v}`) }}</option>
                </select>
              </label>
              <label class="toggle"><input v-model="editing.isPinned" type="checkbox"> {{ t('personNotes.pin') }}</label>
            </div>
            <div class="row">
              <button type="button" class="btn primary small" :disabled="busy" @click="saveEdit">{{ t('personNotes.save') }}</button>
              <button type="button" class="btn ghost small" @click="editing = null">{{ t('personNotes.cancel') }}</button>
            </div>
          </template>
          <template v-else>
            <div class="meta">
              <span class="author">{{ authorLabel(n) }}</span>
              <span class="faint">{{ formatDateTime(n.createdAt) }}</span>
              <span class="badge muted">{{ t(`personNotes.cats.${n.category}`) }}</span>
              <span :class="['badge', n.visibility === 'shared_with_person' ? 'teal' : 'muted']">{{ t(`personNotes.visShort.${n.visibility}`) }}</span>
              <span v-if="n.isPinned" class="badge sun">{{ t('personNotes.pinned') }}</span>
              <span v-if="n.flagged" class="badge coral">{{ t('personNotes.flagged') }}</span>
            </div>
            <p class="text">{{ n.body }}</p>
            <p v-if="n.sharedAt && !self" class="faint small">{{ t('personNotes.sharedAt', { date: formatShortDate(n.sharedAt) }) }}</p>
            <div v-if="n.can.edit || n.can.delete" class="row">
              <button v-if="n.can.edit" type="button" class="btn ghost small" @click="startEdit(n)">{{ t('personNotes.edit') }}</button>
              <button v-if="n.can.edit && n.visibility !== 'shared_with_person'" type="button" class="btn ghost small" :disabled="busy" @click="share(n)">{{ t('personNotes.share') }}</button>
              <button v-if="n.can.delete" type="button" class="btn ghost small" :disabled="busy" @click="startDelete(n)">{{ t('personNotes.delete') }}</button>
            </div>
            <div v-if="deleting?.id === n.id" class="row">
              <label class="label grow" :for="`note-del-${n.id}`">{{ t('personNotes.deleteReason') }}
                <input :id="`note-del-${n.id}`" v-model="deleting.reason" class="field" maxlength="300">
                <span class="help">{{ t('personNotes.deleteReasonHint') }}</span>
              </label>
              <button type="button" class="btn danger small" :disabled="busy || deleting.reason.trim().length < 5" @click="confirmDelete">{{ t('personNotes.delete') }}</button>
              <button type="button" class="btn ghost small" @click="deleting = null">{{ t('personNotes.cancel') }}</button>
            </div>
          </template>
        </li>
      </ul>

      <button v-if="cursor && !loading" type="button" class="btn ghost small more" :disabled="loadingMore" @click="loadMore">{{ t('personNotes.more') }}</button>

      <form v-if="canCreate" class="add" novalidate @submit.prevent="create">
        <h3 class="panel-title">{{ t('personNotes.add') }}</h3>
        <label class="label" for="note-category">{{ t('personNotes.category') }}</label>
        <select id="note-category" v-model="form.category" class="field" :aria-invalid="!!formErrors.category">
          <option value="" disabled>{{ t('personNotes.chooseCategory') }}</option>
          <option v-for="c in PERSON_NOTE_CATEGORIES" :key="c" :value="c">{{ t(`personNotes.cats.${c}`) }}</option>
        </select>
        <p v-if="formErrors.category" class="error-text small">{{ formErrors.category }}</p>

        <label class="label" for="note-body">{{ t('personNotes.text') }}</label>
        <textarea id="note-body" v-model="form.body" class="field" rows="4" :maxlength="PERSON_NOTE_LIMITS.bodyMax" :aria-invalid="!!formErrors.body" aria-describedby="note-body-hint" />
        <p class="help counter">{{ t('personNotes.counter', { n: bodyLen }) }}</p>
        <p id="note-body-hint" class="help">{{ t('personNotes.textHint') }}</p>
        <p v-if="formErrors.body" class="error-text small">{{ formErrors.body }}</p>

        <fieldset class="vis">
          <legend class="label">{{ t('personNotes.visibility') }}</legend>
          <label v-for="v in PERSON_NOTE_VISIBILITIES" :key="v" class="radio">
            <input v-model="form.visibility" type="radio" name="note-visibility" :value="v"> {{ t(`personNotes.vis.${v}`) }}
          </label>
        </fieldset>
        <label class="toggle"><input v-model="form.isPinned" type="checkbox"> {{ t('personNotes.pin') }}</label>
        <div class="row">
          <button type="submit" class="btn primary" :disabled="busy">{{ t('personNotes.add') }}</button>
        </div>
      </form>
    </div>

    <div v-if="sensitive" class="overlay" @click.self="sensitive = null">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="note-sensitive-title">
        <h3 id="note-sensitive-title" class="panel-title">{{ t('personNotes.sensitive.title') }}</h3>
        <p>{{ t('personNotes.sensitive.body', { signs: signsLabel(sensitive.signs) }) }}</p>
        <div class="row end">
          <button type="button" class="btn ghost" @click="sensitive = null">{{ t('personNotes.sensitive.change') }}</button>
          <button type="button" class="btn primary" :disabled="busy" @click="sensitive.retry()">{{ t('personNotes.sensitive.saveAnyway') }}</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.notes { display: grid; gap: var(--space-3); }
.head { font: inherit; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); background: transparent; border: none; padding: 0; cursor: pointer; color: var(--color-ink); text-align: left; }
.head .panel-title { margin: 0; }
.head:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; border-radius: var(--radius-s); }
.chevron { font-weight: 900; font-size: var(--font-size-title-l); color: var(--color-ink-muted); }
.body { display: grid; gap: var(--space-3); }
.plaque { margin: 0; }
.feed { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.item { background: var(--color-bg); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-s); padding: var(--space-3); display: grid; gap: var(--space-2); min-width: 0; }
.item.pinned { border-color: var(--color-sun); }
.meta { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.author { font-weight: 800; }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.row { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: flex-end; }
.row.end { justify-content: flex-end; }
.label.inline { display: grid; gap: var(--space-1); }
.label.grow { flex: 1 1 200px; display: grid; gap: var(--space-1); min-width: 0; }
.add { display: grid; gap: var(--space-2); border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-3); }
.add .panel-title { margin: 0; }
.counter { text-align: right; margin: 0; }
.vis { border: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
.vis legend { width: 100%; }
.radio { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; }
.small { font-size: var(--font-size-body-s); margin: 0; }
.more { justify-self: start; }
.overlay { position: fixed; inset: 0; background: rgb(12 15 20 / 50%); display: grid; place-items: center; padding: var(--space-3); z-index: 60; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(440px, 100%); box-sizing: border-box; }
.modal p { margin: 0; }
</style>

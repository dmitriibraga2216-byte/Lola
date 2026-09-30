<script setup lang="ts">
/**
 * Карточка модуля библиотеки — `/admin/library/:id` (docs/v2/31 §5.2, §5.3, §5.5, §6.1–§6.3);
 * `/admin/library/new` — создание черновика.
 *
 * Шапка: иконка типа, название, статус, «v4», «Зберегти», «Опублікувати версію», меню «…»
 * (Дублювати, Архівувати / Відновити, Видалити). Вкладки: «Вміст» — форма §6.1 и блочный
 * редактор `11` §5.2 с плашкой «використовується у N місцях»; «Версії» — changelog, критичне
 * виправлення, місць на версії, «Порівняти з vN»; «Де використовується» — активні місця,
 * «Оновити все до vN» (`library.manage`), згорнуті «Відключені раніше». Права — сервер (`canEdit`,
 * скоупи); екран лише ховає кнопки, яких людині не можна.
 */
import type { ContentBlock } from '#shared/schemas/content'
import type { LibraryTypeIcon } from '#shared/domain/library'
import { compactBody } from '#shared/domain/contentBlocks'
import type { LibraryCompare } from '~/components/LibraryDiff.vue'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'library.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()
const { upload } = useMediaUpload()
const route = useRoute()
const isNew = route.params.id === 'new'
const id = String(route.params.id)

const KINDS = ['article', 'file', 'video', 'link'] as const
type Kind = typeof KINDS[number]
type Tab = 'content' | 'versions' | 'usages'

interface VersionRef { id: string, version: number, publishedAt: string, changelog: string, isHotfix: boolean }
interface Detail {
  id: string
  title: string
  contentKind: Kind
  categoryId: string | null
  tags: string[]
  language: 'uk' | 'en'
  summary: string | null
  estimatedMinutes: number | null
  ownerName: string | null
  authors: { id: string, fullName: string }[]
  status: 'draft' | 'published' | 'archived'
  typeIcon: LibraryTypeIcon
  usageCount: number
  staleUsages: number
  currentVersion: VersionRef | null
  archiveReason: string | null
  draft: { kind: string, body: ContentBlock[], mediaId: string | null, externalUrl: string | null } | null
  hasUnpublishedChanges: boolean
  canEdit: boolean
}
interface VersionRow extends VersionRef { status: string, publishedBy: { fullName: string } | null, activeUsages: number }
interface Usage {
  id: string
  holderType: string
  holderTitle: string | null
  containerType: 'trajectory' | 'course'
  containerId: string
  containerTitle: string
  version: number
  latestVersion: number | null
  isStale: boolean
  attachedBy: { fullName: string }
  attachedAt: string
  detachedAt: string | null
}
interface UsageBrief { id: string, holderTitle: string | null, containerType: 'trajectory' | 'course', containerId: string, containerTitle: string }

const tab = ref<Tab>((['content', 'versions', 'usages'] as const).includes(route.query.tab as Tab) ? route.query.tab as Tab : 'content')
const mod = ref<Detail | null>(null)
const versions = ref<VersionRow[]>([])
const usages = ref<{ active: Usage[], detached: Usage[] }>({ active: [], detached: [] })
const categories = ref<{ id: string, name: string }[]>([])
const loadError = ref('')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const uploading = ref('')

const form = reactive({
  title: '',
  contentKind: 'article' as Kind,
  categoryId: '',
  tags: '',
  summary: '',
  language: 'uk' as 'uk' | 'en',
  estimatedMinutes: null as number | null,
  body: [] as ContentBlock[],
  mediaId: null as string | null,
  externalUrl: '',
})

const editable = computed(() => isNew ? hasScope('library.publish') : !!mod.value?.canEdit && mod.value.status !== 'archived')
const latest = computed(() => mod.value?.currentVersion?.version ?? null)

function fill(d: Detail) {
  mod.value = d
  form.title = d.title
  form.contentKind = d.contentKind
  form.categoryId = d.categoryId ?? ''
  form.tags = d.tags.join(', ')
  form.summary = d.summary ?? ''
  form.language = d.language
  form.estimatedMinutes = d.estimatedMinutes
  form.body = JSON.parse(JSON.stringify(d.draft?.body ?? []))
  form.mediaId = d.draft?.mediaId ?? null
  form.externalUrl = d.draft?.externalUrl ?? ''
}

async function loadAll() {
  loadError.value = ''
  try {
    categories.value = await api<{ id: string, name: string }[]>('/course-categories').catch(() => [])
    if (isNew) return
    const [d, v, u] = await Promise.all([
      api<Detail>(`/library/modules/${id}`),
      api<VersionRow[]>(`/library/modules/${id}/versions`),
      api<{ active: Usage[], detached: Usage[] }>(`/library/modules/${id}/usages`, { query: { includeDetached: 'true' } }),
    ])
    fill(d)
    versions.value = v
    usages.value = u
  }
  catch (err) {
    loadError.value = apiErrorOf(err).message || t('library.card.loadError')
  }
}
onMounted(loadAll)
watch(tab, v => navigateTo({ query: { ...route.query, tab: v === 'content' ? undefined : v } }, { replace: true }))

// ── Вміст: збереження чернетки (§6.1) ────────────────────────────────────────────────

function payload() {
  return {
    title: form.title.trim(),
    contentKind: form.contentKind,
    categoryId: form.categoryId || null,
    tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
    summary: form.summary.trim() || null,
    language: form.language,
    estimatedMinutes: form.estimatedMinutes || null,
    body: form.contentKind === 'article' ? compactBody(form.body) : [],
    mediaId: form.contentKind === 'file' || form.contentKind === 'video' ? form.mediaId : null,
    externalUrl: form.contentKind === 'link' ? (form.externalUrl.trim() || null) : null,
  }
}

/** Текст ошибки: первая проблема формы (§6.1 — тексты с сервера) или сообщение ответа. */
function messageOf(err: unknown): string {
  const e = apiErrorOf(err) as { message: string, details?: { issues?: { message: string }[] } }
  return e.details?.issues?.[0]?.message ?? e.message
}

async function save(): Promise<boolean> {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    if (isNew) {
      const created = await api<{ id: string }>('/library/modules', { method: 'POST', body: payload() })
      await navigateTo(`/admin/library/${created.id}`, { replace: true })
      return true
    }
    fill(await api<Detail>(`/library/modules/${id}`, { method: 'PATCH', body: payload() }))
    notice.value = t('common.saved')
    return true
  }
  catch (err) {
    error.value = messageOf(err)
    return false
  }
  finally { busy.value = false }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = t('resource.uploading')
  error.value = ''
  try {
    form.mediaId = await upload(file, file.name, 'lesson_attachment', {})
    uploading.value = t('resource.uploadDone')
  }
  catch (err) {
    uploading.value = ''
    error.value = apiErrorOf(err).message
  }
  finally { input.value = '' }
}

// ── Публікація версії (§6.2) ─────────────────────────────────────────────────────────

const publishDlg = reactive({ open: false, changelog: '', isHotfix: false, notify: true, error: '' })
function openPublish() {
  Object.assign(publishDlg, { open: true, changelog: '', isHotfix: false, notify: true, error: '' })
}
async function publish() {
  const text = publishDlg.changelog.trim()
  if (text.length < 5 || text.length > 500) {
    publishDlg.error = t('library.card.changelogHint')
    return
  }
  if (!(await save())) {
    publishDlg.open = false
    return
  }
  busy.value = true
  publishDlg.error = ''
  try {
    const r = await api<{ version: { version: number } }>(`/library/modules/${id}/versions`, {
      method: 'POST',
      body: { changelog: text, isHotfix: publishDlg.isHotfix, notify: publishDlg.notify, ...(latest.value ? { expectedVersion: latest.value } : {}) },
    })
    publishDlg.open = false
    await loadAll()
    notice.value = t('library.card.published', { v: r.version?.version ?? latest.value ?? 1 })
  }
  catch (err) {
    publishDlg.error = messageOf(err)
  }
  finally { busy.value = false }
}

// ── Меню «…»: дублювати, архівувати, відновити, видалити (§5.5, §6.3) ────────────────

const menuOpen = ref(false)

async function duplicate() {
  menuOpen.value = false
  error.value = ''
  try {
    const r = await api<{ id: string }>(`/library/modules/${id}/duplicate`, { method: 'POST', body: {} })
    await navigateTo(`/admin/library/${r.id}`)
  }
  catch (err) { error.value = messageOf(err) }
}

const archiveDlg = reactive({ open: false, reason: '', error: '' })
function openArchive() {
  menuOpen.value = false
  deleteDlg.open = false
  Object.assign(archiveDlg, { open: true, reason: '', error: '' })
}
async function archive() {
  const reason = archiveDlg.reason.trim()
  if (reason.length < 5) {
    archiveDlg.error = t('library.card.reasonHint')
    return
  }
  busy.value = true
  try {
    fill(await api<Detail>(`/library/modules/${id}/archive`, { method: 'POST', body: { reason } }))
    archiveDlg.open = false
    notice.value = t('library.card.archived')
  }
  catch (err) { archiveDlg.error = messageOf(err) }
  finally { busy.value = false }
}

async function restore() {
  menuOpen.value = false
  error.value = ''
  try {
    fill(await api<Detail>(`/library/modules/${id}/restore`, { method: 'POST' }))
    notice.value = t('library.card.restored')
  }
  catch (err) { error.value = messageOf(err) }
}

/** «Модуль використовується» — список місць і пропозиція заархівувати; при нулі — підтвердження. */
const deleteDlg = reactive({ open: false, inUse: false, message: '', usages: [] as UsageBrief[], total: 0, error: '' })
function openDelete() {
  menuOpen.value = false
  const active = usages.value.active
  Object.assign(deleteDlg, { open: true, inUse: active.length > 0, message: '', usages: active, total: active.length, error: '' })
}
async function remove() {
  busy.value = true
  deleteDlg.error = ''
  try {
    await api(`/library/modules/${id}`, { method: 'DELETE' })
    await navigateTo('/admin/library')
  }
  catch (err) {
    const e = apiErrorOf(err) as { code?: string, message: string, details?: { usages?: UsageBrief[], total?: number } }
    if (e.code === 'library_module.in_use') Object.assign(deleteDlg, { inUse: true, message: e.message, usages: e.details?.usages ?? [], total: e.details?.total ?? 0 })
    else deleteDlg.error = e.message
  }
  finally { busy.value = false }
}
function showUsages() {
  deleteDlg.open = false
  tab.value = 'usages'
}

// ── Версії: порівняння (§5.2) ────────────────────────────────────────────────────────

const compareDlg = reactive({ open: false, from: 0, to: 0, data: null as LibraryCompare | null, error: '' })
async function compare(from: number, to: number) {
  Object.assign(compareDlg, { open: true, from, to, data: null, error: '' })
  try { compareDlg.data = await api<LibraryCompare>(`/library/modules/${id}/versions/${from}/diff/${to}`) }
  catch (err) { compareDlg.error = messageOf(err) }
}

// ── Де використовується: оновлення (§5.3, §5.5) ──────────────────────────────────────

const updatingUsage = ref<string | null>(null)
const canUpdate = (u: Usage) => u.isStale && (u.containerType === 'course' ? hasScope('course.edit') : hasScope('program.manage')) && hasScope('library.use')
async function onUpdated(v: number) {
  updatingUsage.value = null
  notice.value = t('library.node.updated', { v })
  await loadAll()
}

const staleCount = computed(() => usages.value.active.filter(u => u.latestVersion !== null && u.version < u.latestVersion).length)
const updateAllDlg = ref(false)
async function updateAll() {
  busy.value = true
  error.value = ''
  try {
    const r = await api<{ updated: number, skipped: unknown[], toVersion: number }>(`/library/modules/${id}/update-all-usages`, { method: 'POST', body: {} })
    updateAllDlg.value = false
    notice.value = r.skipped.length
      ? t('library.usages.updatedSkipped', { n: r.updated, v: r.toVersion, skipped: r.skipped.length })
      : t('library.usages.updatedAll', { n: r.updated, v: r.toVersion })
    await loadAll()
  }
  catch (err) {
    updateAllDlg.value = false
    error.value = messageOf(err)
  }
  finally { busy.value = false }
}

const containerLink = (u: { containerType: string, containerId: string }) => u.containerType === 'trajectory' ? `/admin/trajectories/${u.containerId}` : `/admin/courses/${u.containerId}`
const date = (v: string) => formatShortDate(new Date(v))
</script>

<template>
  <div>
    <PageHeader
      :title="isNew ? t('library.card.createTitle') : (mod?.title || t('library.list.title'))"
      :crumbs="[{ label: t('admin.section.content') }, { label: t('library.list.title'), to: '/admin/library' }]"
    >
      <template #actions>
        <button v-if="editable" type="button" class="btn ghost" :disabled="busy || form.title.trim().length < 3" @click="save">{{ isNew ? t('library.card.createDraft') : t('common.save') }}</button>
        <button v-if="!isNew && editable && hasScope('library.publish')" type="button" class="btn primary" :disabled="busy" @click="openPublish">{{ t('library.card.publish') }}</button>
        <div v-if="!isNew && mod && hasScope('library.publish')" class="menu">
          <button type="button" class="btn ghost" :aria-expanded="menuOpen" aria-haspopup="menu" :aria-label="t('library.card.more')" @click="menuOpen = !menuOpen">…</button>
          <div v-if="menuOpen" class="menu-list" role="menu" @keydown.esc="menuOpen = false">
            <button type="button" role="menuitem" @click="duplicate">{{ t('library.card.duplicate') }}</button>
            <button v-if="mod.status !== 'archived' && mod.canEdit" type="button" role="menuitem" @click="openArchive">{{ t('library.card.archive') }}</button>
            <button v-if="mod.status === 'archived' && hasScope('library.manage')" type="button" role="menuitem" @click="restore">{{ t('library.card.restore') }}</button>
            <button v-if="hasScope('library.manage')" type="button" role="menuitem" class="danger" @click="openDelete">{{ t('library.card.delete') }}</button>
          </div>
        </div>
      </template>
    </PageHeader>

    <p v-if="loadError" class="note coral" role="alert">
      {{ loadError }}
      <button type="button" class="btn ghost" @click="loadAll">{{ t('library.palette.retry') }}</button>
    </p>
    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div v-if="mod" class="head">
      <LibraryTypeIcon :icon="mod.typeIcon" />
      <span :class="['badge', mod.status]">{{ t(`library.status.${mod.status}`) }}</span>
      <span v-if="latest" class="badge">v{{ latest }}</span>
      <span v-if="mod.hasUnpublishedChanges && mod.status !== 'archived'" class="muted">{{ t('library.card.unpublished') }}</span>
      <span class="muted">{{ t('library.card.owner', { name: mod.ownerName ?? '—' }) }}</span>
    </div>
    <p v-if="mod?.status === 'archived'" class="note sun">{{ t('library.card.archivedNote', { reason: mod.archiveReason ?? '' }) }}</p>

    <div v-if="!isNew" class="chips tabs" role="tablist">
      <button v-for="k in (['content', 'versions', 'usages'] as const)" :key="k" type="button" role="tab" :aria-selected="tab === k" :class="['chip', { on: tab === k }]" @click="tab = k">
        {{ t(`library.card.tab.${k}`, { n: k === 'versions' ? versions.length : usages.active.length }) }}
      </button>
    </div>

    <!-- Вміст -->
    <section v-if="isNew || tab === 'content'" class="content">
      <p v-if="mod && mod.usageCount > 0" class="note sun">{{ t('library.card.usedBanner', { n: mod.usageCount }) }}</p>

      <label class="block">
        <span class="label">{{ t('library.form.title') }}</span>
        <input v-model="form.title" class="field" maxlength="200" minlength="3" required :disabled="!editable">
      </label>

      <fieldset class="block">
        <legend class="label">{{ t('library.form.kind') }}</legend>
        <div class="segmented" role="radiogroup">
          <label v-for="k in KINDS" :key="k" :class="{ on: form.contentKind === k }">
            <input v-model="form.contentKind" type="radio" name="kind" :value="k" :disabled="!editable" class="sr-only">{{ t(`resource.kind.${k}`) }}
          </label>
        </div>
      </fieldset>

      <div class="grid2">
        <label class="block">
          <span class="label">{{ t('library.form.category') }}</span>
          <select v-model="form.categoryId" class="field" :disabled="!editable">
            <option value="">—</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label class="block">
          <span class="label">{{ t('library.form.tags') }}</span>
          <input v-model="form.tags" class="field" :placeholder="t('library.form.tagsHint')" :disabled="!editable">
        </label>
        <label class="block">
          <span class="label">{{ t('library.form.language') }}</span>
          <select v-model="form.language" class="field" :disabled="!editable">
            <option value="uk">Українська</option>
            <option value="en">English</option>
          </select>
        </label>
        <label class="block">
          <span class="label">{{ t('library.form.minutes') }}</span>
          <input v-model.number="form.estimatedMinutes" class="field" type="number" min="1" max="600" :disabled="!editable">
        </label>
      </div>

      <label class="block">
        <span class="label">{{ t('library.form.summary') }}</span>
        <textarea v-model="form.summary" class="field" rows="2" maxlength="300" :disabled="!editable" />
      </label>

      <p v-if="mod" class="muted">{{ t('library.form.authors', { names: mod.authors.map(a => a.fullName).join(', ') || '—' }) }}</p>

      <div v-if="form.contentKind === 'article'" class="block">
        <span class="label">{{ t('library.form.body') }}</span>
        <BlockEditor v-if="editable" v-model="form.body" />
        <LessonBlocks v-else :blocks="form.body" :blocks-state="{}" readonly />
      </div>
      <label v-else-if="form.contentKind === 'link'" class="block">
        <span class="label">{{ t('resource.url') }}</span>
        <input v-model="form.externalUrl" class="field" type="url" placeholder="https://" :disabled="!editable">
      </label>
      <div v-else class="block">
        <span class="label">{{ t('resource.file') }}</span>
        <input type="file" class="field" :accept="form.contentKind === 'video' ? 'video/mp4,video/quicktime,video/webm' : '.pdf,.docx,.xlsx,.pptx,.csv,.txt,audio/mpeg,audio/mp4'" :disabled="!editable" @change="onFile">
        <p class="help">{{ uploading || (form.mediaId ? t('resource.uploadDone') : t('resource.fileHint')) }}</p>
      </div>
    </section>

    <!-- Версії -->
    <section v-else-if="tab === 'versions'">
      <p v-if="!versions.length" class="muted">{{ t('library.versions.empty') }}</p>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('library.versions.version') }}</th>
              <th>{{ t('library.versions.date') }}</th>
              <th>{{ t('library.versions.author') }}</th>
              <th>{{ t('library.versions.changelog') }}</th>
              <th class="num">{{ t('library.versions.places') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.id">
              <td>
                v{{ v.version }}
                <span v-if="v.isHotfix" class="badge coral">{{ t('library.update.hotfix') }}</span>
                <span v-if="v.status === 'retired'" class="badge archived">{{ t('library.versions.retired') }}</span>
              </td>
              <td>{{ date(v.publishedAt) }}</td>
              <td>{{ v.publishedBy?.fullName ?? '—' }}</td>
              <td class="wrap">{{ v.changelog }}</td>
              <td class="num">{{ v.activeUsages }}</td>
              <td>
                <button v-if="v.version > 1" type="button" class="btn ghost small" @click="compare(v.version - 1, v.version)">{{ t('library.versions.compare', { v: v.version - 1 }) }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Де використовується (§5.3) -->
    <section v-else-if="tab === 'usages'" class="usages">
      <div v-if="usages.active.length && latest && staleCount && hasScope('library.manage')" class="usage-actions">
        <button type="button" class="btn primary" @click="updateAllDlg = true">{{ t('library.usages.updateAll', { v: latest }) }}</button>
      </div>
      <p v-if="!usages.active.length" class="muted">{{ t('library.usages.empty') }}</p>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('library.usages.container') }}</th>
              <th>{{ t('library.usages.holder') }}</th>
              <th>{{ t('library.usages.version') }}</th>
              <th>{{ t('library.usages.attachedBy') }}</th>
              <th>{{ t('library.usages.attachedAt') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in usages.active" :key="u.id">
              <td><NuxtLink :to="containerLink(u)">{{ u.containerTitle }}</NuxtLink></td>
              <td>{{ u.holderTitle ?? '—' }}</td>
              <td :class="{ coral: u.latestVersion !== null && u.version < u.latestVersion }">
                {{ u.latestVersion !== null && u.version < u.latestVersion ? t('library.usages.staleVersion', { v: u.version }) : `v${u.version}` }}
              </td>
              <td>{{ u.attachedBy.fullName }}</td>
              <td>{{ date(u.attachedAt) }}</td>
              <td>
                <button v-if="canUpdate(u)" type="button" class="btn ghost small" @click="updatingUsage = u.id">{{ t('library.node.update') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <details v-if="usages.detached.length" class="detached">
        <summary>{{ t('library.usages.detached', { n: usages.detached.length }) }}</summary>
        <ul>
          <li v-for="u in usages.detached" :key="u.id">
            {{ u.containerTitle }} · {{ u.holderTitle ?? '—' }} · v{{ u.version }} · {{ t('library.usages.detachedAt', { date: date(u.detachedAt!) }) }}
          </li>
        </ul>
      </details>
    </section>

    <!-- Діалоги -->
    <div v-if="publishDlg.open" class="overlay" @click.self="publishDlg.open = false" @keydown.esc="publishDlg.open = false">
      <form class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lib-publish-title" @submit.prevent="publish">
        <h2 id="lib-publish-title" class="panel-title">{{ t('library.card.publishTitle', { v: (latest ?? 0) + 1 }) }}</h2>
        <label class="block">
          <span class="label">{{ t('library.card.changelog') }}</span>
          <textarea v-model="publishDlg.changelog" class="field" rows="3" maxlength="500" />
          <span class="help">{{ t('library.card.changelogHint') }}</span>
        </label>
        <label class="toggle"><input v-model="publishDlg.isHotfix" type="checkbox"> <span>{{ t('library.update.hotfix') }}<span class="help">{{ t('library.card.hotfixHint') }}</span></span></label>
        <label class="toggle"><input v-model="publishDlg.notify" type="checkbox"> <span>{{ t('library.card.notify') }}</span></label>
        <p v-if="publishDlg.error" class="error-text" role="alert">{{ publishDlg.error }}</p>
        <div class="actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('library.card.publish') }}</button>
          <button class="btn ghost" type="button" @click="publishDlg.open = false">{{ t('common.cancel') }}</button>
        </div>
      </form>
    </div>

    <div v-if="archiveDlg.open" class="overlay" @click.self="archiveDlg.open = false" @keydown.esc="archiveDlg.open = false">
      <form class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lib-archive-title" @submit.prevent="archive">
        <h2 id="lib-archive-title" class="panel-title">{{ t('library.card.archiveTitle') }}</h2>
        <p>{{ t('library.card.archiveText') }}</p>
        <label class="block">
          <span class="label">{{ t('library.card.reason') }}</span>
          <textarea v-model="archiveDlg.reason" class="field" rows="3" maxlength="500" />
        </label>
        <p v-if="archiveDlg.error" class="error-text" role="alert">{{ archiveDlg.error }}</p>
        <div class="actions">
          <button class="btn primary" type="submit" :disabled="busy">{{ t('library.card.archive') }}</button>
          <button class="btn ghost" type="button" @click="archiveDlg.open = false">{{ t('common.cancel') }}</button>
        </div>
      </form>
    </div>

    <div v-if="deleteDlg.open" class="overlay" @click.self="deleteDlg.open = false" @keydown.esc="deleteDlg.open = false">
      <section class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lib-delete-title">
        <template v-if="deleteDlg.inUse">
          <h2 id="lib-delete-title" class="panel-title">{{ t('library.card.inUseTitle') }}</h2>
          <p>{{ deleteDlg.message || t('library.card.inUseText', { n: deleteDlg.total }) }}</p>
          <ul v-if="deleteDlg.usages.length" class="places">
            <li v-for="u in deleteDlg.usages" :key="u.id"><NuxtLink :to="containerLink(u)">{{ u.containerTitle }}</NuxtLink> · {{ u.holderTitle ?? '—' }}</li>
          </ul>
          <div class="actions">
            <button v-if="mod?.status !== 'archived'" class="btn primary" type="button" @click="openArchive">{{ t('library.card.archive') }}</button>
            <button class="btn ghost" type="button" @click="showUsages">{{ t('library.card.openUsages') }}</button>
          </div>
        </template>
        <template v-else>
          <h2 id="lib-delete-title" class="panel-title">{{ t('library.card.deleteTitle') }}</h2>
          <p>{{ t('library.usages.empty') }}</p>
          <p v-if="deleteDlg.error" class="error-text" role="alert">{{ deleteDlg.error }}</p>
          <div class="actions">
            <button class="btn danger" type="button" :disabled="busy" @click="remove">{{ t('library.card.deleteForever') }}</button>
            <button class="btn ghost" type="button" @click="deleteDlg.open = false">{{ t('common.cancel') }}</button>
          </div>
        </template>
      </section>
    </div>

    <div v-if="compareDlg.open" class="overlay" @click.self="compareDlg.open = false" @keydown.esc="compareDlg.open = false">
      <section class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lib-compare-title">
        <h2 id="lib-compare-title" class="panel-title">{{ t('library.versions.compareTitle', { from: compareDlg.from, to: compareDlg.to }) }}</h2>
        <LibraryDiff v-if="compareDlg.data" :compare="compareDlg.data" />
        <p v-else-if="!compareDlg.error" class="muted">{{ t('common.loading') }}</p>
        <p v-if="compareDlg.error" class="error-text" role="alert">{{ compareDlg.error }}</p>
        <div class="actions">
          <button class="btn ghost" type="button" @click="compareDlg.open = false">{{ t('common.close') }}</button>
        </div>
      </section>
    </div>

    <div v-if="updateAllDlg" class="overlay" @click.self="updateAllDlg = false" @keydown.esc="updateAllDlg = false">
      <section class="dialog card" role="dialog" aria-modal="true" aria-labelledby="lib-update-all-title">
        <h2 id="lib-update-all-title" class="panel-title">{{ t('library.usages.updateAll', { v: latest }) }}</h2>
        <p>{{ t('library.usages.updateAllConfirm', { n: staleCount, v: latest }) }}</p>
        <div class="actions">
          <button class="btn primary" type="button" :disabled="busy" @click="updateAll">{{ t('library.update.confirm') }}</button>
          <button class="btn ghost" type="button" @click="updateAllDlg = false">{{ t('common.cancel') }}</button>
        </div>
      </section>
    </div>

    <LibraryUpdateDialog v-if="updatingUsage" :usage-id="updatingUsage" @close="updatingUsage = null" @done="onUpdated" />
  </div>
</template>

<style scoped>
.head { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-bottom: var(--space-3); }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 0 var(--space-2); white-space: nowrap; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); }
.badge.draft { background: var(--color-sun-soft); }
.badge.published { background: var(--color-teal-soft); }
.badge.archived { background: var(--color-bg-line); }
.badge.coral { background: var(--color-coral-soft); color: var(--color-coral-deep); }
.tabs { margin-bottom: var(--space-3); }
.content { display: grid; gap: var(--space-3); max-width: 880px; }
.block { display: grid; gap: var(--space-1); }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3); }
.label { font-size: var(--font-size-body-s); font-weight: 700; }
.help { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.wrap { overflow-wrap: anywhere; min-width: 200px; }
.coral { color: var(--color-coral-deep); font-weight: 700; }
.usages { display: grid; gap: var(--space-3); }
.usage-actions { display: flex; justify-content: flex-end; }
.detached summary { cursor: pointer; font-weight: 700; }
.detached ul, .places { margin: var(--space-2) 0 0; padding-left: var(--space-4); overflow-wrap: anywhere; }
.menu { position: relative; }
.menu-list { position: absolute; right: 0; top: 100%; z-index: 20; display: grid; min-width: 200px; background: var(--color-bg); border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1); }
.menu-list button { font: inherit; text-align: left; background: none; border: none; padding: var(--space-2) var(--space-3); border-radius: var(--radius-s); cursor: pointer; }
.menu-list button:hover, .menu-list button:focus-visible { background: var(--color-bg-soft); }
.menu-list .danger { color: var(--color-coral-deep); }
.toggle { display: flex; gap: var(--space-2); align-items: flex-start; }
.toggle .help { display: block; }
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.dialog { width: min(640px, 100%); box-sizing: border-box; display: grid; gap: var(--space-3); background: var(--color-bg-soft); max-height: calc(100vh - var(--space-6)); overflow: auto; }
.dialog .panel-title { margin: 0; }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>

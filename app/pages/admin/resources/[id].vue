<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
import { COVER_MIMES, RESOURCE_KINDS } from '#shared/schemas/resources'
const { formatShortDate } = useFormat()

/**
 * Форма ресурса по мокапу ResourceForm (docs/11 §14, §14.2, Г-11.3): тип, название, вміст,
 * «Дозволити друк», «Сповістити про оновлення»; справа — «Публікація» (статус, версія, оновлено),
 * «Доступ і категорії», «Обкладинки». Правил прохождения в форме нет (CLAUDE.md п. 11).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { upload } = useMediaUpload()
const route = useRoute()
const isNew = route.params.id === 'new'
const id = ref(isNew ? '' : String(route.params.id))

interface Resource {
  id: string
  title: string
  kind: string
  summary: string | null
  body: ContentBlock[]
  mediaId: string | null
  externalUrl: string | null
  categoryIds: string[]
  tags: string[]
  estimatedMinutes: number | null
  coverKey: string | null
  cardImageKey: string | null
  allowPrint: boolean
  status: string
  version: number
  publishedVersionId: string | null
  updatedAt: string
  accessGroupIds: string[]
  versions: { id: string, version: number, changelog: string | null, publishedAt: string }[]
  usedInCourses: number
  hasUnpublishedChanges: boolean
}
interface Category { id: string, name: string }
interface Group { id: string, name: string }

const form = reactive({
  title: '',
  kind: 'article' as typeof RESOURCE_KINDS[number],
  summary: '',
  body: [] as ContentBlock[],
  mediaId: null as string | null,
  externalUrl: '',
  categoryIds: [] as string[],
  tags: '',
  estimatedMinutes: null as number | null,
  coverKey: null as string | null,
  cardImageKey: null as string | null,
  allowPrint: true,
  accessGroupIds: [] as string[],
})
const notifyAssigned = ref(false)
const meta = ref<Resource | null>(null)
const categories = ref<Category[]>([])
const groups = ref<Group[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const uploading = ref('')
const mediaName = ref('')
const canEdit = computed(() => hasScope(isNew ? 'course.create' : 'course.edit'))
const coverAccept = COVER_MIMES.join(',')

function fill(r: Resource) {
  meta.value = r
  form.title = r.title
  form.kind = r.kind as typeof form.kind
  form.summary = r.summary ?? ''
  form.body = JSON.parse(JSON.stringify(r.body))
  form.mediaId = r.mediaId
  form.externalUrl = r.externalUrl ?? ''
  form.categoryIds = [...r.categoryIds]
  form.tags = r.tags.join(', ')
  form.estimatedMinutes = r.estimatedMinutes
  form.coverKey = r.coverKey
  form.cardImageKey = r.cardImageKey
  form.allowPrint = r.allowPrint
  form.accessGroupIds = [...r.accessGroupIds]
}

async function load() {
  try {
    const [cats, grs] = await Promise.all([
      api<Category[]>('/resource-categories').catch(() => []),
      api<Group[]>('/access-groups', { query: { appliesTo: 'knowledge' } }).catch(() => []),
    ])
    categories.value = cats
    groups.value = grs
    if (id.value) fill(await api<Resource>(`/resources/${id.value}`))
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

function payload() {
  return {
    title: form.title.trim(),
    kind: form.kind,
    summary: form.summary.trim() || null,
    body: form.body,
    mediaId: form.mediaId,
    externalUrl: form.externalUrl.trim() || null,
    categoryIds: form.categoryIds,
    tags: form.tags.split(',').map(s => s.trim()).filter(Boolean),
    estimatedMinutes: form.estimatedMinutes || null,
    coverKey: form.coverKey,
    cardImageKey: form.cardImageKey,
    allowPrint: form.allowPrint,
    accessGroupIds: form.accessGroupIds,
  }
}

/** Сохранение рабочей редакции; опубликованная версия не меняется до публикации (Г-11.3). */
async function save(): Promise<boolean> {
  busy.value = true
  error.value = ''
  try {
    if (id.value) {
      await api(`/resources/${id.value}`, { method: 'PATCH', body: payload() })
    }
    else {
      const r = await api<Resource>('/resources', { method: 'POST', body: payload() })
      id.value = r.id
      window.history.replaceState(null, '', `/admin/resources/${r.id}`)
    }
    fill(await api<Resource>(`/resources/${id.value}`))
    notice.value = t('common.saved')
    return true
  }
  catch (err) {
    error.value = apiErrorOf(err).message
    return false
  }
  finally {
    busy.value = false
  }
}

async function saveAndExit() {
  if (await save()) await navigateTo('/admin/resources')
}

async function publish() {
  if (!(await save())) return
  busy.value = true
  try {
    const r = await api<{ version: number, notified: number }>(`/resources/${id.value}/publish`, { method: 'POST', body: { notifyAssigned: notifyAssigned.value } })
    notice.value = notifyAssigned.value ? t('resource.publishedNotified', { v: r.version, n: r.notified }) : t('resource.published', { v: r.version })
    notifyAssigned.value = false
    fill(await api<Resource>(`/resources/${id.value}`))
  }
  catch (err) {
    const e = apiErrorOf(err) as { message: string, details?: { checks?: { code: string, ok: boolean }[] } }
    const failed = e.details?.checks?.filter(c => !c.ok).map(c => t(`resource.checks.${c.code}`)) ?? []
    error.value = failed.length ? `${e.message}: ${failed.join(', ')}` : e.message
  }
  finally {
    busy.value = false
  }
}

async function onFile(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = t('resource.uploading')
  error.value = ''
  try {
    form.mediaId = await upload(file, file.name, 'lesson_attachment', { resourceId: id.value || undefined, sourceEntity: 'resources', sourceId: id.value || undefined })
    mediaName.value = file.name
    uploading.value = t('resource.uploadDone')
  }
  catch (err) {
    uploading.value = ''
    error.value = apiErrorOf(err).message
  }
  finally {
    input.value = ''
  }
}

async function onCover(e: Event, field: 'coverKey' | 'cardImageKey') {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  error.value = ''
  try {
    form[field] = await upload(file, file.name, 'content_cover', { resourceId: id.value || undefined, sourceEntity: 'resources', sourceId: id.value || undefined })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    input.value = ''
  }
}

function toggle(list: string[], value: string) {
  const i = list.indexOf(value)
  if (i >= 0) list.splice(i, 1)
  else list.push(value)
}

async function setStatus(action: 'archive' | 'restore') {
  try {
    await api(`/resources/${id.value}/${action}`, { method: 'POST' })
    fill(await api<Resource>(`/resources/${id.value}`))
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function remove() {
  if (!meta.value || !confirm(t('resource.deleteConfirm', { title: meta.value.title }))) return
  try {
    await api(`/resources/${id.value}`, { method: 'DELETE' })
    await navigateTo('/admin/resources')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
</script>

<template>
  <div>
    <PageHeader :title="isNew ? t('resource.create') : (meta?.title || t('resource.edit'))" :crumbs="[{ label: t('admin.section.content') }, { label: t('resource.title'), to: '/admin/resources' }]">
      <template #actions>
        <NuxtLink to="/admin/resources" class="btn ghost">{{ t('resource.discard') }}</NuxtLink>
        <button v-if="canEdit" class="btn ghost" :disabled="busy || form.title.trim().length < 3" @click="saveAndExit">{{ t('resource.saveExit') }}</button>
        <button v-if="hasScope('course.publish')" class="btn primary" :disabled="busy || form.title.trim().length < 3 || meta?.status === 'archived'" @click="publish">{{ t('resource.publishBtn') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div class="split">
      <section class="main">
        <fieldset class="block">
          <legend class="label">{{ t('resource.kindLabel') }}</legend>
          <div class="segmented" role="radiogroup">
            <label v-for="k in RESOURCE_KINDS" :key="k" :class="{ on: form.kind === k }">
              <input v-model="form.kind" type="radio" name="kind" :value="k" :disabled="!canEdit" class="sr-only">{{ t(`resource.kind.${k}`) }}
            </label>
          </div>
        </fieldset>

        <label class="block">
          <span class="label">{{ t('resource.name') }}</span>
          <input v-model="form.title" class="field" maxlength="200" :disabled="!canEdit" required>
        </label>

        <div v-if="form.kind === 'article'" class="block">
          <span class="label">{{ t('resource.body') }}</span>
          <BlockEditor v-if="canEdit" v-model="form.body" />
          <LessonBlocks v-else :blocks="form.body" :blocks-state="{}" readonly />
        </div>
        <div v-else-if="form.kind === 'link'" class="block">
          <label>
            <span class="label">{{ t('resource.url') }}</span>
            <input v-model="form.externalUrl" class="field" type="url" placeholder="https://" :disabled="!canEdit">
          </label>
          <p class="help">{{ t('resource.urlHint') }}</p>
        </div>
        <div v-else class="block">
          <span class="label">{{ t('resource.file') }}</span>
          <input type="file" class="field" :accept="form.kind === 'video' ? 'video/mp4,video/quicktime,video/webm' : '.pdf,.docx,.xlsx,.pptx,.csv,.txt,audio/mpeg,audio/mp4'" :disabled="!canEdit" @change="onFile">
          <p class="help">{{ uploading || mediaName || (form.mediaId ? t('resource.uploadDone') : t('resource.fileHint')) }}</p>
        </div>

        <div class="block grid2">
          <label>
            <span class="label">{{ t('resource.summary') }}</span>
            <textarea v-model="form.summary" class="field" rows="2" maxlength="300" :disabled="!canEdit" />
          </label>
          <label>
            <span class="label">{{ t('resource.estimatedMinutes') }}</span>
            <input v-model.number="form.estimatedMinutes" class="field" type="number" min="1" max="600" :disabled="!canEdit">
          </label>
        </div>

        <label class="toggle block">
          <input v-model="form.allowPrint" type="checkbox" :disabled="!canEdit">
          <span>{{ t('resource.allowPrint') }}<span class="hint">{{ t('resource.allowPrintHint') }}</span></span>
        </label>
        <label class="toggle block">
          <input v-model="notifyAssigned" type="checkbox" :disabled="!canEdit">
          <span>{{ t('resource.notifyAssigned') }}<span class="hint">{{ t('resource.notifyAssignedHint') }}</span></span>
        </label>
      </section>

      <aside class="side">
        <div class="card">
          <h2 class="panel-title">{{ t('resource.publication') }}</h2>
          <dl class="kv">
            <dt>{{ t('resource.statusLabel') }}</dt><dd><span :class="['badge upper', meta?.status ?? 'draft']">{{ t(`resource.status.${meta?.status ?? 'draft'}`) }}</span></dd>
            <dt>{{ t('resource.version') }}</dt><dd>{{ meta?.publishedVersionId ? meta.version : '—' }}<span v-if="meta?.hasUnpublishedChanges" class="sub">{{ t('resource.unpublishedChanges') }}</span></dd>
            <dt>{{ t('resource.updated') }}</dt><dd>{{ meta ? formatShortDate(new Date(meta.updatedAt)) : '—' }}</dd>
          </dl>
          <p v-if="meta?.usedInCourses" class="help">{{ t('resource.usedIn', { n: meta.usedInCourses }) }}</p>
          <ul v-if="meta?.versions.length" class="versions">
            <li v-for="v in meta.versions" :key="v.id"><b>v{{ v.version }}</b> · {{ formatShortDate(new Date(v.publishedAt)) }}<span v-if="v.changelog" class="sub">{{ v.changelog }}</span></li>
          </ul>
          <div v-if="meta && hasScope('course.archive')" class="side-actions">
            <button v-if="meta.status !== 'archived'" class="chip" @click="setStatus('archive')">{{ t('resource.archive') }}</button>
            <button v-else class="chip" @click="setStatus('restore')">{{ t('resource.restore') }}</button>
            <button class="chip coral" @click="remove">{{ t('resource.delete') }}</button>
          </div>
        </div>

        <div class="card">
          <h2 class="panel-title">{{ t('resource.accessAndCategories') }}</h2>
          <span class="label">{{ t('resource.categories') }}</span>
          <div class="chips">
            <button v-for="c in categories" :key="c.id" type="button" :class="['chip', { on: form.categoryIds.includes(c.id) }]" :aria-pressed="form.categoryIds.includes(c.id)" :disabled="!canEdit" @click="toggle(form.categoryIds, c.id)">{{ c.name }}</button>
            <NuxtLink v-if="!categories.length" to="/admin/resources/categories" class="link">{{ t('resource.addCategory') }}</NuxtLink>
          </div>
          <span class="label top">{{ t('resource.accessGroups') }}</span>
          <div class="chips">
            <button v-for="g in groups" :key="g.id" type="button" :class="['chip', { on: form.accessGroupIds.includes(g.id) }]" :aria-pressed="form.accessGroupIds.includes(g.id)" :disabled="!canEdit" @click="toggle(form.accessGroupIds, g.id)">{{ g.name }}</button>
          </div>
          <p class="help">{{ t('resource.accessOpen') }}</p>
          <label class="top">
            <span class="label">{{ t('resource.tags') }}</span>
            <input v-model="form.tags" class="field" :placeholder="t('resource.tagsPlaceholder')" :disabled="!canEdit">
          </label>
        </div>

        <div class="card">
          <h2 class="panel-title">{{ t('resource.covers') }}</h2>
          <label class="cover">
            <span class="label">{{ t('resource.cover') }}</span>
            <input type="file" class="field" :accept="coverAccept" :disabled="!canEdit" @change="onCover($event, 'coverKey')">
            <span class="help">{{ t('resource.coverFormats') }}<template v-if="form.coverKey"> · ✓</template></span>
          </label>
          <label class="cover top">
            <span class="label">{{ t('resource.cardImage') }}</span>
            <input type="file" class="field" :accept="coverAccept" :disabled="!canEdit" @change="onCover($event, 'cardImageKey')">
            <span class="help">{{ t('resource.coverFormats') }}<template v-if="form.cardImageKey"> · ✓</template></span>
          </label>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.split { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--space-4); align-items: start; }
.main { display: grid; gap: var(--space-4); min-width: 0; }
.side { display: grid; gap: var(--space-3); }
.block { border: none; margin: 0; padding: 0; min-width: 0; }
.grid2 { display: grid; grid-template-columns: 1fr 160px; gap: var(--space-3); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: var(--space-1) var(--space-3); margin: 0; font-size: var(--font-size-body-s); }
.kv dt { color: var(--color-ink-muted); font-weight: 700; }
.kv dd { margin: 0; }
.versions { list-style: none; margin: var(--space-3) 0 0; padding: 0; display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.side-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-3); }
.top { display: block; margin-top: var(--space-3); }
.cover { display: grid; gap: var(--space-1); }
.chip.coral { color: var(--color-coral-ink); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.segmented label:focus-within { outline: 2px solid var(--color-ink); }
@media (max-width: 900px) {
  .split { grid-template-columns: minmax(0, 1fr); }
  .grid2 { grid-template-columns: 1fr; }
}
</style>

<script setup lang="ts">
/**
 * Форма оголошення (docs/21 §6.3, §14.5 `/notices/create`): назва, текст, файли, тип, термін оголошення,
 * режим показу, пріоритет, блокування до підтвердження. Аудиторія і строк — назначением («Призначити»).
 */
import type { ContentBlock } from '../../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const router = useRouter()
const { upload } = useMediaUpload()
const isNew = computed(() => route.params.id === 'new')
const form = reactive({
  title: '', body: [{ id: 'b1', type: 'text', html: '<p></p>' }] as ContentBlock[], kind: 'acknowledge', startsAt: '', endsAt: '',
  showMode: 'modal', priority: 'normal', blockUntilAck: false, ackText: '', publish: true, status: 'draft',
  attachments: [] as { mediaId: string, name: string, bytes?: number }[],
})
const error = ref('')
const busy = ref(false)
const toLocal = (s: string | null) => s ? new Date(new Date(s).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : ''
const toIso = (s: string) => s ? new Date(s).toISOString() : null
onMounted(async () => {
  if (isNew.value) return
  try {
    const n = await api<typeof form & { startsAt: string | null, endsAt: string | null, status: string }>(`/notices/${route.params.id}`, { query: { manage: '1' } })
    Object.assign(form, { title: n.title, body: n.body as ContentBlock[], kind: n.kind, startsAt: toLocal(n.startsAt), endsAt: toLocal(n.endsAt), showMode: n.showMode, priority: n.priority, blockUntilAck: n.blockUntilAck, ackText: n.ackText ?? '', status: n.status, publish: n.status === 'published', attachments: n.attachments ?? [] })
  } catch (err) { error.value = apiErrorOf(err).message }
})
async function addFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try { const mediaId = await upload(f, f.name); form.attachments.push({ mediaId, name: f.name, bytes: f.size }) } catch (err) { error.value = apiErrorOf(err).message }
}
async function save() {
  busy.value = true; error.value = ''
  const body = { title: form.title, body: form.body, kind: form.kind, startsAt: toIso(form.startsAt), endsAt: toIso(form.endsAt), showMode: form.showMode, priority: form.priority, blockUntilAck: form.blockUntilAck, ackText: form.ackText || null, attachments: form.attachments, publish: form.publish, ...(isNew.value ? {} : { status: form.publish ? 'published' : form.status === 'published' ? 'draft' : form.status }) }
  try {
    const n = isNew.value ? await api<{ id: string }>('/notices', { method: 'POST', body }) : await api<{ id: string }>(`/notices/${route.params.id}`, { method: 'PATCH', body })
    await router.push(isNew.value ? `/admin/assignments/new?type=notice&subjectId=${n.id}` : `/admin/notices?id=${n.id}`)
  } catch (err) { error.value = apiErrorOf(err).message } finally { busy.value = false }
}
</script>
<template>
  <div>
    <PageHeader :title="isNew ? t('notices.add') : t('notices.edit')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('notices.title'), to: '/admin/notices' }, { label: isNew ? t('notices.add') : form.title }]">
      <template #actions>
        <button class="btn primary" :disabled="busy || form.title.trim().length < 3" @click="save">{{ isNew ? t('notices.saveAndAssign') : t('common.save') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="grid">
      <section class="card">
        <label class="label" for="n-title">{{ t('notices.f.title') }}</label>
        <input id="n-title" v-model="form.title" class="field" maxlength="200" required>
        <p class="label top">{{ t('notices.f.body') }}</p>
        <BlockEditor v-model="form.body" />
        <p class="label top">{{ t('notices.f.files') }}</p>
        <ul class="files">
          <li v-for="(f, i) in form.attachments" :key="f.mediaId">📎 {{ f.name }} <button class="chip" type="button" @click="form.attachments.splice(i, 1)">{{ t('common.delete') }}</button></li>
        </ul>
        <input class="field" type="file" :aria-label="t('notices.f.files')" @change="addFile">
      </section>
      <aside class="card side">
        <p class="label">{{ t('notices.f.kind') }}</p>
        <div class="segmented" role="radiogroup">
          <label v-for="k in ['acknowledge', 'event', 'notification']" :key="k" :class="{ on: form.kind === k }"><input v-model="form.kind" type="radio" :value="k" class="sr">{{ t(`notices.kind.${k}`) }}</label>
        </div>
        <p class="help">{{ t(`notices.kindHint.${form.kind}`) }}</p>
        <p class="label top">{{ t('notices.f.term') }}</p>
        <label class="label" for="n-start">{{ t('notices.f.from') }}</label><input id="n-start" v-model="form.startsAt" class="field" type="datetime-local">
        <label class="label top" for="n-end">{{ t('notices.f.to') }}</label><input id="n-end" v-model="form.endsAt" class="field" type="datetime-local">
        <p class="help">{{ t('notices.termHint') }}</p>
        <label class="toggle top"><input v-model="form.publish" type="checkbox"><span>{{ t('news.publish') }}</span></label>
        <p class="label top">{{ t('news.showMode') }}</p>
        <select v-model="form.showMode" class="field"><option value="modal">{{ t('news.mode.modal') }}</option><option value="banner">{{ t('news.mode.banner') }}</option><option value="both">{{ t('news.mode.both') }}</option></select>
        <p class="label top">{{ t('news.priority') }}</p>
        <select v-model="form.priority" class="field"><option value="normal">{{ t('news.prio.normal') }}</option><option value="important">{{ t('news.prio.important') }}</option><option value="critical">{{ t('news.prio.critical') }}</option></select>
        <label class="label top" for="n-ack">{{ t('news.ackTextPh') }}</label><input id="n-ack" v-model="form.ackText" class="field" maxlength="60">
        <label v-if="hasScope('settings.tenant')" class="toggle top"><input v-model="form.blockUntilAck" type="checkbox"><span>{{ t('news.blockUntilAck') }}<span class="hint">{{ t('news.blockWarn') }}</span></span></label>
        <p class="help top">{{ t('notices.assignHint') }}</p>
      </aside>
    </div>
  </div>
</template>
<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--space-4); align-items: start; }
.top { margin-top: var(--space-3); }
.files { list-style: none; margin: 0 0 var(--space-2); padding: 0; display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.sr { position: absolute; opacity: 0; width: 1px; height: 1px; }
.segmented label { cursor: pointer; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>

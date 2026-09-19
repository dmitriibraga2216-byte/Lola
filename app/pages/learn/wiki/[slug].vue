<script setup lang="ts">
import type { ContentBlock } from '~~/shared/schemas/content'

definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const router = useRouter()
interface Page { id: string, title: string, slug: string, body: ContentBlock[], status: string, version: number, parentId: string | null, viewRoles: string[], editRoles: string[], crumbs: { id: string, title: string, slug: string }[], children: { id: string, title: string, slug: string }[], canEdit: boolean, updatedAt: string, updatedByName: string | null }
interface Rev { id: string, version: number, title: string, comment: string | null, createdAt: string, authorName: string | null }
const isNew = computed(() => route.params.slug === 'new')
const page = ref<Page | null>(null)
const editing = ref(false)
const history = ref<Rev[] | null>(null)
const error = ref('')
const notice = ref('')
const form = reactive({ title: '', body: [] as ContentBlock[], comment: '', parentId: '', viewRoles: [] as string[], editRoles: [] as string[], status: 'published' })
const ROLES = ['employee', 'mentor', 'manager', 'author', 'admin']
async function load() {
  if (isNew.value) { editing.value = true; form.parentId = String(route.query.parentId || ''); form.body = [{ id: `b${Date.now()}`, type: 'text', html: '<p></p>' }]; return }
  try { page.value = await api<Page>(`/wiki/${route.params.slug}`) } catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function startEdit() {
  if (!page.value) return
  // Блокировка на время правки (docs/21 §5.5)
  try { await api(`/wiki/${page.value.id}/lock`, { method: 'POST', body: {} }) } catch (err) { error.value = apiErrorOf(err).message; return }
  Object.assign(form, { title: page.value.title, body: JSON.parse(JSON.stringify(page.value.body)), comment: '', parentId: page.value.parentId ?? '', viewRoles: [...page.value.viewRoles], editRoles: [...page.value.editRoles], status: page.value.status }); editing.value = true }
async function save() {
  error.value = ''
  try {
    const body = { title: form.title, body: form.body, parentId: form.parentId || null, viewRoles: form.viewRoles, editRoles: form.editRoles, status: form.status }
    if (isNew.value) { const p = await api<Page>('/wiki', { method: 'POST', body }); router.replace(`/learn/wiki/${p.slug}`); return }
    page.value = await api<Page>(`/wiki/${page.value!.id}`, { method: 'PATCH', body: { ...body, comment: form.comment || undefined } })
    editing.value = false; notice.value = t('common.saved'); await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
function cancelEdit() { editing.value = false; if (page.value) api(`/wiki/${page.value.id}/lock`, { method: 'POST', body: { release: true } }).catch(() => null) }
async function showHistory() { history.value = await api(`/wiki/${page.value!.id}/history`) }
const diff = ref<{ from: number, to: number, lines: { op: 'same' | 'add' | 'del', text: string }[] } | null>(null)
async function showDiff(v: number) { if (!page.value) return; diff.value = await api(`/wiki/${page.value.id}/diff`, { query: { from: v, to: page.value.version } }) }
async function restore(v: number) { await api(`/wiki/${page.value!.id}/restore`, { method: 'POST', body: { version: v } }); history.value = null; await load() }
async function remove() { if (!confirm(t('wiki.deleteConfirm'))) return; await api(`/wiki/${page.value!.id}`, { method: 'DELETE' }); router.push('/learn/wiki') }
</script>
<template>
  <div>
    <NuxtLink to="/learn/wiki" class="back">← {{ t('wiki.title') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <template v-if="editing">
      <h1>{{ isNew ? t('wiki.newPage') : t('common.edit') }}</h1>
      <div class="form">
        <input v-model="form.title" class="field" :placeholder="t('wiki.pageTitle')" data-testid="wiki-title">
        <BlockEditor v-model="form.body" />
        <details>
          <summary class="sub">{{ t('wiki.settings') }}</summary>
          <div class="row"><span class="sub">{{ t('wiki.viewRoles') }}:</span><label v-for="r in ROLES" :key="r" class="check"><input v-model="form.viewRoles" type="checkbox" :value="r"> {{ r }}</label></div>
          <div class="row"><span class="sub">{{ t('wiki.editRoles') }}:</span><label v-for="r in ROLES" :key="r" class="check"><input v-model="form.editRoles" type="checkbox" :value="r"> {{ r }}</label></div>
          <p class="sub">{{ t('wiki.rolesHint') }}</p>
          <label class="check"><input v-model="form.status" type="checkbox" true-value="published" false-value="draft"> {{ t('wiki.published') }}</label>
        </details>
        <input v-if="!isNew" v-model="form.comment" class="field" :placeholder="t('wiki.changeComment')">
        <div class="actions"><button class="chip" @click="isNew ? router.push('/learn/wiki') : cancelEdit()">{{ t('common.cancel') }}</button><button class="primary" :disabled="form.title.length < 2" data-testid="wiki-save" @click="save">{{ t('common.save') }}</button></div>
      </div>
    </template>
    <template v-else-if="page">
      <p class="crumbs"><NuxtLink v-for="c in page.crumbs" :key="c.id" :to="`/learn/wiki/${c.slug}`">{{ c.title }} ›</NuxtLink></p>
      <h1>{{ page.title }}</h1>
      <p class="sub">v{{ page.version }} · {{ new Date(page.updatedAt).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) }}<template v-if="page.updatedByName"> · {{ page.updatedByName }}</template><template v-if="page.status !== 'published'"> · {{ t('wiki.draft') }}</template></p>
      <div v-if="page.canEdit" class="actions">
        <button class="chip" data-testid="wiki-edit" @click="startEdit">{{ t('common.edit') }}</button>
        <button class="chip" @click="showHistory">{{ t('wiki.history') }}</button>
        <NuxtLink v-if="hasScope('wiki.edit')" :to="`/learn/wiki/new?parentId=${page.id}`" class="chip">+ {{ t('wiki.subpage') }}</NuxtLink>
        <button class="chip danger" @click="remove">{{ t('wiki.delete') }}</button>
      </div>
      <article class="body"><LessonBlocks :blocks="page.body" :blocks-state="{}" readonly /></article>
      <section v-if="page.children.length" class="card">
        <h2>{{ t('wiki.subpages') }}</h2>
        <NuxtLink v-for="c in page.children" :key="c.id" :to="`/learn/wiki/${c.slug}`" class="link">{{ c.title }}</NuxtLink>
      </section>
      <section v-if="history" class="card">
        <h2>{{ t('wiki.history') }}</h2>
        <ul class="log"><li v-for="r in history" :key="r.id"><b>v{{ r.version }}</b> · {{ new Date(r.createdAt).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'short' }) }} · {{ r.authorName ?? '—' }}<template v-if="r.comment"> — {{ r.comment }}</template> <button v-if="r.version !== page.version" class="chip" @click="restore(r.version)">{{ t('wiki.restore') }}</button> <button v-if="r.version !== page.version" class="chip" @click="showDiff(r.version)">{{ t('wiki.diff') }}</button></li></ul>
        <div v-if="diff" class="diff">
          <p class="sub">v{{ diff.from }} → v{{ diff.to }}</p>
          <p v-for="(l, i) in diff.lines" :key="i" :class="['dl', l.op]">{{ l.op === 'add' ? '+' : l.op === 'del' ? '−' : ' ' }} {{ l.text }}</p>
        </div>
      </section>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
.crumbs { margin: var(--space-2) 0 0; font-size: var(--font-size-body-s); }
.crumbs a { color: var(--color-ink-muted); text-decoration: none; margin-right: 4px; }
h1 { margin: var(--space-1) 0 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: var(--space-1) 0; }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: var(--space-2) 0; }
.body { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); margin-top: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.form { display: grid; gap: var(--space-2); }
.field { font: inherit; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin: var(--space-1) 0; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; text-decoration: none; font-size: var(--font-size-body-s); }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink); }
.chip.danger { color: var(--color-coral-deep); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; padding: var(--space-2) var(--space-4); }
.primary:disabled { opacity: 0.5; }
.link { color: var(--color-ink); font-weight: 700; }
.log { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.notice { background: var(--color-teal); color: var(--color-teal-deep); padding: var(--space-3); border-radius: var(--radius-m); }
.diff { margin-top: var(--space-2); font-size: var(--font-size-body-s); }
.dl { margin: 0; padding: 2px var(--space-2); white-space: pre-wrap; }
.dl.add { background: var(--color-teal); color: var(--color-teal-deep); }
.dl.del { background: var(--color-coral); color: var(--color-coral-deep); text-decoration: line-through; }
</style>

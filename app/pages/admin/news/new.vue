<script setup lang="ts">
/** Форма новини (мокап NewsForm): Тема, Категорія, Текст, «Дозволити залишати реакції», Опублікувати, Термін «Актуально до», Головне зображення. */
import type { ContentBlock } from '../../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
const router = useRouter()
const { upload } = useMediaUpload()
const form = reactive({ title: '', lead: '', body: [{ id: 'b1', type: 'text', html: '<p></p>' }] as ContentBlock[], categoryId: '', commentsEnabled: true, publish: true, unpublishAt: '', coverKey: '', isPinned: false, requiresAck: false, locationIds: [] as string[] })
const categories = ref<{ id: string, name: string }[]>([])
const locations = ref<{ id: string, name: string }[]>([])
const newCategory = ref('')
const error = ref('')
const busy = ref(false)
onMounted(async () => { try { categories.value = await api('/news/categories'); locations.value = await api('/refs/locations') } catch (err) { error.value = apiErrorOf(err).message } })
async function addCategory() {
  if (newCategory.value.trim().length < 2) return
  try { const c = await api<{ id: string, name: string }>('/news/categories', { method: 'POST', body: { name: newCategory.value.trim() } }); categories.value.push(c); form.categoryId = c.id; newCategory.value = '' } catch (err) { error.value = apiErrorOf(err).message }
}
async function addCover(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try { form.coverKey = await upload(f, f.name, 'content_cover') } catch (err) { error.value = apiErrorOf(err).message }
}
async function save() {
  busy.value = true; error.value = ''
  try {
    await api('/news', { method: 'POST', body: { title: form.title, lead: form.lead || null, body: form.body, categoryId: form.categoryId || null, commentsEnabled: form.commentsEnabled, publish: form.publish, unpublishAt: form.unpublishAt ? new Date(form.unpublishAt).toISOString() : null, coverKey: form.coverKey || undefined, isPinned: form.isPinned, requiresAck: form.requiresAck, audience: form.locationIds.length ? { rules: [{ type: 'location', ids: form.locationIds }], match: 'any' } : null } })
    await router.push('/admin/news')
  } catch (err) { error.value = apiErrorOf(err).message } finally { busy.value = false }
}
</script>
<template>
  <div>
    <PageHeader :title="t('news.add')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.info') }, { label: t('admin.nav.news'), to: '/admin/news' }, { label: t('news.add') }]">
      <template #actions><button class="btn primary" :disabled="busy || form.title.trim().length < 3" @click="save">{{ t('common.save') }}</button></template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="grid">
      <section class="card">
        <label class="label" for="nw-title">{{ t('news.col.topic') }}</label>
        <input id="nw-title" v-model="form.title" class="field" maxlength="200">
        <label class="label top" for="nw-lead">{{ t('news.lead') }}</label>
        <input id="nw-lead" v-model="form.lead" class="field" maxlength="300">
        <label class="label top" for="nw-cat">{{ t('news.category') }}</label>
        <div class="row">
          <select id="nw-cat" v-model="form.categoryId" class="field"><option value="">—</option><option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option></select>
          <input v-model="newCategory" class="field" :placeholder="t('news.newCategory')" maxlength="120" @keydown.enter.prevent="addCategory">
          <button class="btn ghost small" type="button" @click="addCategory">{{ t('common.add') }}</button>
        </div>
        <p class="label top">{{ t('news.text') }}</p>
        <BlockEditor v-model="form.body" />
        <label class="toggle top"><input v-model="form.commentsEnabled" type="checkbox"><span>{{ t('news.allowReactions') }}</span></label>
        <label class="toggle top"><input v-model="form.requiresAck" type="checkbox"><span>{{ t('news.requireAck') }}</span></label>
        <label class="toggle top"><input v-model="form.isPinned" type="checkbox"><span>{{ t('news.pin') }}</span></label>
      </section>
      <aside class="card side">
        <label class="toggle"><input v-model="form.publish" type="checkbox"><span>{{ t('news.publish') }}</span></label>
        <p class="label top">{{ t('news.term') }}</p>
        <p class="help">{{ t('news.termHint') }}</p>
        <label class="label top" for="nw-until">{{ t('news.actualUntil') }}</label>
        <input id="nw-until" v-model="form.unpublishAt" class="field" type="datetime-local">
        <p class="label top">{{ t('news.cover') }}</p>
        <input class="field" type="file" accept=".jpg,.jpeg,.png,.gif,.svg,.webp" :aria-label="t('news.cover')" @change="addCover">
        <p class="help">{{ t('news.coverHint') }}</p>
        <p class="label top">{{ t('news.forLocations') }}</p>
        <label v-for="l in locations" :key="l.id" class="check"><input v-model="form.locationIds" type="checkbox" :value="l.id"> {{ l.name }}</label>
      </aside>
    </div>
  </div>
</template>
<style scoped>
.grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--space-4); align-items: start; }
.top { margin-top: var(--space-3); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.row .field { flex: 1 1 160px; width: auto; }
.check { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); margin-top: var(--space-1); }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>

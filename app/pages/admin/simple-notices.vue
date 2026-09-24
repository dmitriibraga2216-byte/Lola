<script setup lang="ts">
/** Прості оголошення (мокап SimpleNotices): без призначення і підтвердження — просто плашка. Таблица Назва · Опубліковано · Діє до · Реакцій · Стан. */
import type { ContentBlock } from '../../../shared/schemas/content'
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
interface S { id: string, title: string, body: unknown[], publishedAt: string | null, endsAt: string | null, status: string, viewsCount: number }
const items = ref<S[]>([])
const error = ref('')
const adding = ref(false)
const busy = ref(false)
const form = reactive({ title: '', body: [{ id: 'b1', type: 'text', html: '<p></p>' }] as ContentBlock[], endsAt: '', publish: true })
const d = (s: string | null) => s ? formatShortDate(new Date(s)) : '—'
const excerpt = (body: unknown[]) => (body as { html?: string }[]).map(b => (b.html ?? '').replace(/<[^>]+>/g, ' ')).join(' ').replace(/\s+/g, ' ').trim().slice(0, 90)
async function load() { try { items.value = await api<S[]>('/simple-notices', { query: { all: '1' } }) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function save() {
  busy.value = true; error.value = ''
  try {
    await api('/simple-notices', { method: 'POST', body: { title: form.title, body: form.body, endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null, publish: form.publish } })
    Object.assign(form, { title: '', body: [{ id: `b${Date.now()}`, type: 'text', html: '<p></p>' }], endsAt: '', publish: true }); adding.value = false
    await load()
  } catch (err) { error.value = apiErrorOf(err).message } finally { busy.value = false }
}
async function setStatus(s: S, status: 'published' | 'archived') { try { await api(`/simple-notices/${s.id}`, { method: 'PATCH', body: { status } }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
async function remove(s: S) { if (!confirm(t('common.confirmDelete'))) return; try { await api(`/simple-notices/${s.id}`, { method: 'DELETE' }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
</script>
<template>
  <div>
    <PageHeader :title="t('notices.simple.title')" :subtitle="t('notices.simple.hint')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.info') }, { label: t('notices.simple.title') }]">
      <template #actions><button class="btn primary" @click="adding = !adding">{{ t('common.add') }}</button></template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p class="note sun">{{ t('notices.simple.note') }}</p>
    <section v-if="adding" class="card form">
      <label class="label" for="s-title">{{ t('notices.f.title') }}</label>
      <input id="s-title" v-model="form.title" class="field" maxlength="200">
      <p class="label top">{{ t('notices.f.body') }}</p>
      <BlockEditor v-model="form.body" />
      <label class="label top" for="s-end">{{ t('notices.simple.until') }}</label>
      <input id="s-end" v-model="form.endsAt" class="field" type="datetime-local">
      <label class="toggle top"><input v-model="form.publish" type="checkbox"><span>{{ t('news.publish') }}</span></label>
      <div class="actions top"><button class="btn primary" :disabled="busy || form.title.trim().length < 3" @click="save">{{ t('common.save') }}</button><button class="btn ghost" @click="adding = false">{{ t('common.cancel') }}</button></div>
    </section>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('notices.col.title') }}</th><th>{{ t('notices.col.published') }}</th><th>{{ t('notices.simple.until') }}</th><th class="num">{{ t('notices.col.reactions') }}</th><th>{{ t('notices.col.state') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="s in items" :key="s.id">
            <td><b>{{ s.title }}</b><span class="sub">{{ excerpt(s.body) }}</span></td>
            <td>{{ d(s.publishedAt) }}</td>
            <td>{{ s.endsAt ? t('notices.simple.untilDate', { d: d(s.endsAt) }) : '—' }}</td>
            <td class="num">{{ s.viewsCount }}</td>
            <td><span :class="['badge', s.status === 'published' && (!s.endsAt || new Date(s.endsAt) > new Date()) ? 'teal' : 'muted']">{{ s.status === 'published' && (!s.endsAt || new Date(s.endsAt) > new Date()) ? t('notices.phase.active') : s.status === 'published' ? t('notices.phase.expired') : t(`notices.phase.${s.status}`) }}</span></td>
            <td class="acts">
              <button v-if="s.status === 'published'" class="chip" @click="setStatus(s, 'archived')">{{ t('news.archive') }}</button>
              <button v-else class="chip" @click="setStatus(s, 'published')">{{ t('news.publish') }}</button>
              <button class="chip" @click="remove(s)">{{ t('common.delete') }}</button>
            </td>
          </tr>
          <tr v-if="!items.length"><td colspan="6" class="faint">{{ t('notices.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
<style scoped>
.form { margin-bottom: var(--space-4); }
.top { margin-top: var(--space-3); }
.actions { display: flex; gap: var(--space-2); }
.acts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.note { margin-bottom: var(--space-3); }
</style>

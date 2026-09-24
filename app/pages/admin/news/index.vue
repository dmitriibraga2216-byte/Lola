<script setup lang="ts">
/** Новини (мокап News): фильтры Категорія · Автор, колонки Тема · Автор · Актуально · Переглядів · Реакцій · Опубліковано. */
const { formatDateTime, formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
interface N { id: string, title: string, status: string, isPinned: boolean, requiresAck: boolean, publishedAt: string | null, unpublishAt: string | null, viewsCount: number, acks: number, authorName: string | null, categoryName: string | null, categoryId: string | null }
interface Report { total: number, acked: number, viewed: number, byLocation: { location: string, total: number, acked: number, pct: number }[], notAcked: { id: string, fullName: string, location: string | null, viewedAt: string | null }[], readers: { id: string, fullName: string, location: string | null, ackedAt: string }[] }
const items = ref<N[]>([])
const error = ref('')
const category = ref('')
const author = ref('')
const report = ref<{ title: string, data: Report } | null>(null)
const d = (s: string | null) => s ? formatShortDate(new Date(s)) : '—'
async function load() { try { items.value = await api<N[]>('/news', { query: { all: '1' } }) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
const categories = computed(() => [...new Set(items.value.map(n => n.categoryName).filter(Boolean))] as string[])
const authors = computed(() => [...new Set(items.value.map(n => n.authorName).filter(Boolean))] as string[])
const rows = computed(() => items.value.filter(n => (!category.value || n.categoryName === category.value) && (!author.value || n.authorName === author.value)))
async function showReport(n: N) { report.value = { title: n.title, data: await api(`/news/${n.id}/report`) } }
async function toggle(n: N, field: 'isPinned' | 'status') {
  await api(`/news/${n.id}`, { method: 'PATCH', body: field === 'isPinned' ? { isPinned: !n.isPinned } : { status: n.status === 'published' ? 'archived' : 'published' } })
  await load()
}
</script>
<template>
  <div>
    <PageHeader :title="t('admin.nav.news')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('admin.section.info') }, { label: t('admin.nav.news') }]">
      <template #actions><NuxtLink class="btn primary" to="/admin/news/new">{{ t('news.add') }}</NuxtLink></template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <div class="filters">
      <select v-model="category" class="field" :aria-label="t('news.category')"><option value="">{{ t('news.category') }}</option><option v-for="c in categories" :key="c" :value="c">{{ c }}</option></select>
      <select v-model="author" class="field" :aria-label="t('news.authorCol')"><option value="">{{ t('news.authorCol') }}</option><option v-for="a in authors" :key="a" :value="a">{{ a }}</option></select>
    </div>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('news.col.topic') }}</th><th>{{ t('news.authorCol') }}</th><th>{{ t('news.col.actual') }}</th><th class="num">{{ t('news.col.views') }}</th><th class="num">{{ t('news.col.reactions') }}</th><th>{{ t('news.col.published') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="n in rows" :key="n.id">
            <td><span v-if="n.isPinned">📌 </span><b>{{ n.title }}</b><span class="sub">{{ n.categoryName ? t('news.categoryLine', { c: n.categoryName }) : '' }}<template v-if="n.status !== 'published'"> · {{ t(`course.status.${n.status}`) }}</template><template v-if="n.requiresAck"> · {{ t('news.requireAck') }}</template></span></td>
            <td>{{ n.authorName ?? '—' }}</td>
            <td>{{ n.unpublishAt ? t('news.until', { d: d(n.unpublishAt) }) : '—' }}</td>
            <td class="num">{{ n.viewsCount }}</td>
            <td class="num">{{ n.acks }}</td>
            <td>{{ d(n.publishedAt) }}</td>
            <td class="acts">
              <button v-if="n.requiresAck" class="chip" @click="showReport(n)">{{ t('news.report') }}</button>
              <button class="chip" @click="toggle(n, 'isPinned')">{{ n.isPinned ? t('news.unpin') : t('news.pin') }}</button>
              <button class="chip" @click="toggle(n, 'status')">{{ n.status === 'published' ? t('news.archive') : t('news.publish') }}</button>
            </td>
          </tr>
          <tr v-if="!rows.length"><td colspan="7" class="faint">{{ t('news.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
    <div v-if="report" class="modal-backdrop" @click.self="report = null">
      <div class="modal" role="dialog" aria-modal="true">
        <h2>{{ report.title }}</h2>
        <p class="muted">{{ t('news.reportLine', { acked: report.data.acked, total: report.data.total, viewed: report.data.viewed }) }}</p>
        <table class="table plain"><tbody><tr v-for="l in report.data.byLocation" :key="l.location" :class="{ ok: l.pct === 100 }"><td>{{ l.location }}</td><td>{{ l.acked }} / {{ l.total }}</td><td><b>{{ l.pct }}%</b></td></tr></tbody></table>
        <h3>{{ t('news.notAcked') }} ({{ report.data.notAcked.length }})</h3>
        <ul><li v-for="r in report.data.notAcked" :key="r.id">{{ r.fullName }} <span class="muted">{{ r.location ?? '' }}{{ r.viewedAt ? ` · ${t('news.viewedOnly')}` : '' }}</span></li><li v-if="!report.data.notAcked.length" class="faint">—</li></ul>
        <h3>{{ t('news.acked') }} ({{ report.data.readers.length }})</h3>
        <ul><li v-for="r in report.data.readers" :key="r.id">✓ {{ r.fullName }} <span class="muted">{{ formatDateTime(new Date(r.ackedAt)) }}</span></li></ul>
        <button class="btn ghost" @click="report = null">{{ t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>
<style scoped>
.filters { display: flex; gap: var(--space-2); margin-bottom: var(--space-3); flex-wrap: wrap; }
.filters .field { width: auto; min-width: 160px; }
.acts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
h2 { margin: 0 0 var(--space-2); font-weight: 900; }
h3 { margin: var(--space-3) 0 var(--space-1); font-weight: 800; font-size: var(--font-size-body); }
.table.plain { margin: 0; }
tr.ok td { color: var(--color-teal-deep); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); z-index: 20; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(480px, 100%); max-height: 80dvh; overflow: auto; display: grid; gap: var(--space-2); }
.modal ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
</style>

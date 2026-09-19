<script setup lang="ts">
import type { ContentBlock } from '../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
interface N { id: string, title: string, status: string, isPinned: boolean, requiresAck: boolean, kind: string, ackDueAt: string | null, publishedAt: string | null, views: number, acks: number }
interface Report { total: number, acked: number, viewed: number, byLocation: { location: string, total: number, acked: number, pct: number }[], notAcked: { id: string, fullName: string, location: string | null, viewedAt: string | null }[], readers: { id: string, fullName: string, location: string | null, ackedAt: string }[] }
const items = ref<N[]>([])
const error = ref('')
const notice = ref('')
const form = reactive({ title: '', body: [{ id: 'b1', type: 'text', html: '<p></p>' }] as ContentBlock[], isPinned: false, requiresAck: false, kind: 'news', ackDueAt: '', locationIds: [] as string[], lead: '', publishAt: '', unpublishAt: '', commentsEnabled: false, showMode: 'modal', priority: 'normal', blockUntilAck: false, ackText: '' })
const locations = ref<{ id: string, name: string }[]>([])
const report = ref<{ title: string, data: Report } | null>(null)
const readers = ref<{ id: string, list: { fullName: string, viewedAt: string, ackedAt: string | null }[] } | null>(null)
async function load() { try { items.value = await api<N[]>('/news', { query: { all: '1' } }); locations.value = await api('/refs/locations') } catch (err) { error.value = apiErrorOf(err).message } }
async function showReport(n: N) { report.value = { title: n.title, data: await api(`/news/${n.id}/report`) } }
onMounted(load)
async function publish() {
  error.value = ''
  try {
    await api('/news', { method: 'POST', body: { title: form.title, body: form.body, isPinned: form.isPinned, requiresAck: form.requiresAck, kind: form.kind, ackDueAt: form.ackDueAt ? new Date(form.ackDueAt).toISOString() : null, audience: form.locationIds.length ? { rules: [{ type: 'location', ids: form.locationIds }], match: 'any' } : null, publish: true, lead: form.lead || null, publishAt: form.publishAt ? new Date(form.publishAt).toISOString() : null, unpublishAt: form.unpublishAt ? new Date(form.unpublishAt).toISOString() : null, commentsEnabled: form.commentsEnabled, showMode: form.showMode, priority: form.priority, blockUntilAck: form.blockUntilAck, ackText: form.ackText || null } })
    Object.assign(form, { title: '', body: [{ id: `b${Date.now()}`, type: 'text', html: '<p></p>' }], isPinned: false, requiresAck: false, kind: 'news', ackDueAt: '', locationIds: [], lead: '', publishAt: '', unpublishAt: '', commentsEnabled: false, showMode: 'modal', priority: 'normal', blockUntilAck: false, ackText: '' })
    notice.value = t('news.published')
    await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function showReaders(n: N) { readers.value = { id: n.id, list: await api(`/news/${n.id}/readers`) } }
async function toggle(n: N, field: 'isPinned' | 'status') {
  await api(`/news/${n.id}`, { method: 'PATCH', body: field === 'isPinned' ? { isPinned: !n.isPinned } : { status: n.status === 'published' ? 'archived' : 'published' } })
  await load()
}
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.news') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <section class="card">
      <input v-model="form.title" class="field" :placeholder="t('news.newTitle')">
      <input v-model="form.lead" class="field" :placeholder="t('news.lead')" maxlength="300">
      <BlockEditor v-model="form.body" />
      <div class="row">
        <label class="sub">{{ t('news.publishAt') }} <input v-model="form.publishAt" class="field" type="datetime-local"></label>
        <label class="sub">{{ t('news.unpublishAt') }} <input v-model="form.unpublishAt" class="field" type="datetime-local"></label>
        <label class="check"><input v-model="form.commentsEnabled" type="checkbox"> {{ t('news.commentsEnabled') }}</label>
      </div>
      <div class="row"><span class="sub">{{ t('news.forLocations') }}:</span><label v-for="l in locations" :key="l.id" class="check"><input v-model="form.locationIds" type="checkbox" :value="l.id"> {{ l.name }}</label></div>
      <div class="row">
        <label class="check"><input v-model="form.isPinned" type="checkbox"> {{ t('news.pin') }}</label>
        <label class="check"><input v-model="form.requiresAck" type="checkbox"> {{ t('news.requireAck') }}</label>
        <select v-model="form.kind" class="field"><option value="news">{{ t('news.kind.news') }}</option><option value="announcement">{{ t('news.kind.announcement') }}</option></select>
        <label v-if="form.kind === 'announcement'" class="sub">{{ t('news.ackDue') }} <input v-model="form.ackDueAt" class="field" type="datetime-local"></label>
      </div>
      <div v-if="form.kind === 'announcement'" class="row">
        <select v-model="form.showMode" class="field" :aria-label="t('news.showMode')"><option value="modal">{{ t('news.mode.modal') }}</option><option value="banner">{{ t('news.mode.banner') }}</option><option value="both">{{ t('news.mode.both') }}</option></select>
        <select v-model="form.priority" class="field" :aria-label="t('news.priority')"><option value="normal">{{ t('news.prio.normal') }}</option><option value="important">{{ t('news.prio.important') }}</option><option value="critical">{{ t('news.prio.critical') }}</option></select>
        <input v-model="form.ackText" class="field" :placeholder="t('news.ackTextPh')" maxlength="60">
        <label v-if="hasScope('settings.tenant')" class="check"><input v-model="form.blockUntilAck" type="checkbox"> {{ t('news.blockUntilAck') }}</label>
        <span v-if="form.blockUntilAck" class="sub warn">{{ t('news.blockWarn') }}</span>
      </div>
      <div class="row">
        <button class="primary" :disabled="form.title.trim().length < 3" @click="publish">{{ t('news.publish') }}</button>
      </div>
    </section>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('news.col.date') }}</th><th>{{ t('news.col.views') }}</th><th>{{ t('news.col.acks') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="n in items" :key="n.id">
          <td><span v-if="n.isPinned">📌 </span><span v-if="n.kind === 'announcement'">📣 </span><b>{{ n.title }}</b><span v-if="n.status !== 'published'" class="sub"> · {{ t(`course.status.${n.status}`) }}</span></td>
          <td class="sub">{{ n.publishedAt ? new Date(n.publishedAt).toLocaleDateString('uk') : '—' }}</td>
          <td>{{ n.views }}</td>
          <td>{{ n.requiresAck ? n.acks : '—' }}</td>
          <td class="acts">
            <button v-if="n.kind === 'announcement'" class="chip" @click="showReport(n)">{{ t('news.report') }}</button>
            <button v-else class="chip" @click="showReaders(n)">{{ t('news.readers') }}</button>
            <button class="chip" @click="toggle(n, 'isPinned')">{{ n.isPinned ? t('news.unpin') : t('news.pin') }}</button>
            <button class="chip" @click="toggle(n, 'status')">{{ n.status === 'published' ? t('news.archive') : t('news.publish') }}</button>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-if="report" class="modal-backdrop" @click.self="report = null">
      <div class="modal">
        <h2>{{ report.title }}</h2>
        <p class="sub">{{ t('news.reportLine', { acked: report.data.acked, total: report.data.total, viewed: report.data.viewed }) }}</p>
        <table class="table plain"><tbody><tr v-for="l in report.data.byLocation" :key="l.location" :class="{ ok: l.pct === 100 }"><td>{{ l.location }}</td><td>{{ l.acked }} / {{ l.total }}</td><td><b>{{ l.pct }}%</b></td></tr></tbody></table>
        <h3>{{ t('news.notAcked') }} ({{ report.data.notAcked.length }})</h3>
        <ul><li v-for="r in report.data.notAcked" :key="r.id">{{ r.fullName }} <span class="sub">{{ r.location ?? '' }}{{ r.viewedAt ? ` · ${t('news.viewedOnly')}` : '' }}</span></li><li v-if="!report.data.notAcked.length" class="sub">—</li></ul>
        <h3>{{ t('news.acked') }} ({{ report.data.readers.length }})</h3>
        <ul><li v-for="r in report.data.readers" :key="r.id">✓ {{ r.fullName }} <span class="sub">{{ new Date(r.ackedAt).toLocaleString('uk') }}</span></li></ul>
      </div>
    </div>
    <div v-if="readers" class="modal-backdrop" @click.self="readers = null">
      <div class="modal">
        <h2>{{ t('news.readers') }}</h2>
        <ul><li v-for="r in readers.list" :key="r.fullName">{{ r.ackedAt ? '✓' : '·' }} {{ r.fullName }} <span class="sub">{{ new Date(r.viewedAt).toLocaleString('uk') }}</span></li><li v-if="!readers.list.length" class="sub">—</li></ul>
      </div>
    </div>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0 0 var(--space-3); font-weight: 800; }
h3 { margin: var(--space-3) 0 var(--space-1); font-weight: 800; font-size: var(--font-size-body); }
.table.plain { background: transparent; margin: 0; }
tr.ok td { color: var(--color-teal-deep); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); margin-bottom: var(--space-4); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.row { display: flex; gap: var(--space-4); align-items: center; }
.check { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.primary { margin-left: auto; font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.acts { display: flex; gap: var(--space-1); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: 2px var(--space-2); cursor: pointer; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(420px, 100%); max-height: 80dvh; overflow: auto; }
.modal ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.warn { color: var(--color-coral-ink); }
</style>

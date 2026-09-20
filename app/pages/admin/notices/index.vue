<script setup lang="ts">
/**
 * Оголошення (мокап Notices, docs/21 §14.5): список слева, карточка с бейджами типа и режима призначення,
 * «Нагадати тим, хто не підтвердив», справа охват «Ознайомились N із M» с вкладками Не підтвердили / Підтвердили.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'knowledge.manage' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const router = useRouter()
interface N { id: string, title: string, kind: string, startsAt: string | null, endsAt: string | null, status: string, publishedAt: string | null, priority: string, showMode: string, blockUntilAck: boolean, viewsCount: number, authorName: string | null, acks: number, total: number, assignMode: string | null, phase: string }
interface Person { id: string, fullName: string, location: string | null, position: string | null, ackedAt: string | null }
interface Cov { notice: { body: unknown[], attachments: { mediaId: string, name: string, bytes?: number }[] }, dueAt: string | null, total: number, acked: number, byLocation: { location: string, total: number, acked: number, pct: number }[], notAcked: Person[], readers: Person[] }
const items = ref<N[]>([])
const selectedId = ref<string>(String(route.query.id ?? ''))
const cov = ref<Cov | null>(null)
const tab = ref<'notAcked' | 'readers'>('notAcked')
const error = ref('')
const notice = ref('')
const busy = ref(false)
const selected = computed(() => items.value.find(n => n.id === selectedId.value) ?? null)
const d = (s: string | null) => s ? new Date(s).toLocaleDateString('uk-UA') : null
const initials = (name: string) => name.split(' ').slice(0, 2).map(w => w[0] ?? '').join('').toUpperCase()

async function load() {
  try { items.value = await api<N[]>('/notices') } catch (err) { error.value = apiErrorOf(err).message }
  if (!selectedId.value && items.value[0]) selectedId.value = items.value[0].id
}
watch(selectedId, async (id) => {
  cov.value = null
  if (!id) return
  router.replace({ query: { ...route.query, id } })
  try { cov.value = await api<Cov>(`/notices/${id}/coverage`) } catch (err) { error.value = apiErrorOf(err).message }
}, { immediate: true })
onMounted(load)
async function remind() {
  if (!selected.value) return
  busy.value = true; error.value = ''
  try {
    const r = await api<{ reminded: number, total: number }>(`/notices/${selected.value.id}/remind`, { method: 'POST' })
    notice.value = t('notices.reminded', { n: r.reminded, total: r.total })
  } catch (err) { error.value = apiErrorOf(err).message } finally { busy.value = false }
}
async function setStatus(status: 'published' | 'archived') {
  if (!selected.value) return
  try { await api(`/notices/${selected.value.id}`, { method: 'PATCH', body: { status } }); await load() } catch (err) { error.value = apiErrorOf(err).message }
}
const people = computed(() => (tab.value === 'notAcked' ? cov.value?.notAcked : cov.value?.readers) ?? [])
</script>
<template>
  <div>
    <PageHeader :title="t('notices.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('notices.title') }]">
      <template #actions>
        <NuxtLink class="btn primary" to="/admin/notices/new">{{ t('notices.add') }}</NuxtLink>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
    <p v-if="!items.length" class="faint empty">{{ t('notices.empty') }}</p>
    <div v-else class="layout">
      <ul class="list" :aria-label="t('notices.title')">
        <li v-for="n in items" :key="n.id">
          <button :class="['item', { on: n.id === selectedId }]" :aria-pressed="n.id === selectedId" @click="selectedId = n.id">
            <b>{{ n.title }}</b>
            <span class="sub">{{ t(`notices.kind.${n.kind}`) }} · {{ t(`notices.phase.${n.phase}`) }} · {{ n.acks }} / {{ n.total }}</span>
          </button>
        </li>
      </ul>
      <section v-if="selected" class="card main">
        <div class="chips">
          <span class="badge sun">{{ t(`notices.kind.${selected.kind}`) }}</span>
          <span class="badge muted">{{ t(`notices.assignMode.${selected.assignMode ?? 'none'}`) }}</span>
          <span :class="['badge', selected.phase === 'active' ? 'teal' : selected.phase === 'expired' ? 'coral' : 'muted']">{{ t(`notices.phase.${selected.phase}`) }}</span>
          <span v-if="selected.priority !== 'normal'" :class="['badge', selected.priority === 'critical' ? 'coral' : 'sun']">{{ t(`news.prio.${selected.priority}`) }}</span>
        </div>
        <h2>{{ selected.title }}</h2>
        <p class="muted meta">
          <template v-if="selected.publishedAt">{{ t('notices.publishedOn', { d: d(selected.publishedAt) }) }}</template>
          <template v-if="selected.endsAt"> · {{ t('notices.activeUntil', { d: d(selected.endsAt) }) }}</template>
          <template v-if="cov?.dueAt"> · {{ t('notices.ackUntil', { d: d(cov.dueAt) }) }}</template>
          <template v-if="selected.authorName"> · {{ t('notices.author', { name: selected.authorName }) }}</template>
          · {{ t('notices.views', { n: selected.viewsCount }) }}
        </p>
        <div v-if="cov" class="body"><LessonBlocks :blocks="cov.notice.body as never" :blocks-state="{}" readonly /></div>
        <ul v-if="cov?.notice.attachments?.length" class="files">
          <li v-for="f in cov.notice.attachments" :key="f.mediaId">📎 {{ f.name }}<span v-if="f.bytes" class="muted"> · {{ Math.round(f.bytes / 1024) }} {{ t('notices.kb') }}</span></li>
        </ul>
        <div class="actions">
          <button class="btn primary" :disabled="busy || !cov?.notAcked.length" @click="remind">{{ t('notices.remind') }}</button>
          <NuxtLink class="btn ghost" :to="`/admin/notices/${selected.id}`">{{ t('common.edit') }}</NuxtLink>
          <NuxtLink class="btn ghost" :to="`/admin/assignments/new?type=notice&subjectId=${selected.id}`">{{ t('notices.assign') }}</NuxtLink>
          <button v-if="selected.status === 'published'" class="btn ghost" @click="setStatus('archived')">{{ t('news.archive') }}</button>
          <button v-else class="btn ghost" @click="setStatus('published')">{{ t('news.publish') }}</button>
        </div>
      </section>
      <aside v-if="selected" class="card side">
        <p class="panel-title">{{ t('notices.coverage', { acked: cov?.acked ?? selected.acks, total: cov?.total ?? selected.total }) }}</p>
        <div class="bar" role="img" :aria-label="t('notices.coverage', { acked: cov?.acked ?? 0, total: cov?.total ?? 0 })"><span :style="{ width: `${cov && cov.total ? Math.round(cov.acked / cov.total * 100) : 0}%` }" /></div>
        <div class="chips tabs" role="tablist">
          <button role="tab" :class="['chip', { on: tab === 'notAcked' }]" :aria-selected="tab === 'notAcked'" @click="tab = 'notAcked'">{{ t('notices.notAcked') }} · {{ cov?.notAcked.length ?? 0 }}</button>
          <button role="tab" :class="['chip', { on: tab === 'readers' }]" :aria-selected="tab === 'readers'" @click="tab = 'readers'">{{ t('notices.acked') }} · {{ cov?.readers.length ?? 0 }}</button>
        </div>
        <ul class="people">
          <li v-for="p in people" :key="p.id">
            <span class="avatar" aria-hidden="true">{{ initials(p.fullName) }}</span>
            <span class="who"><b>{{ p.fullName }}</b><span class="sub">{{ [p.position, p.location].filter(Boolean).join(' · ') || '—' }}</span></span>
            <span class="muted when">{{ p.ackedAt ? new Date(p.ackedAt).toLocaleDateString('uk-UA') : '—' }}</span>
          </li>
          <li v-if="!people.length" class="faint">—</li>
        </ul>
        <p v-if="cov?.byLocation.length" class="panel-title top">{{ t('notices.byLocation') }}</p>
        <ul v-if="cov" class="locs">
          <li v-for="l in cov.byLocation" :key="l.location" :class="{ ok: l.pct === 100 }"><span>{{ l.location }}</span><b>{{ l.acked }} / {{ l.total }} · {{ l.pct }}%</b></li>
        </ul>
      </aside>
    </div>
  </div>
</template>
<style scoped>
.layout { display: grid; grid-template-columns: 260px minmax(0, 1fr) 300px; gap: var(--space-4); align-items: start; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.item { width: 100%; text-align: left; font: inherit; border: 1px solid var(--color-bg-line-soft); background: var(--color-bg-soft); border-radius: var(--radius-s); padding: var(--space-3); cursor: pointer; display: grid; gap: 2px; color: var(--color-ink); }
.item.on { border-color: var(--color-ink); }
.item .sub, .who .sub { display: block; font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
h2 { margin: var(--space-3) 0 var(--space-1); font-weight: 900; }
.meta { margin: 0 0 var(--space-3); font-size: var(--font-size-body-s); }
.body { margin-bottom: var(--space-3); }
.files { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.bar { height: 8px; border-radius: var(--radius-pill); background: var(--color-bg-line-soft); overflow: hidden; margin: 0 0 var(--space-3); }
.bar span { display: block; height: 100%; background: var(--color-teal); }
.tabs { margin-bottom: var(--space-3); }
.people, .locs { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.people li { display: grid; grid-template-columns: 36px minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; }
.who { min-width: 0; }
.who b { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.when { font-size: var(--font-size-body-s); }
.locs li { display: flex; justify-content: space-between; gap: var(--space-2); font-size: var(--font-size-body-s); }
.locs li.ok { color: var(--color-teal-deep); }
.top { margin-top: var(--space-4); }
.empty { text-align: center; padding: var(--space-6); }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
</style>

<script setup lang="ts">
import { CONTENT_TYPES } from '#shared/enums'
const { formatShortDate } = useFormat()

/**
 * Главный экран администратора по мокапу Main: вкладки-чипы task_type, баннер
 * «N завдань було змінено» (docs/15 §14.6), таблица НАЗВА · ТИП · АВТОР · СТВОРЕНО · ЛЮДИ · СТАН,
 * «Додати призначення» — меню из одиннадцати типов контента (docs/15 §14.1).
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()

interface Row {
  id: string
  title: string
  kind: string
  subjectType: string
  status: string
  dueMode: string
  dueAt: string | null
  dueDays: number | null
  isMandatory: boolean
  authorName: string | null
  createdAt: string
  competenciesCount: number
  contentChanged: boolean
  stats: { assigned?: number, started?: number, completed?: number, overdue?: number }
}

// Вкладки эталона (task_type, docs/02): manual | auto | catalog | trajectory | archive
const TABS = ['all', 'manual', 'auto', 'catalog', 'trajectory', 'archive'] as const
const tab = ref<typeof TABS[number]>('all')
const items = ref<Row[]>([])
const changed = ref<{ count: number, items: { id: string, title: string }[] }>({ count: 0, items: [] })
const error = ref('')
const notice = ref('')
const menuOpen = ref(false)

async function load() {
  try {
    const [rows, ch] = await Promise.all([
      api<Row[]>('/tasks', { query: tab.value === 'all' ? {} : { type: tab.value } }),
      api<{ count: number, items: { id: string, title: string }[] }>('/tasks/changed'),
    ])
    items.value = rows
    changed.value = ch
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
watch(tab, load)
onMounted(load)

async function notifyChanged() {
  try {
    const r = await api<{ notified: number }>('/tasks/changed/notify', { method: 'POST', body: {} })
    notice.value = t('assign.notifiedChanged', { n: r.notified })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function dismissChanged() {
  try { await api('/tasks/changed/dismiss', { method: 'POST', body: {} }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}

/** Состояние строки по мокапу: «ВИКОНАНО», когда все назначенные завершили; иначе статус назначения. */
function stateOf(r: Row) {
  const s = r.stats
  if (r.status === 'active' && (s.assigned ?? 0) > 0 && (s.completed ?? 0) >= (s.assigned ?? 0)) return 'done'
  return r.status
}
function shortName(name: string | null) {
  if (!name) return '—'
  const [last, first] = name.split(' ')
  return first ? `${last} ${first[0]}.` : last
}
</script>

<template>
  <div>
    <PageHeader :title="t('assign.title')" :crumbs="[{ label: t('admin.section.learning') }]">
      <template #actions>
        <div class="menu-wrap">
          <button class="btn primary" aria-haspopup="menu" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">{{ t('assign.add') }}</button>
          <div v-if="menuOpen" class="menu" role="menu" @keydown.esc="menuOpen = false">
            <NuxtLink v-for="ct in CONTENT_TYPES" :key="ct" role="menuitem" class="menu-item" :to="`/admin/assignments/new?type=${ct}`" @click="menuOpen = false">{{ t(`contentType.${ct}`) }}</NuxtLink>
          </div>
        </div>
      </template>
    </PageHeader>

    <div class="chips" role="tablist">
      <button v-for="k in TABS" :key="k" role="tab" :aria-selected="tab === k" :class="['chip', { on: tab === k }]" @click="tab = k">
        {{ t(`assign.tab.${k === 'archive' ? 'archived' : k}`) }}<template v-if="k === 'all' && items.length"> · {{ items.length }}</template>
      </button>
    </div>

    <div v-if="changed.count > 0" class="note sun banner" role="status">
      <span>{{ t('assign.changedBanner', { n: changed.count }) }}</span>
      <span class="banner-actions">
        <button class="btn ghost small" @click="notifyChanged">{{ t('assign.notifyChanged') }}</button>
        <NuxtLink to="/admin/settings/notifications" class="btn ghost small">{{ t('assign.manageNotifications') }}</NuxtLink>
        <button class="chip" @click="dismissChanged">{{ t('assign.dismissChanged') }}</button>
      </span>
    </div>
    <p v-if="notice" class="note teal">{{ notice }}</p>
    <p v-if="error" class="error-text">{{ error }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('assign.col.title') }}</th><th>{{ t('assign.col.kind') }}</th><th>{{ t('assign.col.author') }}</th>
            <th>{{ t('assign.col.created') }}</th><th>{{ t('assign.col.people') }}</th><th>{{ t('assign.colState') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id" class="row" tabindex="0" @click="navigateTo(`/admin/assignments/${r.id}`)" @keydown.enter="navigateTo(`/admin/assignments/${r.id}`)">
            <td>
              <b>{{ r.title }}</b>
              <span class="sub">
                <template v-if="r.isMandatory">{{ t('assign.mandatory') }} · </template>{{ t(`assign.kind.${r.kind}`) }}<template v-if="r.competenciesCount"> · {{ t('assign.card.competencies', { n: r.competenciesCount }) }}</template>
                <span v-if="r.contentChanged" class="badge sun">!</span>
              </span>
            </td>
            <td>{{ t(`contentType.${r.subjectType}`) }}</td>
            <td class="muted">{{ shortName(r.authorName) }}</td>
            <td class="muted">{{ formatShortDate(new Date(r.createdAt)) }}</td>
            <td class="num">{{ r.stats.assigned ?? 0 }}<span class="sub"><span class="teal">{{ r.stats.completed ?? 0 }}</span> · <span class="coral">{{ r.stats.overdue ?? 0 }}</span></span></td>
            <td><span :class="['badge upper', stateOf(r)]">{{ t(`assign.state.${stateOf(r)}`) }}</span></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="6" class="empty">{{ t('assign.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.chips { margin-bottom: var(--space-3); }
.banner { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-3); font-weight: 700; }
.banner-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.row { cursor: pointer; }
.row:hover td, .row:focus-visible td { background: var(--color-bg-line-soft); }
.teal { color: var(--color-teal-ink); font-weight: 700; }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.menu-wrap { position: relative; }
.menu { position: absolute; right: 0; top: calc(100% + var(--space-1)); z-index: 5; min-width: 220px; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-1); display: grid; box-shadow: 0 8px 24px rgb(12 15 20 / 0.12); }
.menu-item { padding: var(--space-2) var(--space-3); border-radius: var(--radius-s); text-decoration: none; color: var(--color-ink); font-weight: 700; font-size: var(--font-size-body-s); }
.menu-item:hover, .menu-item:focus-visible { background: var(--color-bg-line-soft); }
@media (max-width: 600px) { .menu { left: 0; right: auto; } }
</style>

<script setup lang="ts">
/**
 * «Бібліотека модулів» — список, `/admin/library` (docs/v2/31 §5.1). Шапка: пошук, «Створити
 * модуль» (`library.publish`), «Показати архівні». Колонки: Тип · Назва · Категорія ·
 * Використання («у 3 місцях» → вкладка «Де використовується») · Версія · Власник. Фільтри:
 * тип, категорія, мітка, власник, «тільки невикористовувані», «є застарілі посилання».
 * Нові зверху, 25/50/100 на сторінці, далі — «Показати ще» за курсором (`GET /library/modules`).
 * mentor і manager бачать список лише на читання: кнопка створення та меню — за скоупом.
 */
import type { LibraryTypeIcon } from '#shared/domain/library'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'library.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatShortDate } = useFormat()

interface Card {
  id: string
  title: string
  contentKind: string
  typeIcon: LibraryTypeIcon
  categoryName: string | null
  ownerId: string
  ownerName: string | null
  status: string
  usageCount: number
  staleUsages: number
  currentVersion: { version: number, publishedAt: string } | null
  tags: string[]
}

const KINDS = ['article', 'file', 'video', 'link'] as const
const PAGE_SIZES = [25, 50, 100] as const

const filters = reactive({ q: '', kind: '', categoryId: '', tag: '', ownerId: '', archived: false, onlyUnused: false, onlyStale: false, limit: 25 as number })
const items = ref<Card[] | null>(null)
const total = ref(0)
const cursor = ref<string | null>(null)
const error = ref(false)
const loadingMore = ref(false)
const categories = ref<{ id: string, name: string }[]>([])
const owners = ref<{ id: string, name: string }[]>([])

const filtered = computed(() => !!(filters.kind || filters.categoryId || filters.tag || filters.ownerId || filters.onlyUnused || filters.onlyStale))

function query(more: boolean): Record<string, string | number> {
  const q: Record<string, string | number> = { limit: filters.limit, status: filters.archived ? 'all' : 'active' }
  if (filters.q.trim()) q.q = filters.q.trim()
  if (filters.kind) q.kind = filters.kind
  if (filters.categoryId) q.categoryId = filters.categoryId
  if (filters.tag.trim()) q.tag = filters.tag.trim()
  if (filters.ownerId) q.ownerId = filters.ownerId
  if (filters.onlyUnused) q.onlyUnused = 'true'
  if (filters.onlyStale) q.onlyStale = 'true'
  if (more && cursor.value) q.cursor = cursor.value
  return q
}

async function load(more = false) {
  error.value = false
  if (more) loadingMore.value = true
  else items.value = null
  try {
    const r = await api<{ items: Card[], nextCursor: string | null, total: number }>('/library/modules', { query: query(more) })
    items.value = more ? [...(items.value ?? []), ...r.items] : r.items
    cursor.value = r.nextCursor
    total.value = r.total
    // «Власник» — з тих, хто трапився в бібліотеці: окремого довідника людей для mentor немає
    const seen = new Map(owners.value.map(o => [o.id, o]))
    for (const c of r.items) if (!seen.has(c.ownerId)) seen.set(c.ownerId, { id: c.ownerId, name: c.ownerName ?? '—' })
    owners.value = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
  catch {
    error.value = true
    if (!more) items.value = []
  }
  finally { loadingMore.value = false }
}

let timer: ReturnType<typeof setTimeout> | undefined
watch(() => filters.q, () => {
  clearTimeout(timer)
  timer = setTimeout(() => load(), 300)
})
watch(() => [filters.kind, filters.categoryId, filters.ownerId, filters.archived, filters.onlyUnused, filters.onlyStale, filters.limit], () => load())
onMounted(async () => {
  load()
  categories.value = await api<{ id: string, name: string }[]>('/course-categories').catch(() => [])
})
onBeforeUnmount(() => clearTimeout(timer))

function clearSearch() {
  filters.q = ''
}
</script>

<template>
  <div>
    <PageHeader :title="t('library.list.title')" :crumbs="[{ label: t('admin.section.content') }]">
      <template #actions>
        <NuxtLink to="/admin/library/reports" class="btn ghost">{{ t('admin.nav.libraryReports') }}</NuxtLink>
        <NuxtLink v-if="hasScope('library.publish')" to="/admin/library/new" class="btn primary">{{ t('library.list.create') }}</NuxtLink>
      </template>
    </PageHeader>

    <div class="toolbar">
      <label class="search">
        <span class="sr-only">{{ t('library.list.search') }}</span>
        <input v-model="filters.q" class="field" type="search" :placeholder="t('library.palette.search')">
      </label>
      <label class="check"><input v-model="filters.archived" type="checkbox"> {{ t('library.list.showArchived') }}</label>
    </div>

    <form class="filters" @submit.prevent="load()">
      <label>{{ t('library.palette.col.type') }}
        <select v-model="filters.kind" class="field">
          <option value="">{{ t('library.palette.kindAll') }}</option>
          <option v-for="k in KINDS" :key="k" :value="k">{{ t(`resource.kind.${k}`) }}</option>
        </select>
      </label>
      <label>{{ t('library.palette.col.category') }}
        <select v-model="filters.categoryId" class="field">
          <option value="">{{ t('library.list.any') }}</option>
          <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </label>
      <label>{{ t('library.list.tag') }}
        <input v-model="filters.tag" class="field" maxlength="50" @keydown.enter.prevent="load()">
      </label>
      <label>{{ t('library.palette.col.owner') }}
        <select v-model="filters.ownerId" class="field">
          <option value="">{{ t('library.list.any') }}</option>
          <option v-for="o in owners" :key="o.id" :value="o.id">{{ o.name }}</option>
        </select>
      </label>
      <label class="check"><input v-model="filters.onlyUnused" type="checkbox"> {{ t('library.list.onlyUnused') }}</label>
      <label class="check"><input v-model="filters.onlyStale" type="checkbox"> {{ t('library.list.onlyStale') }}</label>
    </form>

    <div v-if="error" class="note coral" role="alert">
      {{ t('library.palette.loadError') }}
      <button type="button" class="btn ghost" @click="load()">{{ t('library.palette.retry') }}</button>
    </div>

    <ul v-else-if="!items" class="skeleton" aria-busy="true" :aria-label="t('library.list.loading')">
      <li v-for="i in 10" :key="i" />
    </ul>

    <div v-else-if="!items.length && filters.q.trim()" class="empty">
      <p>{{ t('library.palette.nothing', { q: filters.q.trim() }) }}</p>
      <button type="button" class="btn ghost" @click="clearSearch">{{ t('library.palette.clear') }}</button>
    </div>
    <p v-else-if="!items.length && (filtered || filters.archived)" class="muted">{{ t('library.list.noMatch') }}</p>
    <div v-else-if="!items.length" class="empty">
      <p>{{ t('library.palette.empty') }}</p>
      <NuxtLink v-if="hasScope('library.publish')" to="/admin/library/new" class="btn primary">{{ t('library.list.create') }}</NuxtLink>
    </div>

    <template v-else>
      <p class="muted count">{{ t('library.list.total', { n: total }) }}</p>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>{{ t('library.palette.col.type') }}</th>
              <th>{{ t('library.palette.col.title') }}</th>
              <th>{{ t('library.palette.col.category') }}</th>
              <th>{{ t('library.list.usage') }}</th>
              <th>{{ t('library.palette.col.version') }}</th>
              <th>{{ t('library.palette.col.owner') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in items" :key="m.id">
              <td><LibraryTypeIcon :icon="m.typeIcon" /></td>
              <td>
                <NuxtLink :to="`/admin/library/${m.id}`">{{ m.title }}</NuxtLink>
                <span v-if="m.status !== 'published'" :class="['badge', m.status]">{{ t(`library.status.${m.status}`) }}</span>
              </td>
              <td>{{ m.categoryName ?? '—' }}</td>
              <td>
                <NuxtLink v-if="m.usageCount" :to="`/admin/library/${m.id}?tab=usages`">{{ t('library.list.usedIn', { n: m.usageCount }) }}</NuxtLink>
                <span v-else class="muted">{{ t('library.list.unused') }}</span>
                <span v-if="m.staleUsages" class="coral"> · {{ t('library.list.stale', { n: m.staleUsages }) }}</span>
              </td>
              <td>{{ m.currentVersion ? t('library.palette.versionAt', { v: m.currentVersion.version, date: formatShortDate(m.currentVersion.publishedAt) }) : t('library.list.notPublished') }}</td>
              <td>{{ m.ownerName ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="more">
        <button v-if="cursor" type="button" class="btn ghost" :disabled="loadingMore" @click="load(true)">{{ t('library.list.more') }}</button>
        <label>{{ t('library.list.pageSize') }}
          <select v-model.number="filters.limit" class="field">
            <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
      </div>
    </template>
  </div>
</template>

<style scoped>
.toolbar { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; margin-bottom: var(--space-3); }
.toolbar .search { flex: 1 1 280px; }
.toolbar .search .field { width: 100%; }
.filters { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: end; margin-bottom: var(--space-3); }
.filters label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.filters .field { width: auto; min-width: 140px; padding: var(--space-2) var(--space-3); }
.check { display: flex !important; align-items: center; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.skeleton { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.skeleton li { height: var(--space-6); border-radius: var(--radius-s); background: var(--color-bg-line); }
.empty { display: grid; gap: var(--space-3); justify-items: start; }
.count { margin: 0 0 var(--space-2); }
.coral { color: var(--color-coral-deep); font-weight: 700; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 0 var(--space-2); margin-left: var(--space-1); white-space: nowrap; background: var(--color-sun-soft); }
.badge.archived { background: var(--color-bg-line); }
.more { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between; margin-top: var(--space-3); }
.more label { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.more .field { width: auto; }
@media (max-width: 480px) {
  .filters { flex-direction: column; align-items: stretch; }
  .filters .field { width: 100%; }
}
</style>

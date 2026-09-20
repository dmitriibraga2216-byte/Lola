<script setup lang="ts">
import { RESOURCE_KINDS } from '#shared/schemas/resources'

/**
 * Библиотека ресурсов по мокапу ContentResources (docs/11 §5.1, §14): «Знайдено N ресурсів»,
 * фильтры-чипы Тип · Автор · Мітки · Категорія · Опубліковано, таблица
 * НАЗВА · ТИП · АВТОР · МІТКИ · ДАТА ЗМІНИ · ОПУБЛІКОВАНО.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Row {
  id: string
  title: string
  kind: string
  status: string
  tags: string[]
  categoryIds: string[]
  authors: { id: string, fullName: string }[]
  version: number
  updatedAt: string
  usedInCourses: number
}
interface List { total: number, page: number, perPage: number, counts: Record<string, number>, items: Row[] }
interface Category { id: string, name: string }

const STATUS_TABS = ['all', 'draft', 'published', 'archived'] as const
const status = ref<typeof STATUS_TABS[number]>('all')
const kind = ref<string>('')
const authorId = ref('')
const tag = ref('')
const categoryId = ref('')
const q = ref('')
const page = ref(1)
const list = ref<List | null>(null)
const categories = ref<Category[]>([])
const error = ref('')

const authors = computed(() => {
  const map = new Map<string, string>()
  for (const r of list.value?.items ?? []) for (const a of r.authors) map.set(a.id, a.fullName)
  return [...map].map(([id, fullName]) => ({ id, fullName }))
})
const tags = computed(() => [...new Set((list.value?.items ?? []).flatMap(r => r.tags))].sort())

async function load() {
  try {
    list.value = await api<List>('/resources', {
      query: {
        status: status.value,
        ...(kind.value ? { kind: kind.value } : {}),
        ...(authorId.value ? { authorId: authorId.value } : {}),
        ...(tag.value ? { tag: tag.value } : {}),
        ...(categoryId.value ? { categoryId: categoryId.value } : {}),
        ...(q.value.trim() ? { q: q.value.trim() } : {}),
        page: page.value,
        perPage: 25,
      },
    })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
watch([status, kind, authorId, tag, categoryId], () => { page.value = 1; load() })
watch(page, load)
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(q, () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page.value = 1; load() }, 300) })
onMounted(async () => {
  await load()
  try { categories.value = await api<Category[]>('/resource-categories') }
  catch { /* категорий может не быть */ }
})

const shortName = (n: string) => n.split(' ').map((p, i) => (i === 0 ? p : `${p[0]}.`)).slice(0, 2).join(' ')
const catName = (id: string) => categories.value.find(c => c.id === id)?.name
const pages = computed(() => (list.value ? Math.max(1, Math.ceil(list.value.total / list.value.perPage)) : 1))
</script>

<template>
  <div>
    <PageHeader :title="t('resource.title')" :crumbs="[{ label: t('admin.section.content') }]">
      <template #actions>
        <button class="btn ghost" disabled :title="t('resource.import')">{{ t('resource.import') }}</button>
        <NuxtLink v-if="hasScope('course.create')" to="/admin/resources/new" class="btn primary">{{ t('resource.add') }}</NuxtLink>
      </template>
    </PageHeader>

    <p v-if="list" class="found">{{ t('resource.found', { n: list.total }) }}</p>

    <div class="filters">
      <div class="chips" role="tablist">
        <button v-for="s in STATUS_TABS" :key="s" role="tab" :aria-selected="status === s" :class="['chip', { on: status === s }]" @click="status = s">
          {{ s === 'all' ? t('resource.filter.all') : t(`resource.status.${s}`) }}<template v-if="list?.counts && s !== 'all'"> · {{ list.counts[s] ?? 0 }}</template>
        </button>
      </div>
      <div class="selects">
        <select v-model="kind" class="field" :aria-label="t('resource.filter.kind')">
          <option value="">{{ t('resource.filter.kind') }}</option>
          <option v-for="k in RESOURCE_KINDS" :key="k" :value="k">{{ t(`resource.kind.${k}`) }}</option>
        </select>
        <select v-model="authorId" class="field" :aria-label="t('resource.filter.author')">
          <option value="">{{ t('resource.filter.author') }}</option>
          <option v-for="a in authors" :key="a.id" :value="a.id">{{ a.fullName }}</option>
        </select>
        <select v-model="tag" class="field" :aria-label="t('resource.filter.tag')">
          <option value="">{{ t('resource.filter.tag') }}</option>
          <option v-for="tg in tags" :key="tg" :value="tg">{{ tg }}</option>
        </select>
        <select v-model="categoryId" class="field" :aria-label="t('resource.filter.category')">
          <option value="">{{ t('resource.filter.category') }}</option>
          <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
        <input v-model="q" class="field" type="search" :placeholder="t('resource.filter.search')" :aria-label="t('resource.filter.search')">
      </div>
    </div>

    <p v-if="error" class="error-text">{{ error }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('resource.col.title') }}</th><th>{{ t('resource.col.kind') }}</th><th>{{ t('resource.col.author') }}</th>
            <th>{{ t('resource.col.tags') }}</th><th>{{ t('resource.col.updated') }}</th><th>{{ t('resource.col.published') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in list?.items ?? []" :key="r.id" class="row" tabindex="0" @click="navigateTo(`/admin/resources/${r.id}`)" @keydown.enter="navigateTo(`/admin/resources/${r.id}`)">
            <td>
              <b>{{ r.title }}</b>
              <span class="sub">
                <template v-if="r.categoryIds.length">{{ r.categoryIds.map(catName).filter(Boolean).join(', ') }}</template>
                <template v-if="r.usedInCourses"><template v-if="r.categoryIds.length"> · </template>{{ t('resource.usedIn', { n: r.usedInCourses }) }}</template>
              </span>
            </td>
            <td>{{ t(`resource.kind.${r.kind}`) }}</td>
            <td class="muted">{{ r.authors.map(a => shortName(a.fullName)).join(', ') }}</td>
            <td><span v-for="tg in r.tags" :key="tg" class="badge muted tag">{{ tg }}</span></td>
            <td class="muted">{{ new Date(r.updatedAt).toLocaleDateString('uk') }}</td>
            <td><span :class="['badge upper', r.status]">{{ t(`resource.status.${r.status}`) }}</span></td>
          </tr>
          <tr v-if="list && list.items.length === 0"><td colspan="6" class="empty">{{ t('resource.empty') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="pages > 1" class="pager">
      <button class="chip" :disabled="page <= 1" @click="page--">←</button>
      <span class="muted">{{ page }} / {{ pages }}</span>
      <button class="chip" :disabled="page >= pages" @click="page++">→</button>
    </div>
  </div>
</template>

<style scoped>
.found { margin: 0 0 var(--space-3); font-weight: 700; color: var(--color-ink-muted); }
.filters { display: grid; gap: var(--space-3); margin-bottom: var(--space-3); }
.selects { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-2); }
.row { cursor: pointer; }
.row:hover td, .row:focus-visible td { background: var(--color-bg-line-soft); }
.tag { margin-right: var(--space-1); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.pager { display: flex; align-items: center; gap: var(--space-3); justify-content: center; margin-top: var(--space-3); }
</style>

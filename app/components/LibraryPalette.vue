<script setup lang="ts">
import type { LibraryTypeIcon } from '#shared/domain/library'

/**
 * Палитра «Бібліотека модулів ▸» (docs/v2/31 §5.4, Г-31.1): поле поиска, до 8 последних
 * использованных модулей, «Показати всі» → таблица библиотеки в режиме выбора. В строке —
 * иконка типа, название, «v4», «5 хв». Архивных модулей и черновиков здесь нет: вставляется
 * опубликованная версия (§7.6, критерий 4). Поиск и отбор — на сервере (`GET /library/modules`,
 * `GET /library/modules/recent`); палитра только показывает и возвращает выбранную карточку.
 */
export interface PaletteModule {
  id: string
  title: string
  contentKind: string
  typeIcon: LibraryTypeIcon
  estimatedMinutes: number | null
  categoryName: string | null
  ownerName: string | null
  summary: string | null
  status: string
  currentVersion: { id: string, version: number, publishedAt: string } | null
}

const emit = defineEmits<{ pick: [module: PaletteModule], close: [] }>()
const { t } = useI18n()
const { api } = useApi()
const { formatShortDate } = useFormat()

const KINDS = ['article', 'file', 'video', 'link'] as const

const q = ref('')
const items = ref<PaletteModule[] | null>(null)
const error = ref('')
const showAll = ref(false)
const all = reactive({ q: '', kind: '', items: [] as PaletteModule[], cursor: null as string | null, loading: false, error: '', loaded: false })
const searchEl = ref<HTMLInputElement | null>(null)
const allSearchEl = ref<HTMLInputElement | null>(null)

let timer: ReturnType<typeof setTimeout> | undefined
async function loadPalette() {
  error.value = ''
  items.value = null
  const text = q.value.trim()
  try {
    items.value = text
      ? (await api<{ items: PaletteModule[] }>('/library/modules', { query: { status: 'published', q: text, limit: 25 } })).items
      : await api<PaletteModule[]>('/library/modules/recent')
  }
  catch (err) {
    error.value = apiErrorOf(err).message || t('library.palette.loadError')
    items.value = []
  }
}
watch(q, () => {
  clearTimeout(timer)
  timer = setTimeout(loadPalette, 250)
})
onMounted(() => {
  loadPalette()
  nextTick(() => searchEl.value?.focus())
})
onBeforeUnmount(() => clearTimeout(timer))

async function loadAll(more = false) {
  all.loading = true
  all.error = ''
  try {
    const r = await api<{ items: PaletteModule[], nextCursor: string | null }>('/library/modules', {
      query: { status: 'published', limit: 25, ...(all.q.trim() ? { q: all.q.trim() } : {}), ...(all.kind ? { kind: all.kind } : {}), ...(more && all.cursor ? { cursor: all.cursor } : {}) },
    })
    all.items = more ? [...all.items, ...r.items] : r.items
    all.cursor = r.nextCursor
  }
  catch (err) {
    all.error = apiErrorOf(err).message || t('library.palette.loadError')
  }
  finally {
    all.loading = false
    all.loaded = true
  }
}
function openAll() {
  showAll.value = true
  all.q = q.value
  loadAll()
  nextTick(() => allSearchEl.value?.focus())
}
let allTimer: ReturnType<typeof setTimeout> | undefined
watch(() => [all.q, all.kind], () => {
  if (!showAll.value) return
  clearTimeout(allTimer)
  allTimer = setTimeout(() => loadAll(), 250)
})

function pick(m: PaletteModule) {
  emit('pick', m)
}
function onKey(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return
  ev.stopPropagation()
  if (showAll.value) showAll.value = false
  else emit('close')
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown="onKey">
    <section v-if="!showAll" class="palette card" role="dialog" aria-modal="true" aria-labelledby="lib-palette-title" data-testid="library-palette">
      <header class="head">
        <h2 id="lib-palette-title" class="panel-title">{{ t('library.palette.title') }}</h2>
        <button class="chip" type="button" :aria-label="t('common.close')" @click="emit('close')">×</button>
      </header>
      <input ref="searchEl" v-model="q" class="field" type="search" :placeholder="t('library.palette.search')" :aria-label="t('library.palette.search')">
      <p class="sub-title">{{ q.trim() ? t('library.palette.results') : t('library.palette.recent') }}</p>

      <p v-if="error" class="error-text" role="alert">
        {{ error }} <button class="link-btn" type="button" @click="loadPalette">{{ t('library.palette.retry') }}</button>
      </p>
      <p v-else-if="items === null" class="muted" aria-live="polite">{{ t('common.loading') }}</p>
      <template v-else-if="!items.length">
        <p v-if="q.trim()" class="muted" aria-live="polite">
          {{ t('library.palette.nothing', { q: q.trim() }) }}
          <button class="link-btn" type="button" @click="q = ''">{{ t('library.palette.clear') }}</button>
        </p>
        <p v-else class="muted">{{ t('library.palette.noRecent') }}</p>
      </template>
      <ul v-else class="list">
        <li v-for="m in items" :key="m.id">
          <button class="row" type="button" :data-testid="`library-pick-${m.id}`" @click="pick(m)">
            <LibraryTypeIcon :icon="m.typeIcon" />
            <span class="name">{{ m.title }}</span>
            <span class="meta">
              <span v-if="m.currentVersion">v{{ m.currentVersion.version }}</span>
              <span v-if="m.estimatedMinutes">{{ t('library.palette.minutes', { n: m.estimatedMinutes }) }}</span>
            </span>
          </button>
        </li>
      </ul>
      <button class="link-btn show-all" type="button" @click="openAll">{{ t('library.palette.showAll') }}</button>
    </section>

    <section v-else class="all card" role="dialog" aria-modal="true" aria-labelledby="lib-all-title">
      <header class="head">
        <h2 id="lib-all-title" class="panel-title">{{ t('library.palette.allTitle') }}</h2>
        <button class="chip" type="button" :aria-label="t('common.close')" @click="showAll = false">×</button>
      </header>
      <div class="filters">
        <input ref="allSearchEl" v-model="all.q" class="field" type="search" :placeholder="t('library.palette.search')" :aria-label="t('library.palette.search')">
        <select v-model="all.kind" class="field" :aria-label="t('library.palette.col.type')">
          <option value="">{{ t('library.palette.kindAll') }}</option>
          <option v-for="k in KINDS" :key="k" :value="k">{{ t(`resource.kind.${k}`) }}</option>
        </select>
      </div>
      <p v-if="all.error" class="error-text" role="alert">
        {{ all.error }} <button class="link-btn" type="button" @click="loadAll()">{{ t('library.palette.retry') }}</button>
      </p>
      <p v-else-if="all.loaded && !all.items.length" class="muted" aria-live="polite">
        <template v-if="all.q.trim()">
          {{ t('library.palette.nothing', { q: all.q.trim() }) }}
          <button class="link-btn" type="button" @click="all.q = ''">{{ t('library.palette.clear') }}</button>
        </template>
        <template v-else>{{ t('library.palette.empty') }}</template>
      </p>
      <div v-else class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">{{ t('library.palette.col.type') }}</th>
              <th scope="col">{{ t('library.palette.col.title') }}</th>
              <th scope="col" class="wide">{{ t('library.palette.col.category') }}</th>
              <th scope="col">{{ t('library.palette.col.version') }}</th>
              <th scope="col" class="wide">{{ t('library.palette.col.owner') }}</th>
              <th scope="col"><span class="sr-only">{{ t('library.palette.pick') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in all.items" :key="m.id">
              <td><LibraryTypeIcon :icon="m.typeIcon" /></td>
              <td>{{ m.title }}<span v-if="m.summary" class="sub">{{ m.summary }}</span></td>
              <td class="wide">{{ m.categoryName ?? '—' }}</td>
              <td class="nowrap">{{ m.currentVersion ? t('library.palette.versionAt', { v: m.currentVersion.version, date: formatShortDate(new Date(m.currentVersion.publishedAt)) }) : '—' }}</td>
              <td class="wide">{{ m.ownerName ?? '—' }}</td>
              <td><button class="btn primary small" type="button" @click="pick(m)">{{ t('library.palette.pick') }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="all.loading" class="muted" aria-live="polite">{{ t('common.loading') }}</p>
      <button v-if="all.cursor && !all.loading" class="btn ghost" type="button" @click="loadAll(true)">{{ t('common.loadMore') }}</button>
    </section>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.palette, .all { display: grid; gap: var(--space-3); box-sizing: border-box; background: var(--color-bg-soft); }
.palette { width: min(440px, 100%); }
.all { width: min(880px, 100%); }
.head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); }
.head .panel-title { margin: 0; }
.sub-title { margin: 0; font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-ink-muted); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); max-height: 50vh; overflow: auto; }
.row { width: 100%; display: flex; align-items: center; gap: var(--space-2); font: inherit; text-align: left; background: var(--color-bg); color: var(--color-ink); border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); cursor: pointer; }
.row:hover { border-color: var(--color-ink); }
.name { flex: 1; min-width: 0; font-weight: 800; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { display: flex; gap: var(--space-2); font-size: var(--font-size-body-s); color: var(--color-ink-muted); white-space: nowrap; }
.link-btn { font: inherit; color: inherit; background: none; border: none; padding: 0; cursor: pointer; text-decoration: underline; }
.show-all { justify-self: start; font-weight: 800; }
.filters { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.filters .field { flex: 1 1 200px; }
.nowrap { white-space: nowrap; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 640px) { .wide { display: none; } }
</style>

<script setup lang="ts">
/**
 * Переклади (мокап Translations, docs/24 §3.6): Мова · Тільки змінені · поиск; колонки Ключ · Стандартний ·
 * Свій · Хто · Дата; «Повернути стандартний» на строке и на всём наборе; экспорт и импорт json.
 */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t, locale: uiLocale } = useI18n()
const { api } = useApi()

interface Row { key: string, standard: string | null, custom: string | null, updatedBy: string | null, updatedAt: string | null }
const locale = ref<'uk' | 'en' | 'ru'>('uk')
const changedOnly = ref(false)
const q = ref('')
const page = ref(1)
const rows = ref<Row[]>([])
const total = ref(0)
const changed = ref(0)
const editing = ref<string | null>(null)
const draft = ref('')
const error = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const PER = 50

async function load() {
  error.value = ''
  try {
    const r = await api<{ items: Row[], total: number, changed: number }>('/settings/translations', { query: { locale: locale.value, q: q.value || undefined, changedOnly: changedOnly.value || undefined, page: page.value, perPage: PER } })
    rows.value = r.items; total.value = r.total; changed.value = r.changed
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch([locale, changedOnly], () => { page.value = 1; load() })
let timer: ReturnType<typeof setTimeout> | undefined
watch(q, () => { clearTimeout(timer); timer = setTimeout(() => { page.value = 1; load() }, 300) })
watch(page, load)

function startEdit(r: Row) { editing.value = r.key; draft.value = r.custom ?? r.standard ?? '' }
async function saveEdit(r: Row) {
  if (!draft.value.trim()) return
  try {
    await api('/settings/translations', { method: 'PUT', body: { locale: locale.value, key: r.key, value: draft.value } })
    editing.value = null; await load()
    if (locale.value === uiLocale.value) reloadNuxtApp({ persistState: true })
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function reset(r: Row) {
  try { await api('/settings/translations', { method: 'DELETE', query: { locale: locale.value, key: r.key } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function resetAll() {
  if (!confirm(t('settings.translations.confirmResetAll'))) return
  try { await api('/settings/translations', { method: 'DELETE', query: { locale: locale.value } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
function exportJson() { window.open(`/api/v1/settings/translations/export?locale=${locale.value}`, '_blank') }
async function importJson(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    const items = JSON.parse(await f.text()) as Record<string, string>
    const r = await api<{ set: number, reset: number, skipped: string[] }>('/settings/translations/import', { method: 'POST', body: { locale: locale.value, items } })
    error.value = r.skipped.length ? t('settings.translations.skipped', { n: r.skipped.length }) : ''
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message || t('settings.translations.badJson') }
  finally { if (fileInput.value) fileInput.value.value = '' }
}
const fmtDate = (s: string | null) => s ? formatShortDate(new Date(s)) : ''
const pages = computed(() => Math.max(1, Math.ceil(total.value / PER)))
</script>

<template>
  <div>
    <PageHeader :title="t('settings.translations.title')" :subtitle="t('settings.translations.hint')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('settings.translations.title') }]">
      <template #actions>
        <button class="btn ghost" type="button" @click="exportJson">{{ t('settings.translations.export') }}</button>
        <button class="btn ghost" type="button" @click="fileInput?.click()">{{ t('settings.translations.import') }}</button>
        <input ref="fileInput" type="file" accept="application/json" class="hidden-input" :aria-label="t('settings.translations.import')" @change="importJson">
      </template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div class="filters">
      <label class="label" for="tr-locale">{{ t('settings.translations.locale') }}</label>
      <select id="tr-locale" v-model="locale" class="field short"><option value="uk">Українська</option><option value="en">English</option><option value="ru">Русский</option></select>
      <label class="toggle"><input v-model="changedOnly" type="checkbox"><span>{{ t('settings.translations.changedOnly') }} · {{ changed }}</span></label>
      <input v-model="q" class="field grow" type="search" :placeholder="t('common.search')" :aria-label="t('common.search')">
      <button class="btn ghost small" type="button" :disabled="!changed" @click="resetAll">{{ t('settings.translations.resetAll') }}</button>
    </div>

    <div class="table-wrap card">
      <table class="table">
        <thead><tr><th>{{ t('settings.translations.key') }}</th><th>{{ t('settings.translations.standard') }}</th><th>{{ t('settings.translations.custom') }}</th><th>{{ t('settings.translations.who') }}</th><th>{{ t('settings.translations.date') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key" :class="{ changed: r.custom }">
            <td><code>{{ r.key }}</code></td>
            <td class="muted">{{ r.standard }}</td>
            <td>
              <template v-if="editing === r.key">
                <input v-model="draft" class="field" maxlength="2000" :aria-label="t('settings.translations.custom')" @keydown.enter="saveEdit(r)" @keydown.esc="editing = null">
              </template>
              <button v-else type="button" class="cell-btn" @click="startEdit(r)">{{ r.custom ?? '—' }}</button>
            </td>
            <td>{{ r.updatedBy ?? '' }}</td>
            <td>{{ fmtDate(r.updatedAt) }}</td>
            <td class="acts">
              <template v-if="editing === r.key">
                <button class="btn primary small" type="button" @click="saveEdit(r)">{{ t('common.save') }}</button>
                <button class="btn ghost small" type="button" @click="editing = null">{{ t('common.cancel') }}</button>
              </template>
              <button v-else-if="r.custom" class="btn ghost small" type="button" @click="reset(r)">{{ t('settings.translations.reset') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="pages > 1" class="pager">
      <button class="btn ghost small" type="button" :disabled="page <= 1" @click="page--">‹</button>
      <span>{{ page }} / {{ pages }}</span>
      <button class="btn ghost small" type="button" :disabled="page >= pages" @click="page++">›</button>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
.short { width: auto; }
.grow { flex: 1 1 200px; }
.hidden-input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.cell-btn { font: inherit; border: none; background: transparent; text-align: left; cursor: pointer; color: var(--color-ink); padding: 0; }
tr.changed td:first-child { border-left: 3px solid var(--color-teal); }
.acts { white-space: nowrap; }
.pager { display: flex; gap: var(--space-2); align-items: center; justify-content: center; margin-top: var(--space-3); }
</style>

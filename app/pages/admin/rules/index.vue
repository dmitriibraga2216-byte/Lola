<script setup lang="ts">
/**
 * Правила автоматизації по мокапу AutomationRules: НАЗВА · АУДИТОРІЯ · ВІДКЛАДЕННЯ · ВИКОРИСТАННЯ · СТВОРЕНО · ОПУБЛІКОВАНО,
 * «Створити правило». Правило — именованная аудитория по четырём измерениям (docs/17 §14, §14.2).
 */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()
interface Dim { dimension: string, mode: string, values: { id: string, name: string }[] }
interface Rule { id: string, name: string, isActive: boolean, assignDelayDays: number, createdAt: string, dimensions: Dim[], usedBy: { kind: string, id: string, title: string }[] }
const items = ref<Rule[]>([])
const error = ref('')
async function load() { try { items.value = await api('/automation-rules') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
/** «Одеса · Бариста» — значения включающих измерений; «Всі, окрім …» для исключающих; пусто — «Будь-яка посада». */
function audience(r: Rule) {
  const parts = r.dimensions.filter(d => d.mode !== 'any' && d.values.length).map(d => `${d.mode === 'exclude' ? `${t('rules.allExcept')} ` : ''}${d.values.map(v => v.name).join(', ')}`)
  return parts.length ? parts.join(' · ') : t('rules.anyPosition')
}
function usage(r: Rule) {
  const n = (k: string) => r.usedBy.filter(u => u.kind === k).length
  const parts = [n('trajectory') ? t('rules.usedTrajectories', { n: n('trajectory') }) : '', n('program') ? t('rules.usedPrograms', { n: n('program') }) : '', n('assignment') ? t('rules.usedTasks', { n: n('assignment') }) : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : '—'
}
const fmt = (d: string) => formatShortDate(new Date(d))
</script>

<template>
  <div>
    <PageHeader :title="t('admin.nav.rules')" :crumbs="[{ label: t('admin.section.learning') }]">
      <template #actions><NuxtLink to="/admin/rules/new" class="btn primary" data-testid="rule-create">{{ t('rules.create') }}</NuxtLink></template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('rules.col.audience') }}</th><th>{{ t('rules.col.delay') }}</th><th>{{ t('rules.col.usage') }}</th><th>{{ t('rules.col.created') }}</th><th>{{ t('rules.col.published') }}</th></tr></thead>
        <tbody>
          <tr v-for="r in items" :key="r.id" class="row-link" tabindex="0" @click="navigateTo(`/admin/rules/${r.id}`)" @keydown.enter="navigateTo(`/admin/rules/${r.id}`)">
            <td><b>{{ r.name }}</b></td>
            <td class="muted">{{ audience(r) }}</td>
            <td class="muted">{{ r.assignDelayDays ? t('rules.daysN', { n: r.assignDelayDays }) : '—' }}</td>
            <td class="muted">{{ usage(r) }}</td>
            <td class="muted">{{ fmt(r.createdAt) }}</td>
            <td><span :class="['badge', r.isActive ? 'teal' : 'muted']">{{ r.isActive ? t('rules.published') : t('rules.unpublished') }}</span></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="6" class="empty">{{ t('rules.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.row-link { cursor: pointer; }
.row-link:hover td, .row-link:focus-visible td { background: var(--color-bg-line-soft); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
</style>

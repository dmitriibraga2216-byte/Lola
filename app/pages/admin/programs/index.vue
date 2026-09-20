<script setup lang="ts">
/**
 * Навчальні програми по мокапу ContentPrograms: НАЗВА (N елементів) · ТРИВАЛІСТЬ · АВТОР · ДАТА ЗМІНИ · ОПУБЛІКОВАНО,
 * кнопка «Додати». Программа — упорядоченный набор без условий (docs/17 Г-17.3); маршруты с условиями — траектории.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'program.manage' })
const { t } = useI18n()
const { api } = useApi()
interface P { id: string, title: string, mode: string, status: string, due_days: number | null, items: number, active_people: number, completed_people: number, updated_at: string, published_at: string | null, updated_by_name: string | null }
const items = ref<P[]>([])
const error = ref('')
const creating = ref(false)
const title = ref('')
async function load() { try { items.value = await api('/programs?all=true') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function create() {
  try { const p = await api<{ id: string }>('/programs', { method: 'POST', body: { title: title.value, mode: 'linear' } }); await navigateTo(`/admin/programs/${p.id}`) } catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk-UA') : '—'
function shortName(name: string | null) {
  if (!name) return '—'
  const [last, first] = name.split(' ')
  return first ? `${last} ${first[0]}.` : last
}
</script>
<template>
  <div>
    <PageHeader :title="t('prog.adminTitle')" :crumbs="[{ label: t('admin.section.content') }]">
      <template #actions>
        <NuxtLink to="/admin/trajectories" class="btn ghost">{{ t('traj.title') }}</NuxtLink>
        <button class="btn primary" data-testid="prog-create" @click="creating = !creating">{{ t('prog.add') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>
    <form v-if="creating" class="card new" @submit.prevent="create">
      <label class="label" for="prog-title">{{ t('traj.name') }}</label>
      <div class="row">
        <input id="prog-title" v-model="title" class="field" :placeholder="t('prog.titlePh')" data-testid="prog-title" minlength="3" required>
        <button class="btn primary" type="submit" :disabled="title.trim().length < 3">{{ t('common.save') }}</button>
        <button class="btn ghost" type="button" @click="creating = false">{{ t('common.cancel') }}</button>
      </div>
    </form>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('prog.col.duration') }}</th><th>{{ t('assign.col.author') }}</th><th>{{ t('traj.col.updated') }}</th><th>{{ t('traj.col.published') }}</th></tr></thead>
        <tbody>
          <tr v-for="p in items" :key="p.id" class="row-link" tabindex="0" @click="navigateTo(`/admin/programs/${p.id}`)" @keydown.enter="navigateTo(`/admin/programs/${p.id}`)">
            <td><b>{{ p.title }}</b><span class="sub">{{ t('prog.itemsCount', { n: p.items }) }}<template v-if="p.mode === 'graph'"> · {{ t('prog.modes.graph') }}</template> · {{ p.active_people }} / {{ p.completed_people }}</span></td>
            <td class="muted">{{ p.due_days ? t('rules.daysN', { n: p.due_days }) : '—' }}</td>
            <td class="muted">{{ shortName(p.updated_by_name) }}</td>
            <td class="muted">{{ fmt(p.updated_at) }}</td>
            <td><span :class="['badge', p.status === 'published' ? 'teal' : p.status]">{{ p.status === 'published' ? fmt(p.published_at) : t(`course.status.${p.status}`) }}</span></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="5" class="empty">{{ t('prog.adminEmpty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
<style scoped>
.new { margin-bottom: var(--space-4); }
.row { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.row .field { flex: 1; min-width: 200px; }
.row-link { cursor: pointer; }
.row-link:hover td, .row-link:focus-visible td { background: var(--color-bg-line-soft); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
</style>

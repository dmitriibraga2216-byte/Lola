<script setup lang="ts">
/**
 * Траєкторії навчання по мокапу Trajectories: НАЗВА · СКЛАД · РЕЖИМ ПРИЗНАЧЕННЯ · ЛЮДЕЙ · ДАТА ЗМІНИ · ОПУБЛІКОВАНО,
 * кнопка «Створити траєкторію» (docs/17 §14.1).
 */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'program.manage' })
const { t } = useI18n()
const { api } = useApi()

interface Row { id: string, title: string, status: string, assignMode: string, ruleName: string | null, updatedAt: string, publishedAt: string | null, blocks: number, people: number, done: number }
const items = ref<Row[]>([])
const error = ref('')
const creating = ref(false)
const title = ref('')

async function load() { try { items.value = await api('/trajectories') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function create() {
  error.value = ''
  try { const t = await api<{ id: string }>('/trajectories', { method: 'POST', body: { title: title.value, tags: [] } }); await navigateTo(`/admin/trajectories/${t.id}`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
const fmt = (d: string | null) => d ? formatShortDate(new Date(d)) : '—'
const modeLabel = (r: Row) => r.assignMode === 'automation' && r.ruleName ? t('traj.ruleChip', { name: r.ruleName }) : t(`traj.assignMode.${r.assignMode}`)
</script>

<template>
  <div>
    <PageHeader :title="t('traj.title')" :crumbs="[{ label: t('admin.section.learning') }]">
      <template #actions>
        <button class="btn primary" data-testid="traj-create" @click="creating = !creating">{{ t('traj.create') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>

    <form v-if="creating" class="card new" @submit.prevent="create">
      <label class="label" for="traj-title">{{ t('traj.name') }}</label>
      <div class="row">
        <input id="traj-title" v-model="title" class="field" :placeholder="t('traj.namePh')" data-testid="traj-title" minlength="3" required>
        <button class="btn primary" type="submit" :disabled="title.trim().length < 3">{{ t('common.save') }}</button>
        <button class="btn ghost" type="button" @click="creating = false">{{ t('common.cancel') }}</button>
      </div>
    </form>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr><th>{{ t('traj.col.title') }}</th><th>{{ t('traj.col.blocks') }}</th><th>{{ t('traj.col.assignMode') }}</th><th>{{ t('traj.col.people') }}</th><th>{{ t('traj.col.updated') }}</th><th>{{ t('traj.col.published') }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in items" :key="r.id" class="row-link" tabindex="0" @click="navigateTo(`/admin/trajectories/${r.id}`)" @keydown.enter="navigateTo(`/admin/trajectories/${r.id}`)">
            <td><b>{{ r.title }}</b></td>
            <td class="muted">{{ t('traj.blocksN', { n: r.blocks }) }}</td>
            <td><span class="badge">{{ modeLabel(r) }}</span></td>
            <td class="num">{{ r.people }}<span v-if="r.done" class="teal"> · {{ r.done }}</span></td>
            <td class="muted">{{ fmt(r.updatedAt) }}</td>
            <td><span :class="['badge', r.status === 'published' ? 'teal' : '']">{{ r.status === 'published' ? fmt(r.publishedAt) : t('traj.draft') }}</span></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="6" class="empty">{{ t('traj.empty') }}</td></tr>
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
.teal { color: var(--color-teal-ink); font-weight: 700; }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
</style>

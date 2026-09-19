<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'program.manage' })
const { t } = useI18n()
const { api } = useApi()
interface P { id: string, title: string, mode: string, status: string, tags: string[], assignment_mode: string[], rule_name: string | null, items: number, active_people: number, completed_people: number, updated_at: string, updated_by_name: string | null }
const items = ref<P[]>([])
const error = ref('')
const form = reactive({ title: '', mode: 'linear' })
async function load() { try { items.value = await api('/programs?all=true') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function create() {
  try { const p = await api<{ id: string }>('/programs', { method: 'POST', body: { title: form.title, mode: form.mode } }); await navigateTo(`/admin/programs/${p.id}`) } catch (err) { error.value = apiErrorOf(err).message }
}
async function duplicate(p: P) { await api(`/programs/${p.id}/duplicate`, { method: 'POST' }); await load() }
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.programs') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('prog.mode') }}</th><th>{{ t('prog.items') }}</th><th>{{ t('prog.assignMode') }}</th><th>{{ t('prog.people') }}</th><th>{{ t('assign.col.status') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="p in items" :key="p.id">
          <td><NuxtLink :to="`/admin/programs/${p.id}`" class="link">{{ p.title }}</NuxtLink><div class="sub">{{ p.updated_by_name ?? '' }} · {{ new Date(p.updated_at).toLocaleDateString('uk-UA') }}</div></td>
          <td class="sub">{{ t(`prog.modes.${p.mode}`) }}</td><td>{{ p.items }}</td>
          <td class="sub">{{ p.assignment_mode.map(m => t(`prog.assign.${m}`)).join(', ') }}<template v-if="p.rule_name"> · {{ p.rule_name }}</template></td>
          <td>{{ p.active_people }} / {{ p.completed_people }}</td>
          <td><span :class="['badge', p.status]">{{ t(`course.status.${p.status}`) }}</span></td>
          <td><NuxtLink :to="`/admin/programs/${p.id}/report`" class="chip">{{ t('prog.report') }}</NuxtLink> <button class="chip" @click="duplicate(p)">{{ t('prog.duplicate') }}</button></td>
        </tr>
      </tbody>
    </table>
    <section class="card">
      <h2>{{ t('prog.new') }}</h2>
      <div class="row">
        <input v-model="form.title" class="field grow" :placeholder="t('prog.titlePh')" data-testid="prog-title">
        <label class="check"><input v-model="form.mode" type="radio" value="linear"> {{ t('prog.modes.linear') }}</label>
        <label class="check"><input v-model="form.mode" type="radio" value="graph"> {{ t('prog.modes.graph') }}</label>
        <button class="primary" :disabled="form.title.length < 3" data-testid="prog-create" @click="create">{{ t('common.save') }}</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.link { color: var(--color-ink); font-weight: 700; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.grow { flex: 1; min-width: 160px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; text-decoration: none; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
</style>

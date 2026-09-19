<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.manage' })
const { t } = useI18n()
const { api } = useApi()
interface S { code: string, name: string, color: string, sort: number, isInitial: boolean, isFinal: boolean, isSuccess: boolean, requiresComment: boolean, allowedTransitions: string[], whoCanSet: string[] }
const items = ref<S[]>([])
const error = ref('')
const notice = ref('')
const form = reactive<S>({ code: '', name: '', color: 'muted', sort: 50, isInitial: false, isFinal: false, isSuccess: false, requiresComment: false, allowedTransitions: [], whoCanSet: ['development.own', 'development.team'] })
async function load() { try { items.value = await api<S[]>('/development/goal-statuses') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
function edit(s: S) { Object.assign(form, { ...s, allowedTransitions: [...s.allowedTransitions], whoCanSet: [...s.whoCanSet] }) }
async function save() {
  error.value = ''; notice.value = ''
  try { await api('/development/goal-statuses', { method: 'PUT', body: form }); notice.value = t('common.saved'); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.goalStatuses') }}</h1>
    <p class="sub">{{ t('dev.statusesHint') }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <table class="table">
      <thead><tr><th>#</th><th>{{ t('dev.statusName') }}</th><th>{{ t('dev.transitions') }}</th><th>{{ t('dev.whoCanSet') }}</th><th>{{ t('dev.flags') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="s in items" :key="s.code">
          <td>{{ s.sort }}</td>
          <td><span :class="['badge', s.color]">{{ s.name }}</span><div class="sub">{{ s.code }}</div></td>
          <td class="sub">{{ s.allowedTransitions.join(', ') || '—' }}</td>
          <td class="sub">{{ s.whoCanSet.map(w => t(`dev.who.${w.split('.')[1]}`)).join(', ') }}</td>
          <td class="sub">{{ [s.isInitial && t('dev.flag.initial'), s.isFinal && t('dev.flag.final'), s.isSuccess && t('dev.flag.success'), s.requiresComment && t('dev.flag.comment')].filter(Boolean).join(', ') }}</td>
          <td><button class="chip" @click="edit(s)">{{ t('common.edit') }}</button></td>
        </tr>
      </tbody>
    </table>
    <section class="card">
      <h2>{{ t('dev.statusForm') }}</h2>
      <div class="row">
        <input v-model="form.code" class="field" placeholder="code" pattern="[a-z_]+">
        <input v-model="form.name" class="field grow" :placeholder="t('dev.statusName')">
        <select v-model="form.color" class="field"><option v-for="c in ['sun', 'teal', 'coral', 'muted']" :key="c" :value="c">{{ c }}</option></select>
        <input v-model.number="form.sort" class="field short" type="number" min="0" max="99">
      </div>
      <div class="row">
        <label class="check"><input v-model="form.isInitial" type="checkbox"> {{ t('dev.flag.initial') }}</label>
        <label class="check"><input v-model="form.isFinal" type="checkbox"> {{ t('dev.flag.final') }}</label>
        <label class="check"><input v-model="form.isSuccess" type="checkbox"> {{ t('dev.flag.success') }}</label>
        <label class="check"><input v-model="form.requiresComment" type="checkbox"> {{ t('dev.flag.comment') }}</label>
      </div>
      <div class="row"><span class="sub">{{ t('dev.transitions') }}:</span><label v-for="s in items" :key="s.code" class="check"><input v-model="form.allowedTransitions" type="checkbox" :value="s.code"> {{ s.name }}</label></div>
      <div class="row"><span class="sub">{{ t('dev.whoCanSet') }}:</span><label v-for="w in ['development.own', 'development.team', 'development.manage']" :key="w" class="check"><input v-model="form.whoCanSet" type="checkbox" :value="w"> {{ t(`dev.who.${w.split('.')[1]}`) }}</label></div>
      <button class="primary" :disabled="!form.code || !form.name || form.whoCanSet.length === 0" @click="save">{{ t('common.save') }}</button>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-2); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin: var(--space-3) 0 var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.teal { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.coral { background: var(--color-coral); color: var(--color-coral-deep); }
.badge.sun { background: var(--color-sun); color: var(--color-sun-ink); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>

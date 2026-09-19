<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'competency.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Level { level: number, title: string, behavior: string }
interface C { id: string, name: string, kind: string, description: string | null, levels: Level[], linkedCourses: string[], isActive: boolean, categoryId: string | null }
interface Cat { id: string, name: string, sort: number }
const items = ref<C[]>([])
const courses = ref<{ id: string, title: string }[]>([])
const categories = ref<Cat[]>([])
const newCategory = ref('')
const catFilter = ref('')
const error = ref('')
const editing = ref<string | null>(null)
const blank = () => ({ name: '', kind: 'hard', description: '', categoryId: '', levels: [1, 2, 3].map(n => ({ level: n, title: '', behavior: '' })) as Level[], linkedCourses: [] as string[] })
const form = reactive(blank())

async function load() {
  try { items.value = await api<C[]>('/competencies'); courses.value = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(c => c.status === 'published'); categories.value = await api<Cat[]>('/competency-categories') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
function edit(c: C) { editing.value = c.id; Object.assign(form, { name: c.name, kind: c.kind, description: c.description ?? '', categoryId: c.categoryId ?? '', levels: c.levels.map(l => ({ ...l })), linkedCourses: [...c.linkedCourses] }) }
const visible = computed(() => catFilter.value ? items.value.filter(i => i.categoryId === catFilter.value) : items.value)
const catName = (id: string | null) => categories.value.find(c => c.id === id)?.name ?? ''
async function addCategory() { if (!newCategory.value.trim()) return; try { await api('/competency-categories', { method: 'PUT', body: { name: newCategory.value.trim(), sort: categories.value.length } }); newCategory.value = ''; await load() } catch (err) { error.value = apiErrorOf(err).message } }
async function removeCategory(c: Cat) { if (!confirm(t('dev.deleteCategory', { name: c.name }))) return; try { await api(`/competency-categories/${c.id}`, { method: 'DELETE' }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
function reset() { editing.value = null; Object.assign(form, blank()) }
async function save() {
  error.value = ''
  const body = { ...form, description: form.description || undefined, categoryId: form.categoryId || undefined, levels: form.levels.filter(l => l.title.trim() && l.behavior.trim()) }
  try {
    if (editing.value) await api(`/competencies/${editing.value}`, { method: 'PATCH', body })
    else await api('/competencies', { method: 'POST', body })
    reset(); await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function toggle(c: C) { await api(`/competencies/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } }); await load() }
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.competencies') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <section class="cats">
      <button :class="['chip', { on: !catFilter }]" @click="catFilter = ''">{{ t('dev.allCategories') }}</button>
      <span v-for="c in categories" :key="c.id" class="cat"><button :class="['chip', { on: catFilter === c.id }]" @click="catFilter = c.id">{{ c.name }}</button><button class="chip x" :aria-label="t('groups.delete')" @click="removeCategory(c)">×</button></span>
      <input v-model="newCategory" class="field" :placeholder="t('dev.newCategory')" @keyup.enter="addCategory">
      <button class="chip" :disabled="!newCategory.trim()" @click="addCategory">+</button>
    </section>
    <table class="table">
      <thead><tr><th>{{ t('dev.competency') }}</th><th>{{ t('dev.kindCol') }}</th><th>{{ t('dev.levels') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="c in visible" :key="c.id" :class="{ off: !c.isActive }">
          <td><b>{{ c.name }}</b><span v-if="c.categoryId" class="sub"> · {{ catName(c.categoryId) }}</span><div v-if="c.description" class="sub">{{ c.description }}</div></td>
          <td class="sub">{{ t(`dev.ckind.${c.kind}`) }}</td>
          <td class="sub">{{ c.levels.map(l => `${l.level} ${l.title}`).join(' · ') }}</td>
          <td class="acts"><button class="chip" @click="edit(c)">{{ t('common.edit') }}</button><button class="chip" @click="toggle(c)">{{ c.isActive ? t('common.deactivate') : t('common.activate') }}</button></td>
        </tr>
      </tbody>
    </table>
    <section class="card">
      <h2>{{ editing ? t('common.edit') : t('dev.newCompetency') }}</h2>
      <div class="row">
        <input v-model="form.name" class="field grow" :placeholder="t('dev.competencyName')" data-testid="comp-name">
        <select v-model="form.kind"><option v-for="k in ['hard', 'soft', 'managerial']" :key="k" :value="k">{{ t(`dev.ckind.${k}`) }}</option></select>
        <select v-model="form.categoryId" :aria-label="t('dev.category')"><option value="">{{ t('dev.category') }}: —</option><option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option></select>
      </div>
      <textarea v-model="form.description" class="field" rows="2" :placeholder="t('dev.competencyDesc')" />
      <div v-for="l in form.levels" :key="l.level" class="row">
        <span class="lvl">{{ l.level }}</span>
        <input v-model="l.title" class="field" :placeholder="t('dev.levelTitle')">
        <input v-model="l.behavior" class="field grow" :placeholder="t('dev.levelBehavior')">
      </div>
      <div class="row">
        <button v-if="form.levels.length < 5" class="chip" @click="form.levels.push({ level: form.levels.length + 1, title: '', behavior: '' })">+ {{ t('dev.level') }}</button>
        <button v-if="form.levels.length > 3" class="chip" @click="form.levels.pop()">− {{ t('dev.level') }}</button>
      </div>
      <label class="sub">{{ t('dev.linkedCourses') }}</label>
      <div class="row">
        <label v-for="c in courses" :key="c.id" class="check"><input v-model="form.linkedCourses" type="checkbox" :value="c.id"> {{ c.title }}</label>
      </div>
      <div class="row">
        <button class="primary" :disabled="form.name.length < 2 || form.levels.filter(l => l.title && l.behavior).length < 3" data-testid="comp-save" @click="save">{{ t('common.save') }}</button>
        <button v-if="editing" class="chip" @click="reset">{{ t('common.cancel') }}</button>
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
tr.off { opacity: 0.5; }
.acts { display: flex; gap: var(--space-1); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.grow { flex: 1; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.lvl { font-weight: 900; width: 20px; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.cats { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-3); }
.cat { display: inline-flex; }
.chip.on { background: var(--color-ink); color: var(--color-bg-soft); border-color: var(--color-ink); }
.chip.x { border-left: none; border-radius: 0 var(--radius-pill) var(--radius-pill) 0; }
</style>

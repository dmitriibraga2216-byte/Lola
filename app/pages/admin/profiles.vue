<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assignment.create' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Profile { id: string, name: string, scope: { positionIds: string[], locationIds: string[] }, items: { subjectId: string, dueDays: number, isMandatory: boolean }[], isActive: boolean, lastAppliedAt: string | null }
interface Ref { id: string, name: string }
interface Course { id: string, title: string, status: string }

const items = ref<Profile[]>([])
const positions = ref<Ref[]>([])
const courses = ref<Course[]>([])
const error = ref('')
const notice = ref('')
const previewOf = ref<{ id: string, count: number, items: number } | null>(null)

const form = reactive({ name: '', positionIds: [] as string[], items: [] as { subjectId: string, dueDays: number, isMandatory: boolean }[] })

async function load() {
  try {
    const [p, pos, c] = await Promise.all([api<Profile[]>('/learning-profiles'), api<Ref[]>('/refs/positions'), api<Course[]>('/courses')])
    items.value = p
    positions.value = pos
    courses.value = c.filter(x => x.status === 'published')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

const canEdit = computed(() => hasScope('course.publish'))
const posName = (id: string) => positions.value.find(p => p.id === id)?.name ?? '?'
const courseName = (id: string) => courses.value.find(c => c.id === id)?.title ?? '?'

async function create() {
  error.value = ''
  try {
    await api('/learning-profiles', {
      method: 'POST',
      body: { name: form.name, scope: { positionIds: form.positionIds, locationIds: [], orgUnitIds: [] }, items: form.items.map((it, i) => ({ ...it, subjectType: 'course', order: i })), appliesToExisting: true, isActive: true },
    })
    form.name = ''
    form.positionIds = []
    form.items = []
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function preview(p: Profile) {
  previewOf.value = { id: p.id, ...(await api<{ count: number, items: number }>(`/learning-profiles/${p.id}/preview`, { method: 'POST' })) }
}

async function apply(p: Profile) {
  if (!confirm(t('profiles.applyConfirm', { name: p.name }))) return
  const r = await api<{ assignments: number, enrolled: number }>(`/learning-profiles/${p.id}/apply`, { method: 'POST' })
  notice.value = t('profiles.applied', r)
  await load()
}
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.profiles') }}</h1>
    <p class="sub">{{ t('profiles.hint') }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div class="list">
      <div v-for="p in items" :key="p.id" class="card">
        <div class="card-head">
          <b>{{ p.name }}</b>
          <span :class="['badge', p.isActive ? 'on' : '']">{{ p.isActive ? t('profiles.active') : t('profiles.inactive') }}</span>
          <span class="sub">{{ t('profiles.lastApplied', { at: p.lastAppliedAt ? new Date(p.lastAppliedAt).toLocaleDateString('uk') : '—' }) }}</span>
        </div>
        <div class="sub">{{ t('profiles.positions') }}: {{ p.scope.positionIds.map(posName).join(', ') || '—' }}</div>
        <ol class="courses">
          <li v-for="(it, i) in p.items" :key="i">{{ courseName(it.subjectId) }} <span class="sub">· {{ t('assign.relDays', { n: it.dueDays }) }}{{ it.isMandatory ? '' : ` · ${t('learner.optional')}` }}</span></li>
        </ol>
        <div class="actions">
          <button class="chip" @click="preview(p)">{{ t('profiles.preview') }}</button>
          <span v-if="previewOf?.id === p.id" class="sub">{{ t('profiles.previewResult', { count: previewOf.count, items: previewOf.items }) }}</span>
          <button v-if="canEdit" class="primary" @click="apply(p)">{{ t('profiles.apply') }}</button>
        </div>
      </div>
      <p v-if="items.length === 0" class="empty">{{ t('profiles.empty') }}</p>
    </div>

    <section v-if="canEdit" class="card new">
      <h2>{{ t('profiles.new') }}</h2>
      <input v-model="form.name" :placeholder="t('profiles.name')">
      <select v-model="form.positionIds" multiple size="4">
        <option v-for="p in positions" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <div v-for="(it, i) in form.items" :key="i" class="row">
        <select v-model="it.subjectId"><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
        <input v-model.number="it.dueDays" type="number" min="1" max="365" class="num">
        <label class="check"><input v-model="it.isMandatory" type="checkbox"> {{ t('assign.mandatory') }}</label>
        <button class="chip danger" @click="form.items.splice(i, 1)">✕</button>
      </div>
      <button class="chip" @click="form.items.push({ subjectId: courses[0]?.id ?? '', dueDays: 14, isMandatory: true })">+ {{ t('profiles.addCourse') }}</button>
      <button class="primary" :disabled="form.name.length < 2 || !form.positionIds.length || !form.items.length" @click="create">{{ t('course.create') }}</button>
    </section>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-1); font-weight: 900; }
h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.list { display: grid; gap: var(--space-3); margin: var(--space-4) 0; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); }
.card-head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.courses { margin: 0; padding-left: var(--space-5); }
.actions { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.row { display: flex; gap: var(--space-2); align-items: center; }
.row select { flex: 1; }
.num { width: 70px; }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); white-space: nowrap; }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; justify-self: start; }
.chip.danger { color: var(--color-coral-ink); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.on { background: var(--color-teal); color: var(--color-teal-deep); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>

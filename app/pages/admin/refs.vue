<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

// «Групи посад» (docs/v2/39 П-24.5): необязательная группировка должностей — «кухня», «зал»
const kinds = ['cities', 'positions', 'position-groups', 'position-levels', 'org-units', 'locations'] as const
type Kind = typeof kinds[number]

const kind = ref<Kind>('cities')
const rows = ref<Record<string, unknown>[]>([])
const newName = ref('')
const error = ref('')
const loading = ref(false)
const adding = ref(false)

async function load() {
  loading.value = true
  error.value = ''
  try {
    rows.value = await api<Record<string, unknown>[]>(`/refs/${kind.value}`)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    loading.value = false
  }
}

watch(kind, () => { adding.value = false; coursesFor.value = null; load() })
onMounted(load)

/**
 * «Посада → курси за замовчуванням» (docs/v2/39 П-24.3; колонка «Треки» справочника должностей
 * второго эталона): курсы, которые назначаются при найме и переводе на должность — или на любую
 * должность группы. Носитель — правило автоматизации, привязанное к должности или группе.
 */
interface DefaultCourse { courseId: string, title: string, dueDays: number }
const groups = ref<{ id: string, name: string }[]>([])
const courses = ref<{ id: string, title: string }[]>([])
const coursesFor = ref<{ kind: 'position' | 'group', id: string, name: string } | null>(null)
const courseItems = ref<DefaultCourse[]>([])
const groupCourses = ref<DefaultCourse[]>([])
const pickCourse = ref('')
async function loadGroups() {
  groups.value = await api<{ id: string, name: string }[]>('/refs/position-groups').catch(() => [])
}
watch(kind, (k) => { if (k === 'positions') loadGroups() }, { immediate: true })
const setGroup = (row: Record<string, unknown>, groupId: string) => run(() => api(`/refs/positions/${row.id}`, { method: 'PATCH', body: { groupId: groupId || null } }))
async function openCourses(row: Record<string, unknown>) {
  error.value = ''
  const target = { kind: kind.value === 'positions' ? 'position' as const : 'group' as const, id: String(row.id), name: String(row.name) }
  try {
    const path = target.kind === 'position' ? `/positions/${target.id}/default-courses` : `/position-groups/${target.id}/default-courses`
    const [d, list] = await Promise.all([
      api<{ items: DefaultCourse[], group: { items: DefaultCourse[] } | null }>(path),
      courses.value.length ? Promise.resolve(courses.value) : api<{ id: string, title: string, status: string }[]>('/courses').then(r => r.filter(c => c.status === 'published')),
    ])
    courses.value = list
    courseItems.value = d.items.map(i => ({ ...i }))
    groupCourses.value = d.group?.items ?? []
    coursesFor.value = target
    pickCourse.value = ''
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
function addCourse() {
  const c = courses.value.find(x => x.id === pickCourse.value)
  if (!c || courseItems.value.some(i => i.courseId === c.id)) return
  courseItems.value.push({ courseId: c.id, title: c.title, dueDays: 14 })
  pickCourse.value = ''
}
async function saveCourses() {
  if (!coursesFor.value) return
  const path = coursesFor.value.kind === 'position' ? `/positions/${coursesFor.value.id}/default-courses` : `/position-groups/${coursesFor.value.id}/default-courses`
  await run(() => api(path, { method: 'PUT', body: { items: courseItems.value.map(i => ({ courseId: i.courseId, dueDays: Number(i.dueDays) })) } }))
  if (!error.value) coursesFor.value = null
}

async function add() {
  if (!newName.value.trim()) return
  error.value = ''
  try {
    const body: Record<string, unknown> = { name: newName.value.trim() }
    if (kind.value === 'locations') {
      const units = await api<{ id: string }[]>('/refs/org-units')
      body.orgUnitId = units[0]?.id
    }
    await api(`/refs/${kind.value}`, { method: 'POST', body })
    newName.value = ''
    adding.value = false
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

// docs/16 §3.3: переименование, деактивация, удаление (если не используется), слияние
const editId = ref<string | null>(null)
const editName = ref('')
const mergeFrom = ref<Record<string, unknown> | null>(null)
const mergeInto = ref('')
async function run(fn: () => Promise<unknown>) {
  error.value = ''
  try { await fn(); editId.value = null; mergeFrom.value = null; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
const rename = (id: string) => run(() => api(`/refs/${kind.value}/${id}`, { method: 'PATCH', body: { name: editName.value.trim() } }))
const toggleActive = (row: Record<string, unknown>) => run(() => api(`/refs/${kind.value}/${row.id}`, { method: 'PATCH', body: { isActive: !row.isActive } }))
const remove = (row: Record<string, unknown>) => { if (confirm(t('refs.deleteConfirm', { name: String(row.name) }))) run(() => api(`/refs/${kind.value}/${row.id}`, { method: 'DELETE' })) }
const merge = () => run(() => api(`/refs/${kind.value}/merge`, { method: 'POST', body: { fromId: mergeFrom.value!.id, intoId: mergeInto.value } }))
const hasActive = computed(() => ['cities', 'positions', 'locations'].includes(kind.value))
const hasCourses = computed(() => kind.value === 'positions' || kind.value === 'position-groups')
</script>

<template>
  <div>
    <h1>{{ t('admin.nav.refs') }}</h1>

    <div class="tabs">
      <button
        v-for="k in kinds"
        :key="k"
        :class="['tab', { on: kind === k }]"
        @click="kind = k"
      >
        {{ t(`refs.${k}`) }}
      </button>
      <NuxtLink to="/admin/tags" class="tab">{{ t('refs.tags') }} →</NuxtLink>
      <!-- Типи документів людини (docs/v2/38 §3.5) — справочник HR, свой экран -->
      <NuxtLink v-if="hasScope('person.document.manage')" to="/admin/people/document-types" class="tab">{{ t('refs.documentTypes') }} →</NuxtLink>
    </div>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- Мокап Dictionaries: картка довідника — назва, кількість записів, список із «Використань», «Додати» -->
    <section class="card">
      <h2>{{ t(`refs.${kind}`) }}</h2>
      <p class="sub count">{{ t('refs.count', { n: rows.length }) }}</p>

      <div v-if="mergeFrom" class="add-row">
        <span>{{ t('refs.mergeInto', { from: String(mergeFrom.name) }) }}</span>
        <select v-model="mergeInto" :aria-label="t('refs.merge')"><option value="" disabled>—</option><option v-for="r in rows.filter(x => x.id !== mergeFrom!.id)" :key="String(r.id)" :value="String(r.id)">{{ r.name }}</option></select>
        <button class="primary" :disabled="!mergeInto" @click="merge">{{ t('refs.merge') }}</button>
        <button class="ghost" @click="mergeFrom = null">{{ t('common.cancel') }}</button>
      </div>

      <ul class="list">
        <li v-for="row in rows" :key="String(row.id)" :class="{ off: row.isActive === false }">
          <template v-if="editId === row.id">
            <input v-model="editName" :aria-label="t('refs.edit')" @keyup.enter="rename(String(row.id))" @keyup.esc="editId = null">
            <button class="primary small" @click="rename(String(row.id))">{{ t('common.save') }}</button>
            <button class="ghost small" @click="editId = null">{{ t('common.cancel') }}</button>
          </template>
          <template v-else>
            <span class="name">{{ row.name }}</span>
            <span v-if="row.isActive === false" class="sub">· {{ t('refs.inactive') }}</span>
            <span v-if="row.levelName" class="sub">· {{ row.levelName }}</span>
            <span v-if="row.groupName" class="sub">· {{ row.groupName }}</span>
            <span v-if="row.address" class="sub">· {{ row.address }}</span>
            <span v-if="row.positionsCount !== undefined" class="sub">· {{ t('refs.positionsCount', { n: Number(row.positionsCount) }) }}</span>
            <span v-if="hasCourses && Number(row.defaultCourses) > 0" class="sub">· {{ t('refs.defaultCoursesCount', { n: Number(row.defaultCourses) }) }}</span>
            <span v-if="row.peopleCount !== undefined" class="count-num">{{ row.peopleCount }}</span>
            <span v-if="hasScope('settings.tenant')" class="row-actions">
              <select v-if="kind === 'positions'" :value="String(row.groupId ?? '')" :aria-label="t('refs.group')" @change="setGroup(row, ($event.target as HTMLSelectElement).value)">
                <option value="">{{ t('refs.noGroup') }}</option>
                <option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option>
              </select>
              <button v-if="hasCourses" class="ghost small" @click="openCourses(row)">{{ t('refs.defaultCourses') }}</button>
              <button class="ghost small" @click="editId = String(row.id); editName = String(row.name)">{{ t('refs.edit') }}</button>
              <button v-if="hasActive" class="ghost small" @click="toggleActive(row)">{{ row.isActive === false ? t('common.activate') : t('common.deactivate') }}</button>
              <button v-if="kind !== 'org-units'" class="ghost small" @click="mergeFrom = row; mergeInto = ''">{{ t('refs.merge') }}</button>
              <button class="ghost small danger" @click="remove(row)">×</button>
            </span>
          </template>
        </li>
        <li v-if="!loading && rows.length === 0" class="sub">—</li>
      </ul>

      <form v-if="hasScope('settings.tenant') && adding" class="add-row" @submit.prevent="add">
        <input v-model="newName" :placeholder="t('refs.newName')" autofocus @keyup.enter="add">
        <button type="submit" class="primary small" :disabled="!newName.trim()">{{ t('common.save') }}</button>
        <button type="button" class="ghost small" @click="adding = false; newName = ''">{{ t('common.cancel') }}</button>
      </form>
      <button v-else-if="hasScope('settings.tenant')" class="ghost add-btn" @click="adding = true">{{ t('common.add') }}</button>
    </section>

    <section v-if="coursesFor" class="card courses" data-testid="default-courses">
      <h2>{{ t('refs.defaultCoursesTitle', { name: coursesFor.name }) }}</h2>
      <p class="sub">{{ coursesFor.kind === 'position' ? t('refs.defaultCoursesHint') : t('refs.defaultCoursesGroupHint') }}</p>
      <ul class="list">
        <li v-for="(c, i) in courseItems" :key="c.courseId">
          <span class="name">{{ c.title }}</span>
          <label class="sub">{{ t('refs.dueDays') }} <input v-model.number="c.dueDays" type="number" min="1" max="365" class="days" :aria-label="`${c.title}: ${t('refs.dueDays')}`"></label>
          <span class="row-actions"><button class="ghost small danger" :aria-label="t('common.delete')" @click="courseItems.splice(i, 1)">×</button></span>
        </li>
        <li v-if="!courseItems.length" class="sub">{{ t('refs.noDefaultCourses') }}</li>
      </ul>
      <p v-if="groupCourses.length" class="sub">{{ t('refs.groupCourses') }}: {{ groupCourses.map(c => c.title).join(', ') }}</p>
      <div class="add-row">
        <select v-model="pickCourse" :aria-label="t('refs.addCourse')">
          <option value="" disabled>{{ t('refs.addCourse') }}</option>
          <option v-for="c in courses.filter(x => !courseItems.some(i => i.courseId === x.id))" :key="c.id" :value="c.id">{{ c.title }}</option>
        </select>
        <button class="ghost small" :disabled="!pickCourse || courseItems.length >= 10" @click="addCourse">{{ t('common.add') }}</button>
      </div>
      <div class="add-row">
        <button class="primary" @click="saveCourses">{{ t('common.save') }}</button>
        <button class="ghost" @click="coursesFor = null">{{ t('common.cancel') }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.card { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-4); max-width: 480px; }
.card h2 { margin: 0; font-size: var(--font-size-body); font-weight: 800; }
.count { margin: 0 0 var(--space-3); }
.name { font-weight: 700; }
.count-num { color: var(--color-ink-muted); font-weight: 700; font-size: var(--font-size-body-s); }
.add-btn { margin-top: var(--space-2); }
.courses { margin-top: var(--space-4); display: grid; gap: var(--space-2); }
.days { width: 5rem; }
a.tab { text-decoration: none; }
h1 {
  margin: 0 0 var(--space-4);
  font-weight: 900;
}

.tabs {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
  flex-wrap: wrap;
}

.tab {
  font: inherit;
  font-weight: 700;
  border: 1px solid var(--color-bg-line);
  background: transparent;
  color: var(--color-ink-muted);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-4);
  cursor: pointer;
}

.tab.on {
  background: var(--color-ink);
  border-color: var(--color-ink);
  color: var(--color-bg-soft);
}

.add-row {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

input {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg-soft);
  color: var(--color-ink);
}

.primary {
  font: inherit;
  font-weight: 800;
  border: none;
  background: var(--color-sun);
  color: var(--color-ink);
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-4);
  cursor: pointer;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
  max-width: 480px;
}

.list li {
  background: var(--color-bg-soft);
  border-radius: var(--radius-s);
  padding: var(--space-2) var(--space-4);
  display: flex;
  gap: var(--space-2);
  align-items: center;
  flex-wrap: wrap;
}

.sub {
  color: var(--color-ink-faint);
  font-size: var(--font-size-body-s);
}

.error {
  color: var(--color-coral-ink);
}
.off { opacity: 0.55; }
.row-actions { margin-left: auto; display: inline-flex; gap: var(--space-1); flex-wrap: wrap; }
.small { font-size: var(--font-size-body-s); padding: 0 var(--space-2); }
.ghost { font: inherit; border: 1px solid transparent; background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); cursor: pointer; }
.ghost:hover { border-color: var(--color-bg-line); }
.ghost.danger { color: var(--color-coral-ink); }
select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-1) var(--space-2); background: var(--color-bg); color: var(--color-ink); }
</style>

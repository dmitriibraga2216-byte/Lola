<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const route = useRoute()
const courseId = route.params.id as string

interface Lesson {
  id: string
  title: string
  itemType: string
  itemId: string
  isRequired: boolean
  minSeconds: number | null
  videoThresholdPct: number
  body: ContentBlock[]
}
interface Editor {
  course: { id: string, title: string, status: string, isCatalogVisible: boolean, strictOrder: boolean, summary: string | null }
  version: { id: string, version: number, status: string }
  modules: { id: string, title: string, lessons: Lesson[] }[]
}
interface Check { code: string, label: string, ok: boolean }

const editor = ref<Editor | null>(null)
const selected = ref<Lesson | null>(null)
const draft = reactive({ title: '', body: [] as ContentBlock[], isRequired: true, minSeconds: null as number | null })
const error = ref('')
const notice = ref('')
const savedAt = ref('')
const publishOpen = ref(false)
const checks = ref<Check[]>([])
const changelog = ref('')
const busy = ref(false)
const newModuleTitle = ref('')
const newLessonTitle = reactive<Record<string, string>>({})
const quizList = ref<{ id: string, title: string }[]>([])
const workshopList = ref<{ id: string, title: string }[]>([])
const newLessonQuiz = reactive<Record<string, string>>({})

const canEdit = computed(() => hasScope('course.edit'))

async function load() {
  try {
    editor.value = await api<Editor>(`/courses/${courseId}`)
    if (quizList.value.length === 0) {
      quizList.value = (await api<{ id: string, title: string, status: string }[]>('/quizzes')).filter(q => q.status === 'published')
      workshopList.value = (await api<{ id: string, title: string, status: string }[]>('/workshops')).filter(w => w.status === 'published')
    }
    if (selected.value) {
      const fresh = editor.value.modules.flatMap(m => m.lessons).find(l => l.id === selected.value!.id)
      if (fresh) select(fresh)
    }
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

function select(lesson: Lesson) {
  selected.value = lesson
  draft.title = lesson.title
  draft.body = JSON.parse(JSON.stringify(lesson.body))
  draft.isRequired = lesson.isRequired
  draft.minSeconds = lesson.minSeconds
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 1500)
}
watch(() => [draft.title, draft.body, draft.isRequired, draft.minSeconds], () => {
  if (selected.value && canEdit.value) scheduleSave()
}, { deep: true })

async function save() {
  if (!selected.value) return
  try {
    await api(`/lessons/${selected.value.id}`, {
      method: 'PATCH',
      body: { title: draft.title, body: draft.body, isRequired: draft.isRequired, minSeconds: draft.minSeconds },
    })
    savedAt.value = new Date().toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' })
    const lesson = editor.value?.modules.flatMap(m => m.lessons).find(l => l.id === selected.value!.id)
    if (lesson) Object.assign(lesson, { title: draft.title, body: draft.body, isRequired: draft.isRequired, minSeconds: draft.minSeconds })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function addModule() {
  if (!newModuleTitle.value.trim()) return
  await api(`/courses/${courseId}/modules`, { method: 'POST', body: { title: newModuleTitle.value.trim() } })
  newModuleTitle.value = ''
  await load()
}

async function addLesson(moduleId: string) {
  const title = newLessonTitle[moduleId]?.trim()
  if (!title) return
  const pick = newLessonQuiz[moduleId] ?? ''
  const [kind, itemId] = pick.includes(':') ? pick.split(':') : ['', '']
  const lesson = await api<Lesson>(`/courses/${courseId}/lessons`, {
    method: 'POST',
    body: kind === 'quiz'
      ? { moduleId, title, itemType: 'quiz', quizId: itemId }
      : kind === 'workshop'
        ? { moduleId, title, itemType: 'workshop', workshopId: itemId }
        : { moduleId, title, resource: { body: [{ id: `b_${Date.now()}`, type: 'text', html: '<p></p>' }] } },
  })
  newLessonQuiz[moduleId] = ''
  newLessonTitle[moduleId] = ''
  await load()
  const fresh = editor.value?.modules.flatMap(m => m.lessons).find(l => l.id === lesson.id)
  if (fresh) select(fresh)
}

async function deleteLesson(lesson: Lesson) {
  if (!confirm(t('course.deleteLessonConfirm', { title: lesson.title }))) return
  await api(`/lessons/${lesson.id}`, { method: 'DELETE' })
  if (selected.value?.id === lesson.id) selected.value = null
  await load()
}

async function toggleCatalog() {
  if (!editor.value) return
  await api(`/courses/${courseId}`, { method: 'PATCH', body: { isCatalogVisible: !editor.value.course.isCatalogVisible } })
  await load()
}

async function openPublish() {
  await save()
  checks.value = await api<Check[]>(`/courses/${courseId}/publish-checks`)
  publishOpen.value = true
}

async function publish() {
  busy.value = true
  error.value = ''
  try {
    const res = await api<{ version: number }>(`/courses/${courseId}/publish`, { method: 'POST', body: { changelog: changelog.value } })
    notice.value = t('course.published', { v: res.version })
    publishOpen.value = false
    changelog.value = ''
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="editor" class="course-editor">
    <header class="head">
      <NuxtLink to="/admin/courses" class="back">← {{ t('admin.nav.courses') }}</NuxtLink>
      <h1>{{ editor.course.title }}</h1>
      <span :class="['badge', editor.course.status]">{{ t(`course.status.${editor.course.status}`) }}</span>
      <span class="sub">{{ t('course.draftVersion', { v: editor.version.version }) }}</span>
      <div class="head-actions">
        <label class="check">
          <input type="checkbox" :checked="editor.course.isCatalogVisible" :disabled="!canEdit" @change="toggleCatalog">
          {{ t('course.inCatalog') }}
        </label>
        <button v-if="hasScope('course.publish')" class="primary" @click="openPublish">{{ t('course.publish') }}</button>
      </div>
    </header>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <div class="split">
      <aside class="tree">
        <div v-for="mod in editor.modules" :key="mod.id" class="module">
          <div class="module-title">{{ mod.title }}</div>
          <button
            v-for="lesson in mod.lessons"
            :key="lesson.id"
            :class="['lesson', { on: selected?.id === lesson.id }]"
            @click="select(lesson)"
          >
            <span>{{ lesson.title }}</span>
            <span v-if="!lesson.isRequired" class="sub">{{ t('learner.optional') }}</span>
          </button>
          <div v-if="canEdit" class="add-row">
            <input v-model="newLessonTitle[mod.id]" :placeholder="t('course.newLesson')" @keyup.enter="addLesson(mod.id)">
            <select v-model="newLessonQuiz[mod.id]" :title="t('course.asQuiz')">
              <option value="">{{ t('course.material') }}</option>
              <option v-for="q in quizList" :key="q.id" :value="`quiz:${q.id}`">? {{ q.title }}</option>
              <option v-for="w in workshopList" :key="w.id" :value="`workshop:${w.id}`">✎ {{ w.title }}</option>
            </select>
            <button class="chip" @click="addLesson(mod.id)">+</button>
          </div>
        </div>
        <div v-if="canEdit" class="add-row module-add">
          <input v-model="newModuleTitle" :placeholder="t('course.newModule')" @keyup.enter="addModule">
          <button class="chip" @click="addModule">+ {{ t('course.module') }}</button>
        </div>
      </aside>

      <section class="pane">
        <template v-if="selected">
          <div class="pane-head">
            <input v-model="draft.title" class="title-input" :disabled="!canEdit">
            <span v-if="savedAt" class="sub">{{ t('course.savedAt', { time: savedAt }) }}</span>
            <button v-if="canEdit" class="chip danger" @click="deleteLesson(selected)">{{ t('course.deleteLesson') }}</button>
          </div>
          <div class="settings">
            <label class="check">
              <input v-model="draft.isRequired" type="checkbox" :disabled="!canEdit">
              {{ t('course.required') }}
            </label>
            <label class="inline">
              {{ t('course.minSeconds') }}
              <input v-model.number="draft.minSeconds" type="number" min="10" max="3600" :disabled="!canEdit" class="num">
            </label>
          </div>
          <div v-if="selected.itemType === 'quiz'" class="quiz-note">
            {{ t('course.quizLesson') }}
            <NuxtLink :to="`/admin/quizzes/${selected.itemId}`">{{ t('course.openQuiz') }} →</NuxtLink>
          </div>
          <div v-else-if="selected.itemType === 'workshop'" class="quiz-note">
            {{ t('course.workshopLesson') }}
            <NuxtLink to="/admin/workshops">{{ t('admin.nav.workshops') }} →</NuxtLink>
          </div>
          <BlockEditor v-else-if="canEdit" v-model="draft.body" />
          <LessonBlocks v-else :blocks="draft.body" :blocks-state="{}" readonly />
        </template>
        <div v-else class="empty">{{ t('course.selectLesson') }}</div>
      </section>
    </div>

    <div v-if="publishOpen" class="modal-backdrop" @click.self="publishOpen = false">
      <div class="modal">
        <h2>{{ t('course.publish') }}</h2>
        <ul class="checks">
          <li v-for="c in checks" :key="c.code" :class="{ ok: c.ok, bad: !c.ok }">
            {{ c.ok ? '✓' : '✕' }} {{ c.label }}
          </li>
        </ul>
        <textarea v-model="changelog" rows="3" :placeholder="t('course.changelog')" />
        <div class="modal-actions">
          <button class="chip" @click="publishOpen = false">{{ t('common.cancel') }}</button>
          <button
            class="primary"
            :disabled="busy || checks.some(c => !c.ok) || changelog.trim().length < 5"
            @click="publish"
          >
            {{ t('course.publish') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-bottom: var(--space-4);
}

.back {
  color: var(--color-ink-muted);
  text-decoration: none;
  font-size: var(--font-size-body-s);
  width: 100%;
}

h1 {
  margin: 0;
  font-weight: 900;
}

.head-actions {
  margin-left: auto;
  display: flex;
  gap: var(--space-3);
  align-items: center;
}

.split {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: var(--space-4);
}

@media (max-width: 900px) {
  .split {
    grid-template-columns: 1fr;
  }
}

.tree {
  display: grid;
  gap: var(--space-3);
  align-content: start;
}

.module {
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-3);
  display: grid;
  gap: var(--space-1);
}

.module-title {
  font-weight: 800;
  margin-bottom: var(--space-1);
}

.lesson {
  font: inherit;
  text-align: left;
  border: none;
  background: transparent;
  border-radius: var(--radius-s);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  color: var(--color-ink);
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
}

.lesson.on {
  background: var(--color-sun);
}

.add-row {
  display: flex;
  gap: var(--space-1);
  margin-top: var(--space-2);
}

.add-row select {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  background: var(--color-bg);
  color: var(--color-ink);
  max-width: 110px;
}

.quiz-note {
  background: var(--color-bg);
  border-radius: var(--radius-m);
  padding: var(--space-4);
  color: var(--color-ink-muted);
  display: flex;
  gap: var(--space-3);
}

.quiz-note a {
  color: var(--color-teal-ink);
  font-weight: 700;
}

.add-row input,
.title-input,
.num,
textarea {
  font: inherit;
  border: 1px solid var(--color-bg-line);
  border-radius: var(--radius-s);
  padding: var(--space-1) var(--space-2);
  background: var(--color-bg);
  color: var(--color-ink);
  flex: 1;
  min-width: 0;
}

.pane {
  background: var(--color-bg-soft);
  border-radius: var(--radius-m);
  padding: var(--space-4);
  min-height: 400px;
}

.pane-head {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  margin-bottom: var(--space-3);
}

.title-input {
  font-size: var(--font-size-title-l);
  font-weight: 800;
}

.settings {
  display: flex;
  gap: var(--space-4);
  align-items: center;
  margin-bottom: var(--space-4);
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
}

.inline {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.num {
  width: 80px;
  flex: none;
}

.check {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  font-size: var(--font-size-body-s);
}

.chip,
.primary {
  font: inherit;
  font-weight: 700;
  border-radius: var(--radius-pill);
  padding: var(--space-1) var(--space-3);
  cursor: pointer;
}

.chip {
  border: 1px solid var(--color-bg-line);
  background: transparent;
  color: var(--color-ink-muted);
}

.chip.danger {
  color: var(--color-coral-ink);
}

.primary {
  border: none;
  background: var(--color-sun);
  color: var(--color-ink);
  font-weight: 800;
  padding: var(--space-2) var(--space-4);
}

.primary:disabled {
  opacity: 0.5;
}

.badge {
  font-size: var(--font-size-body-s);
  font-weight: 700;
  border-radius: var(--radius-pill);
  padding: 2px var(--space-3);
  background: var(--color-bg-line-soft);
}

.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.badge.draft { background: var(--color-sun); color: var(--color-sun-ink); }

.sub {
  font-size: var(--font-size-body-s);
  color: var(--color-ink-faint);
}

.empty {
  color: var(--color-ink-faint);
  text-align: center;
  padding: var(--space-7);
}

.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgb(12 15 20 / 40%);
  display: grid;
  place-items: center;
  padding: var(--space-4);
}

.modal {
  background: var(--color-bg-soft);
  border-radius: var(--radius-xl);
  padding: var(--space-5);
  width: min(480px, 100%);
  display: grid;
  gap: var(--space-3);
}

.modal h2 {
  margin: 0;
  font-weight: 900;
}

.checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
}

.checks .ok { color: var(--color-teal-ink); }
.checks .bad { color: var(--color-coral-ink); }

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>

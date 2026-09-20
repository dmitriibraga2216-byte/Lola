<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
import { COURSE_RESULT_MODES } from '#shared/schemas/content'

/**
 * План курса по мокапу CoursePlan (docs/11 §5.3, §14.1): слева библиотека ресурсов и тестов с фильтрами
 * «Тип» · «Мітки» и «Знайдено: N», справа план — «РОЗДІЛ N», три действия («Створити і підключити ресурс»,
 * «Створити та підключити тест», «Додати розділ»), у теста в плане «Поріг N%». Раздел обязателен:
 * элемент подключается только в раздел. Параметры выбранного элемента — в панели справа.
 */
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
  passScorePct: string | number | null
  body: ContentBlock[]
  resource: { kind: string, status: string, estimatedMinutes: number | null, version: number } | null
}
interface Course {
  id: string, title: string, status: string, isCatalogVisible: boolean, strictOrder: boolean, summary: string | null
  competencyId: string | null, competencyLevel: number | null
  code: string | null, durationDays: number | null, workload: string | null, resultMode: string
}
interface Editor {
  course: Course
  version: { id: string, version: number, status: string }
  modules: { id: string, title: string, lessons: Lesson[] }[]
}
interface Check { code: string, label: string, ok: boolean }
interface LibItem { id: string, title: string, kind: 'resource' | 'quiz' | 'workshop' | 'meetup', sub: string, tags: string[], questions?: number }

const editor = ref<Editor | null>(null)
const selected = ref<Lesson | null>(null)
const draft = reactive({ title: '', body: [] as ContentBlock[], isRequired: true, minSeconds: null as number | null, passScorePct: null as number | null })
const error = ref('')
const notice = ref('')
const savedAt = ref('')
const publishOpen = ref(false)
const cardOpen = ref(false)
const checks = ref<Check[]>([])
const changelog = ref('')
const notifyAssigned = ref(false)
const busy = ref(false)
const newModuleTitle = ref('')
const newItemTitle = ref('')
const targetModuleId = ref('')
const libKind = ref<'all' | 'resource' | 'quiz' | 'workshop' | 'meetup'>('all')
const libTag = ref('')
const libQ = ref('')
const library = ref<LibItem[]>([])
const card = reactive({ title: '', code: '', durationDays: null as number | null, workload: '', resultMode: 'pct', summary: '' })

const canEdit = computed(() => hasScope('course.edit'))

async function loadLibrary() {
  const [res, quizzes, workshops, meetups, webinars] = await Promise.all([
    api<{ items: { id: string, title: string, kind: string, tags: string[], estimatedMinutes?: number | null }[] }>('/resources', { query: { status: 'published', perPage: 100 } }).catch(() => ({ items: [] })),
    api<{ id: string, title: string, status: string, questionCount?: number, tags?: string[] }[]>('/quizzes').catch(() => []),
    api<{ id: string, title: string, status: string, tags?: string[] }[]>('/workshops').catch(() => []),
    api<{ id: string, title: string, summary: string | null }[]>('/tasks/content', { query: { type: 'meetup' } }).catch(() => []),
    api<{ id: string, title: string, summary: string | null }[]>('/tasks/content', { query: { type: 'webinar' } }).catch(() => []),
  ])
  library.value = [
    ...res.items.map(r => ({ id: r.id, title: r.title, kind: 'resource' as const, sub: t(`resource.kind.${r.kind}`), tags: r.tags })),
    ...quizzes.filter(q => q.status === 'published').map(q => ({ id: q.id, title: q.title, kind: 'quiz' as const, sub: t('course.itemQuiz'), tags: q.tags ?? [], questions: q.questionCount })),
    ...workshops.filter(w => w.status === 'published').map(w => ({ id: w.id, title: w.title, kind: 'workshop' as const, sub: t('course.itemWorkshop'), tags: w.tags ?? [] })),
    // Урок-заняття (docs/29 Б.3): дата і місце — в сесіях на призначенні, тут лише вибір картки
    ...meetups.map(m => ({ id: m.id, title: m.title, kind: 'meetup' as const, sub: t('course.itemMeetup'), tags: [] as string[] })),
    ...webinars.map(w => ({ id: w.id, title: w.title, kind: 'meetup' as const, sub: t('course.itemWebinar'), tags: [] as string[] })),
  ]
}

async function load() {
  try {
    editor.value = await api<Editor>(`/courses/${courseId}`)
    Object.assign(card, {
      title: editor.value.course.title, code: editor.value.course.code ?? '', durationDays: editor.value.course.durationDays,
      workload: editor.value.course.workload ?? '', resultMode: editor.value.course.resultMode, summary: editor.value.course.summary ?? '',
    })
    if (!targetModuleId.value && editor.value.modules[0]) targetModuleId.value = editor.value.modules[0].id
    if (library.value.length === 0) await loadLibrary()
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

const libTags = computed(() => [...new Set(library.value.flatMap(i => i.tags))].sort())
const libVisible = computed(() => library.value.filter(i =>
  (libKind.value === 'all' || i.kind === libKind.value)
  && (!libTag.value || i.tags.includes(libTag.value))
  && (!libQ.value.trim() || i.title.toLowerCase().includes(libQ.value.trim().toLowerCase())),
))

function select(lesson: Lesson) {
  selected.value = lesson
  draft.title = lesson.title
  draft.body = JSON.parse(JSON.stringify(lesson.body))
  draft.isRequired = lesson.isRequired
  draft.minSeconds = lesson.minSeconds
  draft.passScorePct = lesson.passScorePct == null ? null : Number(lesson.passScorePct)
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 1500)
}
watch(() => [draft.title, draft.body, draft.isRequired, draft.minSeconds, draft.passScorePct], () => {
  if (selected.value && canEdit.value) scheduleSave()
}, { deep: true })

async function save() {
  if (!selected.value) return
  try {
    await api(`/lessons/${selected.value.id}`, {
      method: 'PATCH',
      body: { title: draft.title, body: draft.body, isRequired: draft.isRequired, minSeconds: draft.minSeconds, passScorePct: draft.passScorePct || null },
    })
    savedAt.value = new Date().toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit' })
    const lesson = editor.value?.modules.flatMap(m => m.lessons).find(l => l.id === selected.value!.id)
    if (lesson) Object.assign(lesson, { title: draft.title, body: draft.body, isRequired: draft.isRequired, minSeconds: draft.minSeconds, passScorePct: draft.passScorePct })
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function saveCard() {
  busy.value = true
  try {
    await api(`/courses/${courseId}`, {
      method: 'PATCH',
      body: {
        title: card.title.trim(), code: card.code.trim() || null, durationDays: card.durationDays || null,
        workload: card.workload.trim() || null, resultMode: card.resultMode, summary: card.summary.trim() || undefined,
      },
    })
    notice.value = t('common.saved')
    cardOpen.value = false
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

async function addModule() {
  const title = newModuleTitle.value.trim()
  if (!title) return
  const mod = await api<{ id: string }>(`/courses/${courseId}/modules`, { method: 'POST', body: { title } })
  newModuleTitle.value = ''
  targetModuleId.value = mod.id
  await load()
}

/** Подключение элемента: только в раздел (docs/11 §14.1); без раздела — подсказка. */
async function addLesson(body: Record<string, unknown>) {
  if (!targetModuleId.value) {
    error.value = t('course.sectionRequired')
    return
  }
  error.value = ''
  try {
    const lesson = await api<Lesson>(`/courses/${courseId}/lessons`, { method: 'POST', body: { moduleId: targetModuleId.value, ...body } })
    await load()
    const fresh = editor.value?.modules.flatMap(m => m.lessons).find(l => l.id === lesson.id)
    if (fresh) select(fresh)
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

function attach(item: LibItem) {
  if (item.kind === 'resource') return addLesson({ title: item.title, itemType: 'resource', resourceId: item.id })
  if (item.kind === 'quiz') return addLesson({ title: item.title, itemType: 'quiz', quizId: item.id })
  if (item.kind === 'meetup') return addLesson({ title: item.title, itemType: 'meetup', meetupId: item.id })
  return addLesson({ title: item.title, itemType: 'workshop', workshopId: item.id })
}

/** «Створити і підключити ресурс»: новая страница из блоков с названием из поля. */
async function createResource() {
  const title = newItemTitle.value.trim()
  if (!title) return
  await addLesson({ title, itemType: 'resource', resource: { body: [{ id: `b_${Date.now()}`, type: 'text', html: '<p></p>' }] } })
  newItemTitle.value = ''
}

/** «Створити та підключити тест»: пустой тест, вопросы — в редакторе теста. */
async function createQuiz() {
  const title = newItemTitle.value.trim()
  if (!title) return
  try {
    const quiz = await api<{ id: string }>('/quizzes', { method: 'POST', body: { title } })
    await addLesson({ title, itemType: 'quiz', quizId: quiz.id })
    newItemTitle.value = ''
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}

async function deleteLesson(lesson: Lesson) {
  if (!confirm(t('course.deleteLessonConfirm', { title: lesson.title }))) return
  await api(`/lessons/${lesson.id}`, { method: 'DELETE' })
  if (selected.value?.id === lesson.id) selected.value = null
  await load()
}

async function moveLesson(mod: Editor['modules'][number], index: number, delta: number) {
  const target = index + delta
  if (target < 0 || target >= mod.lessons.length) return
  const order = [...mod.lessons]
  const [row] = order.splice(index, 1)
  order.splice(target, 0, row!)
  await api('/lessons/reorder', { method: 'POST', body: { items: order.map((l, i) => ({ id: l.id, sort: i })) } })
  await load()
}

// docs/19 §7.3: какую компетенцию и до какого уровня закрывает курс
const competencies = ref<{ id: string, name: string, levels: { level: number, title: string }[] }[]>([])
const comp = reactive({ competencyId: '', competencyLevel: 0 })
watch(editor, (e) => { if (e) { comp.competencyId = e.course.competencyId ?? ''; comp.competencyLevel = e.course.competencyLevel ?? 0 } })
onMounted(async () => { try { competencies.value = await api('/competencies') } catch { /* модуль недоступен */ } })
async function saveCompetency() {
  await api(`/courses/${courseId}`, { method: 'PATCH', body: { competencyId: comp.competencyId || null, competencyLevel: comp.competencyId && comp.competencyLevel ? comp.competencyLevel : null } })
  notice.value = t('common.saved')
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
    const res = await api<{ version: number }>(`/courses/${courseId}/publish`, { method: 'POST', body: { changelog: changelog.value, notifyAssigned: notifyAssigned.value } })
    notice.value = t('course.published', { v: res.version })
    publishOpen.value = false
    changelog.value = ''
    notifyAssigned.value = false
    await load()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

function itemSub(l: Lesson): string {
  if (l.itemType === 'quiz') return t('course.itemQuiz')
  if (l.itemType === 'workshop') return t('course.itemWorkshop')
  if (l.itemType === 'meetup') return t('course.itemMeetup')
  return l.resource?.estimatedMinutes ? `${t('course.itemResource')} · ${t('course.minutesN', { n: l.resource.estimatedMinutes })}` : t('course.itemResource')
}
</script>

<template>
  <div v-if="editor" class="course-plan">
    <PageHeader :title="t('course.planOf', { title: editor.course.title })" :crumbs="[{ label: t('admin.section.content') }, { label: t('course.title'), to: '/admin/courses' }]">
      <template #actions>
        <span :class="['badge upper', editor.course.status]">{{ t(`course.status.${editor.course.status}`) }}</span>
        <button class="btn ghost" @click="cardOpen = !cardOpen">{{ t('course.card') }}</button>
        <button v-if="canEdit" class="btn ghost" @click="save(); notice = t('common.saved')">{{ t('common.save') }}</button>
        <button v-if="hasScope('course.publish')" class="btn primary" @click="openPublish">{{ t('course.publish') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <form v-if="cardOpen" class="card course-card" @submit.prevent="saveCard">
      <label><span class="label">{{ t('course.newTitle') }}</span><input v-model="card.title" class="field" minlength="3" maxlength="200" :disabled="!canEdit"></label>
      <label><span class="label">{{ t('course.description') }}</span><textarea v-model="card.summary" class="field" rows="2" maxlength="300" :disabled="!canEdit" /></label>
      <div class="grid3">
        <label><span class="label">{{ t('course.code') }}</span><input v-model="card.code" class="field" maxlength="40" :disabled="!canEdit"></label>
        <label><span class="label">{{ t('course.durationDays') }}</span><input v-model.number="card.durationDays" class="field" type="number" min="1" max="3650" :disabled="!canEdit"></label>
        <label><span class="label">{{ t('course.workload') }}</span><input v-model="card.workload" class="field" maxlength="200" :disabled="!canEdit"></label>
      </div>
      <fieldset class="modes">
        <legend class="label">{{ t('course.resultModeLabel') }}</legend>
        <div class="segmented">
          <label v-for="m in COURSE_RESULT_MODES" :key="m" :class="{ on: card.resultMode === m }"><input v-model="card.resultMode" type="radio" name="resultMode" :value="m" class="sr-only" :disabled="!canEdit">{{ t(`course.resultMode.${m}`) }}</label>
        </div>
      </fieldset>
      <div class="row-actions">
        <label class="check"><input type="checkbox" :checked="editor.course.isCatalogVisible" :disabled="!canEdit" @change="toggleCatalog">{{ t('course.inCatalog') }}</label>
        <template v-if="competencies.length && canEdit">
          <select v-model="comp.competencyId" class="field small" :aria-label="t('course.closesCompetency')"><option value="">{{ t('course.closesCompetency') }}</option><option v-for="c in competencies" :key="c.id" :value="c.id">{{ c.name }}</option></select>
          <select v-if="comp.competencyId" v-model.number="comp.competencyLevel" class="field small" :aria-label="t('dev.level')"><option :value="0">—</option><option v-for="l in (competencies.find(c => c.id === comp.competencyId)?.levels ?? [])" :key="l.level" :value="l.level">{{ t('dev.level') }} {{ l.level }} · {{ l.title }}</option></select>
          <button type="button" class="chip" @click="saveCompetency">{{ t('common.save') }}</button>
        </template>
        <button v-if="canEdit" type="submit" class="btn primary" :disabled="busy || card.title.trim().length < 3">{{ t('common.save') }}</button>
      </div>
    </form>

    <div class="split">
      <aside class="library card">
        <h2 class="panel-title">{{ t('course.library') }}</h2>
        <div class="lib-filters">
          <select v-model="libKind" class="field" :aria-label="t('resource.filter.kind')">
            <option v-for="k in (['all', 'resource', 'quiz', 'workshop', 'meetup'] as const)" :key="k" :value="k">{{ t(`course.libKind.${k}`) }}</option>
          </select>
          <select v-model="libTag" class="field" :aria-label="t('resource.filter.tag')">
            <option value="">{{ t('resource.filter.tag') }}</option>
            <option v-for="tg in libTags" :key="tg" :value="tg">{{ tg }}</option>
          </select>
          <input v-model="libQ" type="search" class="field" :placeholder="t('resource.filter.search')" :aria-label="t('resource.filter.search')">
        </div>
        <p class="found">{{ t('course.libFound', { n: libVisible.length }) }}</p>
        <ul class="lib-list" role="list">
          <li v-for="item in libVisible" :key="`${item.kind}:${item.id}`" class="lib-item">
            <div class="lib-text"><b>{{ item.title }}</b><span class="sub">{{ item.sub }}<template v-if="item.questions != null"> · {{ t('course.questionsN', { n: item.questions }) }}</template></span></div>
            <button v-if="canEdit" class="chip" :disabled="!targetModuleId" :title="targetModuleId ? '' : t('course.sectionRequired')" @click="attach(item)">{{ t('course.attach') }}</button>
          </li>
        </ul>
      </aside>

      <section class="plan">
        <div class="plan-head">
          <h2 class="panel-title">{{ t('course.plan') }}</h2>
        </div>
        <div v-if="canEdit" class="plan-actions">
          <select v-if="editor.modules.length" v-model="targetModuleId" class="field small" :aria-label="t('course.toSection')">
            <option v-for="(m, i) in editor.modules" :key="m.id" :value="m.id">{{ t('course.sectionN', { n: i + 1 }) }} · {{ m.title }}</option>
          </select>
          <input v-model="newItemTitle" class="field small grow" :placeholder="t('course.newLesson')" :aria-label="t('course.newLesson')" :disabled="!targetModuleId" @keyup.enter="createResource">
          <button class="btn ghost small" :disabled="!targetModuleId || !newItemTitle.trim()" :title="targetModuleId ? '' : t('course.sectionRequired')" @click="createResource">{{ t('course.createResource') }}</button>
          <button class="btn ghost small" :disabled="!targetModuleId || !newItemTitle.trim()" :title="targetModuleId ? '' : t('course.sectionRequired')" @click="createQuiz">{{ t('course.createQuiz') }}</button>
        </div>

        <div v-for="(mod, mi) in editor.modules" :key="mod.id" class="section">
          <div class="section-title"><span class="section-n">{{ t('course.sectionN', { n: mi + 1 }).toUpperCase() }}</span> {{ mod.title }}</div>
          <div v-for="(lesson, li) in mod.lessons" :key="lesson.id" :class="['item', { on: selected?.id === lesson.id }]">
            <button class="item-main" @click="select(lesson)">
              <span class="item-text"><b>{{ lesson.title }}</b><span class="sub">{{ itemSub(lesson) }}<template v-if="!lesson.isRequired"> · {{ t('learner.optional') }}</template></span></span>
              <span v-if="lesson.itemType === 'quiz'" class="badge sun">{{ t('course.threshold', { n: lesson.passScorePct == null ? 0 : Number(lesson.passScorePct) }) }}</span>
            </button>
            <span v-if="canEdit" class="item-move">
              <button class="chip" :aria-label="t('resource.moveUp')" :disabled="li === 0" @click="moveLesson(mod, li, -1)">↑</button>
              <button class="chip" :aria-label="t('resource.moveDown')" :disabled="li === mod.lessons.length - 1" @click="moveLesson(mod, li, 1)">↓</button>
            </span>
          </div>
          <p v-if="mod.lessons.length === 0" class="sub">{{ t('course.selectLesson') }}</p>
        </div>

        <div v-if="canEdit" class="add-section">
          <input v-model="newModuleTitle" class="field" :placeholder="t('course.newSectionTitle')" @keyup.enter="addModule">
          <button class="btn ghost small" :disabled="!newModuleTitle.trim()" @click="addModule">{{ t('course.addSection') }}</button>
        </div>
        <p v-if="editor.modules.length === 0" class="note sun">{{ t('course.sectionRequired') }}</p>
      </section>

      <aside v-if="selected" class="pane card">
        <div class="pane-head">
          <input v-model="draft.title" class="field title-input" :disabled="!canEdit" :aria-label="t('course.newLesson')">
          <span v-if="savedAt" class="sub">{{ t('course.savedAt', { time: savedAt }) }}</span>
        </div>
        <h2 class="panel-title">{{ t('course.settings') }}</h2>
        <label class="check"><input v-model="draft.isRequired" type="checkbox" :disabled="!canEdit">{{ t('course.required') }}</label>
        <label class="inline">{{ t('course.minSeconds') }}<input v-model.number="draft.minSeconds" type="number" min="10" max="3600" :disabled="!canEdit" class="field num"></label>
        <label v-if="selected.itemType === 'quiz'" class="inline" :title="t('course.passScoreHint')">{{ t('course.passScorePct') }}<input v-model.number="draft.passScorePct" type="number" min="1" max="100" :disabled="!canEdit" class="field num" :placeholder="t('course.fromTask')"></label>
        <p v-if="selected.itemType === 'quiz'" class="help">{{ t('course.passScoreHint') }}</p>

        <div v-if="selected.itemType === 'quiz'" class="quiz-note">
          {{ t('course.quizLesson') }}
          <NuxtLink :to="`/admin/quizzes/${selected.itemId}`">{{ t('course.openQuiz') }} →</NuxtLink>
        </div>
        <div v-else-if="selected.itemType === 'workshop'" class="quiz-note">
          {{ t('course.workshopLesson') }}
          <NuxtLink to="/admin/workshops">{{ t('admin.nav.workshops') }} →</NuxtLink>
        </div>
        <div v-else-if="selected.itemType === 'meetup'" class="quiz-note">
          {{ t('course.meetupLesson') }}
          <NuxtLink :to="`/admin/meetups/${selected.itemId}`">{{ t('admin.nav.meetups') }} →</NuxtLink>
        </div>
        <template v-else>
          <p class="help">
            <NuxtLink :to="`/admin/resources/${selected.itemId}`" class="link">{{ t('course.openResource') }} →</NuxtLink>
            <template v-if="selected.resource"> · {{ t(`resource.kind.${selected.resource.kind}`) }} · {{ t('course.version', { v: selected.resource.version }) }}</template>
          </p>
          <template v-if="selected.resource?.kind === 'article'">
            <BlockEditor v-if="canEdit" v-model="draft.body" />
            <LessonBlocks v-else :blocks="draft.body" :blocks-state="{}" readonly />
          </template>
        </template>
        <button v-if="canEdit" class="chip coral" @click="deleteLesson(selected)">{{ t('course.deleteLesson') }}</button>
      </aside>
    </div>

    <div v-if="publishOpen" class="modal-backdrop" @click.self="publishOpen = false">
      <div class="modal card">
        <h2 class="panel-title">{{ t('course.publish') }}</h2>
        <ul class="checks">
          <li v-for="c in checks" :key="c.code" :class="{ ok: c.ok, bad: !c.ok }">{{ c.ok ? '✓' : '✕' }} {{ c.label }}</li>
        </ul>
        <textarea v-model="changelog" class="field" rows="3" :placeholder="t('course.changelog')" />
        <label class="toggle">
          <input v-model="notifyAssigned" type="checkbox">
          <span>{{ t('course.notifyAssigned') }}<span class="hint">{{ t('course.notifyAssignedHint') }}</span></span>
        </label>
        <div class="modal-actions">
          <button class="btn ghost" @click="publishOpen = false">{{ t('common.cancel') }}</button>
          <button class="btn primary" :disabled="busy || checks.some(c => !c.ok) || changelog.trim().length < 5" @click="publish">{{ t('course.publish') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.course-card { display: grid; gap: var(--space-3); margin-bottom: var(--space-4); }
.grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
.modes { border: none; margin: 0; padding: 0; }
.row-actions { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.field.small { width: auto; }
.split { display: grid; grid-template-columns: 300px minmax(0, 1fr) 320px; gap: var(--space-4); align-items: start; }
.library { display: grid; gap: var(--space-2); align-content: start; }
.lib-filters { display: grid; gap: var(--space-2); }
.found { margin: 0; font-weight: 700; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.lib-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); max-height: 60vh; overflow: auto; }
.lib-item { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2); border-radius: var(--radius-s); background: var(--color-bg); }
.lib-text, .item-text { display: grid; min-width: 0; }
.lib-text b, .item-text b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan { display: grid; gap: var(--space-3); align-content: start; }
.plan-head { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.plan-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; }
.section { background: var(--color-bg-soft); border-radius: var(--radius-m); padding: var(--space-3); display: grid; gap: var(--space-1); }
.section-title { font-weight: 900; margin-bottom: var(--space-1); }
.section-n { font-size: 12px; letter-spacing: 0.06em; color: var(--color-ink-muted); margin-right: var(--space-2); }
.item { background: var(--color-bg); border-radius: var(--radius-s); display: flex; align-items: center; gap: var(--space-2); padding-right: var(--space-2); }
.item.on { outline: 2px solid var(--color-ink); }
.item-main { font: inherit; text-align: left; border: none; background: transparent; padding: var(--space-2) var(--space-3); cursor: pointer; color: var(--color-ink); display: flex; align-items: center; gap: var(--space-2); flex: 1; min-width: 0; }
.item-text { flex: 1; }
.field.grow { flex: 1 1 160px; }
.item-move { display: flex; gap: var(--space-1); }
.add-section { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.add-section .field { flex: 1 1 200px; }
.pane { display: grid; gap: var(--space-3); align-content: start; }
.pane-head { display: grid; gap: var(--space-1); }
.title-input { font-weight: 800; }
.inline { display: flex; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); font-weight: 700; }
.num { width: 90px; }
.check { display: flex; gap: var(--space-2); align-items: center; font-weight: 700; font-size: var(--font-size-body-s); }
.quiz-note { background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-3); color: var(--color-ink-muted); display: grid; gap: var(--space-2); }
.quiz-note a { color: var(--color-teal-ink); font-weight: 700; }
.chip.coral { color: var(--color-coral-ink); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
.segmented label:focus-within { outline: 2px solid var(--color-ink); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 0.4); display: grid; place-items: center; padding: var(--space-4); z-index: 20; }
.modal { width: min(560px, 100%); display: grid; gap: var(--space-3); }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.checks .ok { color: var(--color-teal-ink); }
.checks .bad { color: var(--color-coral-ink); }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
@media (max-width: 1100px) { .split { grid-template-columns: minmax(0, 1fr); } .grid3 { grid-template-columns: 1fr; } }
</style>

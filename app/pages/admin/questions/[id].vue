<script setup lang="ts">
import { QUESTION_KINDS, type QuestionKind, type ScoringMethod } from '#shared/enums'
import type { ContentBlock } from '../../../../shared/schemas/content'

/**
 * Редактор вопроса по мокапу QuestionEditor (docs/12 §14.3, §14.6, docs/05 §5.14.6): чипы типов,
 * текст, конструктор ответа по типу, справа «Група питань · Скільки варіантів · Метод підрахунку ·
 * Бали · мітки». У вільної відповіді — «Підказка для перевіряючого» и «Дозволити прикріпляти файли».
 * /admin/questions/new?quizId=&bankId=&groupId= — новый вопрос сразу в тест; /admin/questions/:id — правка.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'question.manage' })

const { t } = useI18n()
const { api } = useApi()
const { upload } = useMediaUpload()
const route = useRoute()
const router = useRouter()

const questionId = route.params.id as string
const isNew = questionId === 'new'
const quizId = (route.query.quizId as string) || ''

interface Opt { id: string, text: string }
interface Group { id: string, title: string }
interface Area { id: string, shape: 'rect', x: number, y: number, w: number, h: number }
interface QuizEditor { quiz: { id: string, title: string, questionCount: number }, items: { questionId: string }[], groups: Group[] }
interface Bank { id: string, name: string }

const ETALON_KINDS: QuestionKind[] = ['single', 'multi', 'free', 'ordering', 'classification', 'comparison', 'answer_by_map']
const EXTRA_KINDS: QuestionKind[] = QUESTION_KINDS.filter(k => !ETALON_KINDS.includes(k))
const SCORED_KINDS: QuestionKind[] = ['multi', 'ordering', 'classification', 'comparison', 'answer_by_map']

const quiz = ref<QuizEditor | null>(null)
const banks = ref<Bank[]>([])
const error = ref('')
const busy = ref(false)
const inSnapshots = ref(false)
const position = ref<number | null>(null)

let uid = 0
const nid = () => `o${Date.now().toString(36)}${(uid++).toString(36)}`

const f = reactive({
  kind: 'single' as QuestionKind,
  bankId: (route.query.bankId as string) || '',
  questionGroupId: (route.query.groupId as string) || '',
  text: '',
  options: [{ id: nid(), text: '' }, { id: nid(), text: '' }, { id: nid(), text: '' }, { id: nid(), text: '' }] as Opt[],
  correct: [] as string[], // single / multi
  right: [{ id: nid(), text: '' }, { id: nid(), text: '' }] as Opt[], // comparison: «Парні варіанти»
  pairs: {} as Record<string, string>, // comparison leftId → rightId
  groups: [{ id: nid(), title: '' }, { id: nid(), title: '' }] as { id: string, title: string }[], // classification «Класи»
  placements: {} as Record<string, string>, // classification itemId → groupId
  imageMediaId: '',
  areas: [] as Area[],
  correctAreas: [] as string[],
  number: { value: 0, tolerance: 0, toleranceType: 'abs' as 'abs' | 'pct', unit: '' },
  accepted: '',
  allowTypos: 0,
  caseSensitive: false,
  criteria: '',
  reference: '',
  graderHint: '',
  attachFiles: false,
  scoringMethod: 'formula' as ScoringMethod,
  negativeMarking: false,
  points: 1,
  tags: [] as string[],
  tagInput: '',
  isCritical: false,
  difficulty: 3,
  explanation: '',
})

const imageUrl = ref('')

async function load() {
  try {
    if (quizId) quiz.value = await api<QuizEditor>(`/quizzes/${quizId}`)
    banks.value = await api<Bank[]>('/question-banks')
    if (!f.bankId && banks.value[0]) f.bankId = banks.value[0].id
    if (!isNew) {
      const q = await api<Record<string, unknown> & { kind: QuestionKind, stem: ContentBlock[], options: unknown, answer: unknown, inSnapshots: boolean }>(`/questions/${questionId}`)
      fill(q)
      inSnapshots.value = q.inSnapshots
      const idx = quiz.value?.items.findIndex(i => i.questionId === questionId) ?? -1
      position.value = idx >= 0 ? idx + 1 : null
    }
    else {
      position.value = (quiz.value?.quiz.questionCount ?? 0) + 1
    }
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
}
onMounted(load)

function stemText(stem: ContentBlock[]): string {
  const b = stem.find(x => x.type === 'text') as { html: string } | undefined
  return (b?.html ?? '').replace(/<[^>]+>/g, '')
}

function fill(q: Record<string, unknown> & { kind: QuestionKind, stem: ContentBlock[], options: unknown, answer: unknown }) {
  f.kind = q.kind
  f.bankId = q.bankId as string
  f.questionGroupId = (q.questionGroupId as string | null) ?? ''
  f.text = stemText(q.stem)
  f.graderHint = (q.graderHint as string | null) ?? ''
  f.attachFiles = !!q.attachFiles
  f.scoringMethod = q.scoringMethod as ScoringMethod
  f.negativeMarking = !!q.negativeMarking
  f.points = Number(q.points)
  f.tags = (q.tags as string[]) ?? []
  f.isCritical = !!q.isCritical
  f.difficulty = (q.difficulty as number) ?? 3
  f.explanation = q.explanation ? stemText(q.explanation as ContentBlock[]) : ''
  const a = (q.answer ?? {}) as Record<string, unknown>
  switch (q.kind) {
    case 'single': f.options = q.options as Opt[]; f.correct = [a.correctId as string]; break
    case 'multi': f.options = q.options as Opt[]; f.correct = (a.correctIds as string[]) ?? []; break
    case 'ordering': {
      const order = (a.order as string[]) ?? []
      const opts = q.options as Opt[]
      f.options = order.map(id => opts.find(o => o.id === id)!).filter(Boolean)
      break
    }
    case 'comparison': {
      const o = q.options as { left: Opt[], right: Opt[] }
      f.options = o.left
      f.right = o.right
      f.pairs = Object.fromEntries(((a.pairs as { leftId: string, rightId: string }[]) ?? []).map(p => [p.leftId, p.rightId]))
      break
    }
    case 'classification': {
      const o = q.options as { groups: { id: string, title: string }[], items: Opt[] }
      f.groups = o.groups
      f.options = o.items
      f.placements = Object.fromEntries(((a.placements as { itemId: string, groupId: string }[]) ?? []).map(p => [p.itemId, p.groupId]))
      break
    }
    case 'answer_by_map': {
      const o = q.options as { imageMediaId: string, areas: Area[] }
      f.imageMediaId = o.imageMediaId
      f.areas = o.areas
      f.correctAreas = (a.areaIds as string[]) ?? []
      loadImage()
      break
    }
    case 'number': f.number = { value: Number(a.value ?? 0), tolerance: Number(a.tolerance ?? 0), toleranceType: (a.toleranceType as 'abs' | 'pct') ?? 'abs', unit: (a.unit as string) ?? '' }; break
    case 'text_short': f.accepted = ((a.accepted as string[]) ?? []).join('\n'); f.allowTypos = (a.allowTypos as number) ?? 0; f.caseSensitive = !!a.caseSensitive; break
    case 'free':
    case 'file': f.criteria = ((a.criteria as string[]) ?? []).join('\n'); f.reference = (a.reference as string) ?? ''; break
  }
}

async function loadImage() {
  if (!f.imageMediaId) return
  try {
    const m = await api<{ urls: Record<string, string> }>(`/media/${f.imageMediaId}`)
    imageUrl.value = m.urls['768'] || m.urls.original || ''
  }
  catch { imageUrl.value = '' }
}

async function pickImage(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  busy.value = true
  try {
    f.imageMediaId = await upload(file, file.name)
    await loadImage()
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

const addOption = () => f.options.push({ id: nid(), text: '' })
const removeOption = (id: string) => {
  f.options = f.options.filter(o => o.id !== id)
  f.correct = f.correct.filter(c => c !== id)
}
function toggleCorrect(id: string) {
  if (f.kind === 'single') f.correct = [id]
  else f.correct = f.correct.includes(id) ? f.correct.filter(c => c !== id) : [...f.correct, id]
}
function move(list: Opt[], i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j]!, list[i]!]
}
const addArea = () => f.areas.push({ id: nid(), shape: 'rect', x: 10, y: 10, w: 30, h: 30 })
const addTag = () => {
  const v = f.tagInput.trim()
  if (v && !f.tags.includes(v)) f.tags.push(v)
  f.tagInput = ''
}

const maxSelect = computed(() => f.correct.length)
const showScoring = computed(() => SCORED_KINDS.includes(f.kind))
const letter = (i: number) => String.fromCharCode(65 + i)

function build() {
  const stem = [{ id: 'b1', type: 'text', html: `<p>${f.text.trim()}</p>` }]
  const filled = (list: Opt[]) => list.filter(o => o.text.trim()).map(o => ({ id: o.id, text: o.text.trim() }))
  let options: unknown
  let answer: unknown
  switch (f.kind) {
    case 'single': options = filled(f.options); answer = { correctId: f.correct[0] ?? '' }; break
    case 'multi': options = filled(f.options); answer = { correctIds: f.correct }; break
    case 'ordering': options = filled(f.options); answer = { order: filled(f.options).map(o => o.id) }; break
    case 'comparison': {
      const left = filled(f.options)
      options = { left, right: filled(f.right) }
      answer = { pairs: left.filter(l => f.pairs[l.id]).map(l => ({ leftId: l.id, rightId: f.pairs[l.id]! })) }
      break
    }
    case 'classification': {
      const items = filled(f.options)
      options = { groups: f.groups.filter(g => g.title.trim()).map(g => ({ id: g.id, title: g.title.trim() })), items }
      answer = { placements: items.filter(i => f.placements[i.id]).map(i => ({ itemId: i.id, groupId: f.placements[i.id]! })) }
      break
    }
    case 'answer_by_map':
      options = { imageMediaId: f.imageMediaId, areas: f.areas.map(a => ({ id: a.id, shape: 'rect', x: a.x / 100, y: a.y / 100, w: a.w / 100, h: a.h / 100 })) }
      answer = { areaIds: f.correctAreas }
      break
    case 'number': answer = { value: f.number.value, tolerance: f.number.tolerance, toleranceType: f.number.toleranceType, ...(f.number.unit ? { unit: f.number.unit } : {}) }; break
    case 'text_short': answer = { accepted: f.accepted.split('\n').map(s => s.trim()).filter(Boolean), allowTypos: f.allowTypos, caseSensitive: f.caseSensitive }; break
    case 'free':
    case 'file': answer = { criteria: f.criteria.split('\n').map(s => s.trim()).filter(Boolean), ...(f.reference.trim() ? { reference: f.reference.trim() } : {}) }; break
  }
  return {
    bankId: f.bankId,
    kind: f.kind,
    questionGroupId: f.questionGroupId || null,
    stem,
    options,
    answer,
    explanation: f.explanation.trim() ? [{ id: 'e1', type: 'text', html: `<p>${f.explanation.trim()}</p>` }] : undefined,
    graderHint: f.kind === 'free' ? (f.graderHint.trim() || null) : null,
    attachFiles: f.kind === 'free' ? f.attachFiles : false,
    scoringMethod: f.scoringMethod,
    negativeMarking: f.negativeMarking,
    points: f.points,
    tags: f.tags,
    isCritical: f.isCritical,
    difficulty: f.difficulty,
  }
}

async function save() {
  error.value = ''
  busy.value = true
  try {
    const body = build()
    if (isNew) {
      const q = await api<{ id: string }>('/questions', { method: 'POST', body })
      if (quizId) await api(`/tests/${quizId}/questions/import`, { method: 'POST', body: { mode: 'link', questionIds: [q.id] } })
    }
    else {
      const { bankId: _b, ...rest } = body
      await api(`/questions/${questionId}`, { method: 'PATCH', body: rest })
    }
    await router.push(quizId ? `/admin/quizzes/${quizId}` : '/admin/quizzes')
  }
  catch (err) {
    error.value = apiErrorOf(err).message
  }
  finally {
    busy.value = false
  }
}

const title = computed(() => quiz.value
  ? t('questionEditor.titleInQuiz', { quiz: quiz.value.quiz.title, n: position.value ?? '' })
  : isNew ? t('questionEditor.newTitle') : t('questionEditor.editTitle'))
</script>

<template>
  <div>
    <PageHeader :title="title" :crumbs="[{ label: t('admin.section.content') }, { label: t('admin.nav.quizzes'), to: '/admin/quizzes' }]">
      <template #actions>
        <NuxtLink :to="quizId ? `/admin/quizzes/${quizId}` : '/admin/quizzes'" class="btn ghost">{{ t('common.cancel') }}</NuxtLink>
        <button class="btn primary" :disabled="busy || f.text.trim().length < 3 || !f.bankId" @click="save">{{ t('questionEditor.saveExit') }}</button>
      </template>
    </PageHeader>

    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="inSnapshots" class="note sun">{{ t('questionEditor.inSnapshots') }}</p>

    <div class="chips kinds" role="tablist" :aria-label="t('questionEditor.kind')">
      <button v-for="k in ETALON_KINDS" :key="k" role="tab" :aria-selected="f.kind === k" :class="['chip', { on: f.kind === k }]" @click="f.kind = k">{{ t(`questionEditor.kinds.${k}`) }}</button>
      <span class="sep" aria-hidden="true">·</span>
      <button v-for="k in EXTRA_KINDS" :key="k" role="tab" :aria-selected="f.kind === k" :class="['chip', 'outline', { on: f.kind === k }]" @click="f.kind = k">{{ t(`questionEditor.kinds.${k}`) }}</button>
    </div>

    <div class="layout">
      <section class="main">
        <label class="label" for="q-text">{{ t('questionEditor.text') }}</label>
        <textarea id="q-text" v-model="f.text" class="field" rows="3" :placeholder="t(`questionEditor.placeholders.${f.kind}`)" />

        <!-- single / multi / ordering: варианты-карточки -->
        <template v-if="f.kind === 'single' || f.kind === 'multi' || f.kind === 'ordering'">
          <h2 class="label">{{ t('questionEditor.options') }}</h2>
          <div v-for="(o, i) in f.options" :key="o.id" class="opt-card">
            <span v-if="f.kind === 'ordering'" class="n">{{ i + 1 }}</span>
            <input
              v-else
              :type="f.kind === 'single' ? 'radio' : 'checkbox'"
              :checked="f.correct.includes(o.id)"
              :aria-label="t('questionEditor.correct')"
              name="correct"
              @change="toggleCorrect(o.id)"
            >
            <input v-model="o.text" class="field" :placeholder="`${t('quizAdmin.option')} ${i + 1}`">
            <template v-if="f.kind === 'ordering'">
              <button class="btn ghost small" type="button" :aria-label="t('questionEditor.up')" :disabled="i === 0" @click="move(f.options, i, -1)">↑</button>
              <button class="btn ghost small" type="button" :aria-label="t('questionEditor.down')" :disabled="i === f.options.length - 1" @click="move(f.options, i, 1)">↓</button>
            </template>
            <button class="btn ghost small" type="button" :aria-label="t('questionEditor.remove')" @click="removeOption(o.id)">✕</button>
          </div>
          <button class="btn ghost" type="button" @click="addOption">+ {{ t('questionEditor.addOption') }}</button>
          <p v-if="f.kind === 'ordering'" class="help">{{ t('questionEditor.orderingHint') }}</p>
        </template>

        <!-- free: підказка для перевіряючого + файли -->
        <template v-else-if="f.kind === 'free'">
          <label class="label" for="q-hint">{{ t('questionEditor.graderHint') }}</label>
          <textarea id="q-hint" v-model="f.graderHint" class="field" rows="3" :placeholder="t('questionEditor.graderHintPh')" />
          <label class="toggle">
            <input v-model="f.attachFiles" type="checkbox">
            <span>{{ t('questionEditor.attachFiles') }}</span>
          </label>
          <label class="label" for="q-criteria">{{ t('quizAdmin.criteria') }}</label>
          <textarea id="q-criteria" v-model="f.criteria" class="field" rows="2" />
        </template>

        <!-- classification: класи + таблиця Варіанти | Класи -->
        <template v-else-if="f.kind === 'classification'">
          <h2 class="label">{{ t('questionEditor.classes') }}</h2>
          <div v-for="(g, i) in f.groups" :key="g.id" class="opt-card">
            <span class="n">{{ letter(i) }}</span>
            <input v-model="g.title" class="field" :placeholder="t('questionEditor.classPh')">
            <button class="btn ghost small" type="button" :aria-label="t('questionEditor.remove')" @click="f.groups = f.groups.filter(x => x.id !== g.id)">✕</button>
          </div>
          <button class="btn ghost" type="button" @click="f.groups.push({ id: nid(), title: '' })">+ {{ t('questionEditor.addClass') }}</button>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>{{ t('questionEditor.options') }}</th><th>{{ t('questionEditor.classes') }}</th><th /></tr></thead>
              <tbody>
                <tr v-for="(o, i) in f.options" :key="o.id">
                  <td><input v-model="o.text" class="field" :placeholder="`${t('quizAdmin.option')} ${i + 1}`"></td>
                  <td>
                    <select v-model="f.placements[o.id]" class="field" :aria-label="t('questionEditor.classes')">
                      <option value="">—</option>
                      <option v-for="g in f.groups" :key="g.id" :value="g.id">{{ g.title || '…' }}</option>
                    </select>
                  </td>
                  <td><button class="btn ghost small" type="button" :aria-label="t('questionEditor.remove')" @click="removeOption(o.id)">✕</button></td>
                </tr>
              </tbody>
            </table>
          </div>
          <button class="btn ghost" type="button" @click="addOption">+ {{ t('questionEditor.addOption') }}</button>
        </template>

        <!-- comparison: дві колонки -->
        <template v-else-if="f.kind === 'comparison'">
          <div class="cols">
            <div>
              <h2 class="label">{{ t('questionEditor.options') }}</h2>
              <div v-for="(o, i) in f.options" :key="o.id" class="opt-card">
                <span class="n">{{ i + 1 }}</span>
                <input v-model="o.text" class="field">
                <select v-model="f.pairs[o.id]" class="field pair" :aria-label="t('questionEditor.pairs')">
                  <option value="">—</option>
                  <option v-for="(r, j) in f.right" :key="r.id" :value="r.id">{{ letter(j) }}</option>
                </select>
                <button class="btn ghost small" type="button" :aria-label="t('questionEditor.remove')" @click="removeOption(o.id)">✕</button>
              </div>
              <button class="btn ghost" type="button" @click="addOption">+ {{ t('questionEditor.addOption') }}</button>
            </div>
            <div>
              <h2 class="label">{{ t('questionEditor.pairs') }}</h2>
              <div v-for="(r, j) in f.right" :key="r.id" class="opt-card">
                <span class="n">{{ letter(j) }}</span>
                <input v-model="r.text" class="field">
                <button class="btn ghost small" type="button" :aria-label="t('questionEditor.remove')" @click="f.right = f.right.filter(x => x.id !== r.id)">✕</button>
              </div>
              <button class="btn ghost" type="button" @click="f.right.push({ id: nid(), text: '' })">+ {{ t('questionEditor.addDistractor') }}</button>
            </div>
          </div>
        </template>

        <!-- answer_by_map: зображення 16:9 та області -->
        <template v-else-if="f.kind === 'answer_by_map'">
          <label class="label" for="q-image">{{ t('questionEditor.image') }}</label>
          <input id="q-image" type="file" accept="image/jpeg,image/png,image/gif,image/svg+xml,image/webp" class="field" @change="pickImage">
          <div v-if="imageUrl" class="map">
            <img :src="imageUrl" alt="">
            <div
              v-for="a in f.areas"
              :key="a.id"
              :class="['area', { on: f.correctAreas.includes(a.id) }]"
              :style="{ left: `${a.x}%`, top: `${a.y}%`, width: `${a.w}%`, height: `${a.h}%` }"
            />
          </div>
          <div v-for="(a, i) in f.areas" :key="a.id" class="opt-card area-row">
            <input type="checkbox" :checked="f.correctAreas.includes(a.id)" :aria-label="t('questionEditor.correct')" @change="f.correctAreas = f.correctAreas.includes(a.id) ? f.correctAreas.filter(x => x !== a.id) : [...f.correctAreas, a.id]">
            <span class="n">{{ i + 1 }}</span>
            <label>x% <input v-model.number="a.x" type="number" min="0" max="100" class="field num"></label>
            <label>y% <input v-model.number="a.y" type="number" min="0" max="100" class="field num"></label>
            <label>w% <input v-model.number="a.w" type="number" min="1" max="100" class="field num"></label>
            <label>h% <input v-model.number="a.h" type="number" min="1" max="100" class="field num"></label>
            <button class="btn ghost small" type="button" :aria-label="t('questionEditor.remove')" @click="f.areas = f.areas.filter(x => x.id !== a.id)">✕</button>
          </div>
          <button class="btn ghost" type="button" @click="addArea">+ {{ t('questionEditor.addArea') }}</button>
          <p class="help">{{ t('questionEditor.areasHint') }}</p>
        </template>

        <template v-else-if="f.kind === 'number'">
          <div class="cols">
            <label class="label">{{ t('quizAdmin.value') }}<input v-model.number="f.number.value" type="number" step="any" class="field"></label>
            <label class="label">{{ t('quizAdmin.tolerance') }}<input v-model.number="f.number.tolerance" type="number" step="any" min="0" class="field"></label>
            <label class="label">{{ t('questionEditor.toleranceType') }}
              <select v-model="f.number.toleranceType" class="field"><option value="abs">abs</option><option value="pct">%</option></select>
            </label>
            <label class="label">{{ t('questionEditor.unit') }}<input v-model="f.number.unit" class="field" maxlength="20"></label>
          </div>
        </template>

        <template v-else-if="f.kind === 'text_short'">
          <label class="label" for="q-accepted">{{ t('quizAdmin.accepted') }}</label>
          <textarea id="q-accepted" v-model="f.accepted" class="field" rows="3" />
          <label class="label">{{ t('questionEditor.allowTypos') }} <input v-model.number="f.allowTypos" type="number" min="0" max="2" class="field num"></label>
          <label class="toggle"><input v-model="f.caseSensitive" type="checkbox"><span>{{ t('questionEditor.caseSensitive') }}</span></label>
        </template>

        <template v-else-if="f.kind === 'file'">
          <label class="label" for="q-criteria-file">{{ t('quizAdmin.criteria') }}</label>
          <textarea id="q-criteria-file" v-model="f.criteria" class="field" rows="2" />
        </template>

        <label class="label" for="q-expl">{{ t('questionEditor.explanation') }}</label>
        <textarea id="q-expl" v-model="f.explanation" class="field" rows="2" />
      </section>

      <aside class="card side">
        <h2 class="panel-title">{{ t('questionEditor.params') }}</h2>

        <label class="label" for="q-group">{{ t('questionEditor.group') }}</label>
        <select id="q-group" v-model="f.questionGroupId" class="field" :disabled="!quiz">
          <option value="">—</option>
          <option v-for="g in quiz?.groups ?? []" :key="g.id" :value="g.id">{{ g.title }}</option>
        </select>
        <p class="help">{{ t('questionEditor.groupHint') }}</p>

        <template v-if="f.kind === 'multi'">
          <p class="label">{{ t('questionEditor.maxSelect') }}</p>
          <p class="value">{{ maxSelect }}</p>
        </template>

        <template v-if="showScoring">
          <p class="label">{{ t('questionEditor.scoringMethod') }}</p>
          <div class="segmented" role="radiogroup" :aria-label="t('questionEditor.scoringMethod')">
            <button type="button" role="radio" :aria-checked="f.scoringMethod === 'formula'" :class="{ on: f.scoringMethod === 'formula' }" @click="f.scoringMethod = 'formula'">{{ t('questionEditor.formula') }}</button>
            <button type="button" role="radio" :aria-checked="f.scoringMethod === 'all_or_nothing'" :class="{ on: f.scoringMethod === 'all_or_nothing' }" @click="f.scoringMethod = 'all_or_nothing'">{{ t('questionEditor.allOrNothing') }}</button>
          </div>
          <p class="help">{{ t('questionEditor.formulaHint') }}</p>
          <label v-if="f.kind === 'multi' || f.kind === 'answer_by_map'" class="toggle"><input v-model="f.negativeMarking" type="checkbox"><span>{{ t('questionEditor.negativeMarking') }}</span></label>
        </template>

        <label class="label" for="q-points">{{ t('questionEditor.points') }}</label>
        <input id="q-points" v-model.number="f.points" type="number" min="0.1" max="100" step="0.1" class="field">

        <label class="label" for="q-tags">{{ t('questionEditor.tags') }}</label>
        <div class="chips">
          <button v-for="tg in f.tags" :key="tg" type="button" class="chip on" :aria-label="`${t('questionEditor.remove')} ${tg}`" @click="f.tags = f.tags.filter(x => x !== tg)">{{ tg }} ✕</button>
        </div>
        <input id="q-tags" v-model="f.tagInput" class="field" :placeholder="t('questionEditor.tagPh')" @keydown.enter.prevent="addTag" @blur="addTag">

        <label v-if="isNew" class="label" for="q-bank">{{ t('quizAdmin.bank') }}</label>
        <select v-if="isNew" id="q-bank" v-model="f.bankId" class="field">
          <option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>

        <label class="toggle"><input v-model="f.isCritical" type="checkbox"><span>{{ t('quizAdmin.critical') }}<span class="hint">{{ t('questionEditor.criticalHint') }}</span></span></label>
        <label class="label" for="q-diff">{{ t('questionEditor.difficulty') }}</label>
        <input id="q-diff" v-model.number="f.difficulty" type="range" min="1" max="5">
      </aside>
    </div>
  </div>
</template>

<style scoped>
.kinds { margin-bottom: var(--space-4); }
.sep { color: var(--color-ink-faint); }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: var(--space-4); align-items: start; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
.main { display: grid; gap: var(--space-3); }
.side { display: grid; gap: var(--space-2); position: sticky; top: var(--space-4); }
.opt-card { display: flex; align-items: center; gap: var(--space-2); background: var(--color-bg-soft); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); }
.opt-card .field { flex: 1; min-width: 0; }
.opt-card .pair { flex: 0 0 72px; }
.n { width: 24px; height: 24px; flex: none; border-radius: var(--radius-pill); background: var(--color-ink); color: var(--color-bg); display: grid; place-items: center; font-size: var(--font-size-body-s); font-weight: 800; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
@media (max-width: 600px) { .cols { grid-template-columns: 1fr; } }
.num { width: 72px; }
.area-row label { display: flex; align-items: center; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.map { position: relative; aspect-ratio: 16 / 9; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
.map img { width: 100%; height: 100%; object-fit: contain; display: block; }
.area { position: absolute; border: 2px dashed var(--color-coral); border-radius: var(--radius-s); }
.area.on { border-style: solid; border-color: var(--color-teal); background: color-mix(in srgb, var(--color-teal) 25%, transparent); }
.value { margin: 0; font-size: 28px; font-weight: 900; }
input[type="range"] { width: 100%; }
</style>

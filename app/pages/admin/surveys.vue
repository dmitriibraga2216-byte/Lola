<script setup lang="ts">
/**
 * Опитування за мокапом ContentPolls: назва · питань · режим · приватність · дата зміни · опубліковано.
 * Редактор (docs/20 §14.5, §14.7): чотири типи питання (одиночне · множинне · вільна відповідь · по шкалі),
 * «або Свій варіант відповіді», режим «з умовами» (перехід за варіантом), конфіденційно / анонімно.
 * Після першої відповіді питання і приватність заморожені — сервер відповідає 409.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'survey.manage' })
const { t } = useI18n()
const { api } = useApi()
interface Opt { id: string, text: string }
interface Next { optionId?: string, goTo: string }
interface Q { id: string, type: 'single' | 'multi' | 'free' | 'scale', text: string, options?: Opt[], allowOwnOption?: boolean, allowFiles?: boolean, scaleId?: string, required?: boolean, next?: Next[] }
interface S { id: string, title: string, kind: string, status: string, mode: string, isAnonymous: boolean, isConfidential: boolean, showResults: boolean, isLocked: boolean, tags: string[], questions: number, responses: number, updatedAt: string, triggerCourseId: string | null }
interface Full extends Omit<S, 'questions'> { description: string | null, questions: Q[] }
interface Report { title: string, total: number, hidden: boolean, threshold?: number, isOwner: boolean, isConfidential: boolean, isAnonymous: boolean, questions: { id: string, text: string, type: string, answered: number, avg?: number | null, distribution?: Record<string, number>, own?: string[], texts?: string[], scale?: string | null }[], respondents: { id: string, name: string | null, submittedAt: string, answers: Record<string, string[]> }[] | null }
const items = ref<S[]>([])
const courses = ref<{ id: string, title: string }[]>([])
const scales = ref<{ id: string, name: string }[]>([])
const report = ref<Report | null>(null)
const error = ref('')
const notice = ref('')
const editing = ref<string | null>(null)
const showForm = ref(false)
const blank = () => ({ title: '', description: '', kind: 'survey', mode: 'linear', isAnonymous: false, isConfidential: false, showResults: false, isLocked: false, tags: '', triggerCourseId: '', questions: [] as Q[] })
const form = reactive(blank())
let seq = 1
const qid = () => `q${Date.now().toString(36)}${seq++}`
const newQ = (type: Q['type'] = 'single'): Q => ({ id: qid(), type, text: '', required: true, options: type === 'single' || type === 'multi' ? [{ id: 'o1', text: '' }, { id: 'o2', text: '' }] : undefined })
async function load() {
  try {
    items.value = await api<S[]>('/surveys')
    courses.value = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(c => c.status === 'published')
    scales.value = await api('/scales?kind=levels')
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
function create() { editing.value = null; Object.assign(form, blank()); form.questions = [newQ()]; showForm.value = true }
async function edit(s: S) {
  const f = await api<Full>(`/surveys/${s.id}`)
  editing.value = s.id
  Object.assign(form, { title: f.title, description: f.description ?? '', kind: f.kind, mode: f.mode, isAnonymous: f.isAnonymous, isConfidential: f.isConfidential, showResults: f.showResults, isLocked: f.isLocked, tags: f.tags.join(', '), triggerCourseId: f.triggerCourseId ?? '', questions: f.questions.map(q => ({ ...q, options: q.options ? [...q.options] : undefined, next: q.next ? [...q.next] : undefined })) })
  showForm.value = true
}
function setType(q: Q, type: Q['type']) {
  q.type = type
  if (type === 'single' || type === 'multi') q.options ??= [{ id: 'o1', text: '' }, { id: 'o2', text: '' }]
  else { q.options = undefined; q.allowOwnOption = undefined; q.next = undefined }
}
function addOption(q: Q) { q.options!.push({ id: `o${q.options!.length + 1}${Date.now().toString(36).slice(-2)}`, text: '' }) }
function nextFor(q: Q, optionId?: string) { return q.next?.find(n => n.optionId === optionId)?.goTo ?? '' }
function setNext(q: Q, optionId: string | undefined, goTo: string) {
  q.next = (q.next ?? []).filter(n => n.optionId !== optionId)
  if (goTo) q.next.push({ optionId, goTo })
  if (!q.next.length) q.next = undefined
}
function payload() {
  return {
    title: form.title, description: form.description || null, kind: form.kind, mode: form.mode, isAnonymous: form.isAnonymous, isConfidential: form.isConfidential, showResults: form.showResults,
    tags: form.tags.split(',').map(s => s.trim()).filter(Boolean), triggerCourseId: form.kind === 'course_feedback' && form.triggerCourseId ? form.triggerCourseId : null,
    questions: form.questions.filter(q => q.text.trim()).map(q => ({ ...q, options: q.options?.filter(o => o.text.trim()), next: form.mode === 'conditional' ? q.next : undefined, scaleId: q.type === 'scale' ? (q.scaleId || undefined) : undefined })),
  }
}
async function save(activate = false) {
  error.value = ''; notice.value = ''
  try {
    if (editing.value) await api(`/surveys/${editing.value}`, { method: 'PATCH', body: { ...payload(), ...(activate ? { status: 'active' } : {}) } })
    else { const s = await api<{ id: string }>('/surveys', { method: 'POST', body: payload() }); if (activate) await api(`/surveys/${s.id}`, { method: 'PATCH', body: { status: 'active' } }) }
    notice.value = t('common.saved'); showForm.value = false; await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
async function showReport(s: S) { try { report.value = await api(`/surveys/${s.id}/report`) } catch (err) { error.value = apiErrorOf(err).message } }
async function setStatus(s: S, status: string) { try { await api(`/surveys/${s.id}`, { method: 'PATCH', body: { status } }); await load() } catch (err) { error.value = apiErrorOf(err).message } }
const fmt = (d: string) => new Date(d).toLocaleDateString('uk')
const privacy = (s: S) => s.isAnonymous ? t('survey.privacy.anonymous') : s.isConfidential ? t('survey.privacy.confidential') : t('survey.privacy.open')
</script>
<template>
  <div>
    <PageHeader :title="t('admin.nav.surveys')" :crumbs="[{ label: t('admin.section.content') }]">
      <template #actions><button class="btn primary" @click="create">{{ t('common.add') }}</button></template>
    </PageHeader>
    <p v-if="error" class="note coral">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>
    <div class="table-wrap">
      <table class="table">
        <thead><tr><th>{{ t('assess.col.title') }}</th><th class="num">{{ t('survey.col.questions') }}</th><th>{{ t('survey.col.mode') }}</th><th>{{ t('survey.col.privacy') }}</th><th>{{ t('assess.col.updated') }}</th><th>{{ t('assess.col.published') }}</th><th /></tr></thead>
        <tbody>
          <tr v-for="s in items" :key="s.id">
            <td><b>{{ s.title }}</b><span class="sub">{{ t(`survey.kind.${s.kind}`) }} · {{ s.responses }} {{ t('survey.responses') }}<template v-if="s.isLocked"> · {{ t('assess.lockedShort') }}</template></span></td>
            <td class="num">{{ s.questions }}</td><td>{{ t(`survey.mode.${s.mode}`) }}</td><td>{{ privacy(s) }}</td><td>{{ fmt(s.updatedAt) }}</td>
            <td><span :class="['badge', s.status]">{{ t(`survey.status.${s.status}`) }}</span></td>
            <td class="acts">
              <button class="chip" @click="edit(s)">{{ t('common.edit') }}</button>
              <button class="chip" @click="showReport(s)">{{ t('survey.report') }}</button>
              <button v-if="s.status !== 'active'" class="chip" @click="setStatus(s, 'active')">{{ t('common.activate') }}</button>
              <button v-else class="chip" @click="setStatus(s, 'closed')">{{ t('survey.close') }}</button>
            </td>
          </tr>
          <tr v-if="!items.length"><td colspan="7" class="sub">{{ t('survey.empty') }}</td></tr>
        </tbody>
      </table>
    </div>

    <section v-if="showForm" class="card editor">
      <h2>{{ editing ? t('common.edit') : t('survey.new') }}</h2>
      <p v-if="form.isLocked" class="note coral" data-testid="survey-locked">{{ t('survey.lockedBanner') }}</p>
      <div class="row">
        <input v-model="form.title" class="field grow" :placeholder="t('survey.titleHint')" data-testid="survey-title">
        <select v-model="form.kind" class="field" :disabled="form.isLocked"><option value="survey">{{ t('survey.kind.survey') }}</option><option value="course_feedback">{{ t('survey.kind.course_feedback') }}</option><option value="poll">{{ t('survey.kind.poll') }}</option></select>
        <select v-if="form.kind === 'course_feedback'" v-model="form.triggerCourseId" class="field"><option value="">{{ t('assign.pickCourse') }}</option><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
      </div>
      <textarea v-model="form.description" class="field" rows="2" :placeholder="t('survey.descriptionHint')" />
      <div class="row">
        <div class="label">{{ t('survey.modeLabel') }}</div>
        <div class="segmented" role="radiogroup">
          <button v-for="m in ['linear', 'conditional']" :key="m" type="button" role="radio" :aria-checked="form.mode === m" :class="{ on: form.mode === m }" :disabled="form.isLocked" @click="form.mode = m">{{ t(`survey.mode.${m}`) }}</button>
        </div>
      </div>
      <div class="row">
        <label class="toggle"><input v-model="form.isConfidential" type="checkbox" :disabled="form.isLocked"><span>{{ t('survey.confidential') }}<span class="hint">{{ t('survey.confidentialHint') }}</span></span></label>
        <label class="toggle"><input v-model="form.isAnonymous" type="checkbox" :disabled="form.isLocked"><span>{{ t('survey.anonymousLabel') }}<span class="hint">{{ t('survey.anonymousHint') }}</span></span></label>
        <label class="toggle"><input v-model="form.showResults" type="checkbox"><span>{{ t('survey.showResults') }}</span></label>
      </div>
      <input v-model="form.tags" class="field" :placeholder="t('assess.tagsHint')">

      <h3>{{ t('survey.questionsTitle') }}</h3>
      <div v-for="(q, i) in form.questions" :key="q.id" class="q" :data-testid="`q-${i}`">
        <div class="row">
          <span class="qn">{{ i + 1 }}</span>
          <select :value="q.type" class="field" :disabled="form.isLocked" :aria-label="t('survey.qType')" @change="setType(q, ($event.target as HTMLSelectElement).value as Q['type'])">
            <option v-for="k in ['single', 'multi', 'free', 'scale']" :key="k" :value="k">{{ t(`survey.qtype.${k}`) }}</option>
          </select>
          <input v-model="q.text" class="field grow" :placeholder="t('survey.questionHint')" :disabled="form.isLocked">
          <label class="check"><input v-model="q.required" type="checkbox" :disabled="form.isLocked"> {{ t('survey.required') }}</label>
          <button class="chip" :disabled="form.isLocked" :aria-label="t('common.delete')" @click="form.questions.splice(i, 1)">✕</button>
        </div>
        <template v-if="q.options">
          <div v-for="(o, j) in q.options" :key="o.id" class="row opt">
            <input v-model="o.text" class="field grow" :placeholder="`${t('survey.option')} ${j + 1}`" :disabled="form.isLocked">
            <select v-if="form.mode === 'conditional' && q.type === 'single'" :value="nextFor(q, o.id)" class="field" :disabled="form.isLocked" :aria-label="t('survey.goTo')" @change="setNext(q, o.id, ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('survey.goToNext') }}</option>
              <option v-for="(other, k) in form.questions.filter(x => x.id !== q.id)" :key="other.id" :value="other.id">→ {{ k + 1 }}. {{ other.text || '…' }}</option>
              <option value="end">{{ t('survey.goToEnd') }}</option>
            </select>
            <button class="chip" :disabled="form.isLocked || q.options.length <= 2" :aria-label="t('common.delete')" @click="q.options.splice(j, 1)">✕</button>
          </div>
          <div class="row">
            <button class="chip outline" :disabled="form.isLocked" @click="addOption(q)">+ {{ t('survey.addOption') }}</button>
            <label class="check"><input v-model="q.allowOwnOption" type="checkbox" :disabled="form.isLocked"> {{ t('survey.ownOption') }}</label>
          </div>
        </template>
        <label v-if="q.type === 'free'" class="check"><input v-model="q.allowFiles" type="checkbox" :disabled="form.isLocked"> {{ t('survey.allowFiles') }}</label>
        <div v-if="q.type === 'scale'" class="row">
          <label class="sub">{{ t('assess.scaleField') }} <select v-model="q.scaleId" class="field" :disabled="form.isLocked"><option value="">1–5</option><option v-for="s in scales" :key="s.id" :value="s.id">{{ s.name }}</option></select></label>
        </div>
        <div v-if="form.mode === 'conditional'" class="row">
          <label class="sub">{{ t('survey.defaultNext') }} <select :value="nextFor(q)" class="field" :disabled="form.isLocked" @change="setNext(q, undefined, ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('survey.goToNext') }}</option>
            <option v-for="(other, k) in form.questions.filter(x => x.id !== q.id)" :key="other.id" :value="other.id">→ {{ k + 1 }}. {{ other.text || '…' }}</option>
            <option value="end">{{ t('survey.goToEnd') }}</option>
          </select></label>
        </div>
      </div>
      <div class="row">
        <button class="chip outline" :disabled="form.isLocked" data-testid="q-add" @click="form.questions.push(newQ())">+ {{ t('survey.question') }}</button>
        <button class="btn ghost small" :disabled="form.title.length < 3 || !form.questions.some(q => q.text.trim())" data-testid="survey-save" @click="save(false)">{{ t('common.save') }}</button>
        <button class="btn primary small" :disabled="form.title.length < 3 || !form.questions.some(q => q.text.trim())" @click="save(true)">{{ t('survey.createActivate') }}</button>
        <button class="chip" @click="showForm = false">{{ t('common.cancel') }}</button>
      </div>
    </section>

    <div v-if="report" class="modal-backdrop" @click.self="report = null">
      <div class="modal" role="dialog" :aria-label="report.title">
        <h2>{{ report.title }} <span class="sub">· {{ report.total }} {{ t('survey.responses') }}</span></h2>
        <p v-if="report.hidden" class="note sun">{{ t('survey.hiddenThreshold', { n: report.threshold }) }}</p>
        <p v-if="report.isConfidential && !report.isOwner" class="note sun">{{ t('survey.confidentialNote') }}</p>
        <div v-for="q in report.questions" :key="q.id" class="rq">
          <b>{{ q.text }}</b> <span class="sub">({{ q.answered }})</span>
          <div v-if="q.avg !== undefined && q.avg !== null" class="avg">{{ t('survey.avg') }}: <b class="teal">{{ q.avg }}</b><span v-if="q.scale" class="sub"> · {{ q.scale }}</span></div>
          <div v-if="q.distribution" class="dist"><span v-for="(n, k) in q.distribution" :key="k" class="bar"><span>{{ k }}</span><i :style="{ width: `${n / Math.max(1, q.answered) * 100}%` }" /><span>{{ n }}</span></span></div>
          <ul v-if="q.own?.length" class="texts"><li v-for="(tx, i) in q.own" :key="i">{{ t('survey.ownShort') }}: {{ tx }}</li></ul>
          <ul v-if="q.texts" class="texts"><li v-for="(tx, i) in q.texts" :key="i">{{ tx }}</li></ul>
        </div>
        <div v-if="report.respondents?.length" class="rq">
          <b>{{ t('survey.respondents') }}</b>
          <ul class="texts"><li v-for="r in report.respondents" :key="r.id">{{ r.name ?? t('survey.noName') }} · {{ new Date(r.submittedAt).toLocaleDateString('uk') }}</li></ul>
        </div>
        <button class="chip" @click="report = null">{{ t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>
<style scoped>
h2, h3 { margin: 0; font-weight: 800; }
.note { margin: 0 0 var(--space-3); }
.acts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.editor { display: grid; gap: var(--space-3); margin-top: var(--space-4); }
.field { width: auto; }
.grow { flex: 1; min-width: 160px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.q { display: grid; gap: var(--space-2); background: var(--color-bg); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-3); }
.qn { font-weight: 900; color: var(--color-ink-muted); width: 24px; }
.opt { padding-left: var(--space-5); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); z-index: 10; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(560px, 100%); max-height: 85dvh; overflow: auto; display: grid; gap: var(--space-4); }
.rq { display: grid; gap: var(--space-2); }
.teal { color: var(--color-teal-ink); }
.dist { display: grid; gap: var(--space-1); }
.bar { display: grid; grid-template-columns: minmax(40px, auto) 1fr 30px; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.bar i { display: block; height: 12px; background: var(--color-teal); border-radius: var(--radius-pill); min-width: 2px; }
.texts { margin: 0; padding-left: var(--space-4); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
</style>

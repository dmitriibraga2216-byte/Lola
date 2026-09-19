<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'survey.manage' })
const { t } = useI18n()
const { api } = useApi()
interface S { id: string, title: string, kind: string, status: string, isAnonymous: boolean, responses: number, triggerCourseId: string | null }
interface Report { title: string, total: number, hidden: boolean, threshold?: number, questions: { id: string, text: string, type: string, answered: number, avg?: number | null, distribution?: Record<string, number>, texts?: string[] }[] }
const items = ref<S[]>([])
const courses = ref<{ id: string, title: string }[]>([])
const report = ref<Report | null>(null)
const error = ref('')
const form = reactive({ title: '', kind: 'survey', isAnonymous: false, triggerCourseId: '', questions: [{ id: 'q1', type: 'scale', text: '', required: true }] as { id: string, type: string, text: string, options?: string, required: boolean }[] })
async function load() {
  try { items.value = await api<S[]>('/surveys'); courses.value = (await api<{ id: string, title: string, status: string }[]>('/courses')).filter(c => c.status === 'published') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function create() {
  error.value = ''
  try {
    const s = await api<{ id: string }>('/surveys', { method: 'POST', body: { title: form.title, kind: form.kind, isAnonymous: form.isAnonymous, triggerCourseId: form.kind === 'course_feedback' && form.triggerCourseId ? form.triggerCourseId : null, questions: form.questions.filter(q => q.text.trim()).map(q => ({ id: q.id, type: q.type, text: q.text, required: q.required, options: q.type === 'choice' ? (q.options ?? '').split(',').map(s => s.trim()).filter(Boolean) : undefined })) } })
    await api(`/surveys/${s.id}`, { method: 'PATCH', body: { status: 'active' } })
    Object.assign(form, { title: '', questions: [{ id: 'q1', type: 'scale', text: '', required: true }] })
    await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
async function showReport(s: S) { report.value = await api(`/surveys/${s.id}/report`) }
async function close(s: S) { await api(`/surveys/${s.id}`, { method: 'PATCH', body: { status: 'closed' } }); await load() }
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.surveys') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('assign.col.kind') }}</th><th>{{ t('assign.col.status') }}</th><th>{{ t('survey.responses') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="s in items" :key="s.id">
          <td><b>{{ s.title }}</b><span v-if="s.isAnonymous" class="sub"> · {{ t('survey.anonymous') }}</span></td>
          <td class="sub">{{ t(`survey.kind.${s.kind}`) }}</td><td><span :class="['badge', s.status]">{{ t(`survey.status.${s.status}`) }}</span></td><td>{{ s.responses }}</td>
          <td class="acts"><button class="chip" @click="showReport(s)">{{ t('survey.report') }}</button><button v-if="s.status === 'active'" class="chip" @click="close(s)">{{ t('survey.close') }}</button></td>
        </tr>
      </tbody>
    </table>
    <section class="card">
      <h2>{{ t('survey.new') }}</h2>
      <div class="row">
        <input v-model="form.title" class="field grow" :placeholder="t('survey.titleHint')">
        <select v-model="form.kind"><option value="survey">{{ t('survey.kind.survey') }}</option><option value="course_feedback">{{ t('survey.kind.course_feedback') }}</option><option value="poll">{{ t('survey.kind.poll') }}</option></select>
        <select v-if="form.kind === 'course_feedback'" v-model="form.triggerCourseId"><option value="">{{ t('assign.pickCourse') }}</option><option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</option></select>
        <label class="check"><input v-model="form.isAnonymous" type="checkbox"> {{ t('survey.anonymous') }}</label>
      </div>
      <div v-for="(q, i) in form.questions" :key="q.id" class="row">
        <select v-model="q.type"><option value="scale">1–5</option><option value="yesno">{{ t('survey.yes') }}/{{ t('survey.no') }}</option><option value="choice">{{ t('survey.choice') }}</option><option value="text">{{ t('blocks.text') }}</option></select>
        <input v-model="q.text" class="field grow" :placeholder="t('survey.questionHint')">
        <input v-if="q.type === 'choice'" v-model="q.options" class="field" :placeholder="t('survey.optionsHint')">
        <label class="check"><input v-model="q.required" type="checkbox"> *</label>
        <button class="chip" @click="form.questions.splice(i, 1)">✕</button>
      </div>
      <button class="chip" @click="form.questions.push({ id: `q${form.questions.length + 1}`, type: 'scale', text: '', required: true })">+ {{ t('survey.question') }}</button>
      <button class="primary" :disabled="form.title.length < 3 || !form.questions.some(q => q.text.trim())" @click="create">{{ t('survey.createActivate') }}</button>
    </section>
    <div v-if="report" class="modal-backdrop" @click.self="report = null">
      <div class="modal">
        <h2>{{ report.title }} <span class="sub">· {{ report.total }} {{ t('survey.responses') }}</span></h2>
        <p v-if="report.hidden" class="hidden">{{ t('survey.hiddenThreshold', { n: report.threshold }) }}</p>
        <div v-for="q in report.questions" :key="q.id" class="rq">
          <b>{{ q.text }}</b> <span class="sub">({{ q.answered }})</span>
          <div v-if="q.avg !== undefined && q.avg !== null" class="avg">{{ t('survey.avg') }}: <b class="teal">{{ q.avg }}</b></div>
          <div v-if="q.distribution" class="dist"><span v-for="(n, k) in q.distribution" :key="k" class="bar"><span>{{ k }}</span><i :style="{ width: `${n / Math.max(1, q.answered) * 100}%` }" /><span>{{ n }}</span></span></div>
          <ul v-if="q.texts" class="texts"><li v-for="(tx, i) in q.texts" :key="i">{{ tx }}</li></ul>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.acts { display: flex; gap: var(--space-1); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.grow { flex: 1; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; justify-self: start; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.active { background: var(--color-teal); color: var(--color-teal-deep); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 40%); display: grid; place-items: center; padding: var(--space-4); }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-xl); padding: var(--space-5); width: min(560px, 100%); max-height: 85dvh; overflow: auto; display: grid; gap: var(--space-4); }
.hidden { background: var(--color-sun); color: var(--color-sun-ink); border-radius: var(--radius-m); padding: var(--space-3); margin: 0; }
.rq { display: grid; gap: var(--space-2); }
.teal { color: var(--color-teal-ink); }
.dist { display: grid; gap: var(--space-1); }
.bar { display: grid; grid-template-columns: 40px 1fr 30px; gap: var(--space-2); align-items: center; font-size: var(--font-size-body-s); }
.bar i { display: block; height: 12px; background: var(--color-teal); border-radius: var(--radius-pill); min-width: 2px; }
.texts { margin: 0; padding-left: var(--space-4); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
</style>

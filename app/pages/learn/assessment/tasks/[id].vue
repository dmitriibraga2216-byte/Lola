<script setup lang="ts">
const { formatTime } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const router = useRouter()
interface Opt { value: number, label: string }
interface Crit { id: string, text: string, description: string | null, norm: number }
interface Group { id: string, name: string, description: string | null, criteria: Crit[] }
interface FormRules { allowCommentGroups: boolean, commentGroupsRequired: boolean, commentWhenAboveNorm: boolean, commentWhenBelowNorm: boolean, commentWhenEqual: boolean, zeroMeansNoGrade: boolean }
interface Data { task: { id: string, status: string, raterKind: string }, cycle: { title: string, anonymousForSubject: boolean }, subject: { fullName: string }, structure: { form: FormRules, scale: { options: Opt[] }, groups: Group[] }, answers: { criterionId: string, value: number | null, comment: string | null, isNa: boolean }[], groupComments: Record<string, string>, commentsVisibleTo: string, isAnonymous: boolean, minRatersToShow: number, byProfile?: boolean }
const data = ref<Data | null>(null)
const answers = reactive<Record<string, { value: number | null, comment: string, isNa: boolean }>>({})
const groupComments = reactive<Record<string, string>>({})
const error = ref('')
const flagged = ref<string[]>([])
const saving = ref(false)
const savedAt = ref('')
const summary = ref(false)
// Мокап Assessment360: один критерій-група на екран, прогресбар зверху, «Далі» веде до наступної групи
// (на останній — до підсумку). Готовність рахує сервер відповідями, крок — лише навігація клієнта.
const step = ref(0)
let timer: ReturnType<typeof setTimeout> | null = null

onMounted(async () => {
  try {
    data.value = await api<Data>(`/assessment/tasks/${route.params.id}`)
    for (const g of data.value.structure.groups) for (const c of g.criteria) answers[c.id] = { value: null, comment: '', isNa: false }
    for (const a of data.value.answers) answers[a.criterionId] = { value: a.value, comment: a.comment ?? '', isNa: a.isNa }
    Object.assign(groupComments, data.value.groupComments ?? {})
  } catch (err) { error.value = apiErrorOf(err).message }
})
const all = computed(() => data.value?.structure.groups.flatMap(g => g.criteria) ?? [])
const done = computed(() => all.value.filter(c => answers[c.id]?.value != null || answers[c.id]?.isNa).length)
const progressPct = computed(() => all.value.length ? Math.round(done.value / all.value.length * 100) : 0)
const readOnly = computed(() => data.value?.task.status === 'submitted' || data.value?.task.status === 'expired')
const groups = computed(() => data.value?.structure.groups ?? [])
const currentGroup = computed(() => groups.value[step.value] ?? null)
const isLastStep = computed(() => step.value >= groups.value.length - 1)
function groupDone(g: Group): boolean {
  return g.criteria.every(c => answers[c.id]?.value != null || answers[c.id]?.isNa)
}
function nextStep() {
  if (!currentGroup.value || !groupDone(currentGroup.value)) return
  if (isLastStep.value) summary.value = true
  else step.value++
}
function prevStep() {
  if (step.value > 0) step.value--
}

function set(id: string, patch: Partial<{ value: number | null, comment: string, isNa: boolean }>) {
  if (readOnly.value) return
  Object.assign(answers[id]!, patch)
  if (patch.isNa) answers[id]!.value = null
  if (patch.value != null) answers[id]!.isNa = false
  if (timer) clearTimeout(timer)
  timer = setTimeout(save, 800)
}
async function save() {
  if (readOnly.value) return
  saving.value = true
  try {
    await api(`/assessment/tasks/${route.params.id}`, { method: 'PUT', body: { answers: Object.entries(answers).map(([criterionId, a]) => ({ criterionId, value: a.value, comment: a.comment || null, isNa: a.isNa })), groupComments } })
    savedAt.value = formatTime(new Date(), { hour: '2-digit', minute: '2-digit' })
  } catch (err) { error.value = apiErrorOf(err).message } finally { saving.value = false }
}
const groupAvg = (g: Group) => {
  const vals = g.criteria.map(c => answers[c.id]).filter(a => a && a.value != null).map(a => a!.value!)
  return vals.length ? (vals.reduce((x, y) => x + y, 0) / vals.length).toFixed(1) : '—'
}
async function submit() {
  error.value = ''; flagged.value = []
  if (timer) clearTimeout(timer)
  await save()
  try {
    await api(`/assessment/tasks/${route.params.id}/submit`, { method: 'POST' })
    router.push('/learn/assessment')
  } catch (err) {
    const e = apiErrorOf(err)
    error.value = e.message
    flagged.value = (e.details?.criterionIds as string[] | undefined) ?? []
    summary.value = false
  }
}
async function decline() {
  const reason = prompt(t('assess.declineWhy'))
  if (!reason) return
  try { await api(`/assessment/tasks/${route.params.id}/decline`, { method: 'POST', body: { reason } }); router.push('/learn/assessment') }
  catch (err) { error.value = apiErrorOf(err).message }
}
/** Правило комментирования против нормы (docs/20 §14.2): ниже нормы — обязателен, выше/при совпадении — разрешён. Считает сервер, клиент лишь показывает поле. */
function commentRule(c: Crit): 'required' | 'allowed' | 'none' {
  const f = data.value?.structure.form
  const v = answers[c.id]?.value
  if (!f || v == null || (f.zeroMeansNoGrade && v === 0)) return 'none'
  if (v < c.norm) return f.commentWhenBelowNorm ? 'required' : 'none'
  if (v > c.norm) return f.commentWhenAboveNorm ? 'allowed' : 'none'
  return f.commentWhenEqual ? 'allowed' : 'none'
}
const needsComment = (c: Crit) => commentRule(c) === 'required' && !answers[c.id]!.comment.trim()
const showComment = (c: Crit) => commentRule(c) !== 'none' || !!answers[c.id]?.comment
function setGroupComment(id: string, v: string) { groupComments[id] = v; if (timer) clearTimeout(timer); timer = setTimeout(save, 800) }
</script>
<template>
  <div v-if="data">
    <NuxtLink to="/learn/assessment" class="back">← {{ t('assess.title') }}</NuxtLink>
    <h1>{{ t('assess.rateTitle') }}</h1>
    <div class="who">{{ t('assess.youRate', { name: data.subject.fullName, role: t(`assess.kindAs.${data.task.raterKind}`) }) }}<template v-if="data.isAnonymous"> {{ t('assess.anonNote', { n: data.minRatersToShow }) }}</template></div>
    <p class="sub">{{ data.cycle.title }}<template v-if="data.byProfile"> · {{ t('assess.byProfile') }}</template></p>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="sticky">
      <span>{{ t('assess.progress', { n: done, total: all.length }) }}</span>
      <span class="sub">{{ saving ? t('assess.saving') : savedAt ? t('assess.savedAt', { time: savedAt }) : '' }}</span>
    </div>
    <div v-if="!summary && !readOnly" class="progress-bar" role="progressbar" :aria-valuenow="progressPct" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-fill" :style="{ width: `${progressPct}%` }" />
    </div>

    <!-- Крок-по-кроку: одна група критеріїв на екран (мокап Assessment360), «Далі» — до наступної -->
    <template v-if="!summary && !readOnly && currentGroup">
      <section :key="currentGroup.id" class="group">
        <h2 class="gname">{{ currentGroup.name }}</h2>
        <p v-if="currentGroup.description" class="sub">{{ currentGroup.description }}</p>
        <div v-for="c in currentGroup.criteria" :key="c.id" :class="['crit', { flag: flagged.includes(c.id) }]" :data-testid="`crit-${c.id}`">
          <div class="crit-text">{{ c.text }}</div>
          <div v-if="c.description" class="hint">{{ c.description }}</div>
          <div class="scale" role="radiogroup" :aria-label="c.text">
            <button v-for="o in data.structure.scale.options" :key="o.value" type="button" role="radio" :aria-checked="answers[c.id]?.value === o.value" :class="['opt', { on: answers[c.id]?.value === o.value }]" :disabled="readOnly" :title="o.label" @click="set(c.id, { value: o.value })">{{ o.value }}<small v-if="o.label !== String(o.value)">{{ o.label }}</small></button>
            <button type="button" :class="['opt', 'na', { on: answers[c.id]?.isNa }]" :disabled="readOnly" @click="set(c.id, { isNa: true })">{{ t('assess.na') }}</button>
          </div>
          <textarea v-if="(!readOnly && showComment(c)) || answers[c.id]?.comment" :value="answers[c.id]?.comment" :class="{ req: needsComment(c) }" :readonly="readOnly" rows="1" :placeholder="needsComment(c) ? t('assess.commentBelowNorm') : t('assess.comment')" :aria-label="t('assess.comment')" @input="set(c.id, { comment: ($event.target as HTMLTextAreaElement).value })" />
        </div>
        <textarea v-if="data.structure.form.allowCommentGroups && (!readOnly || groupComments[currentGroup.id])" :value="groupComments[currentGroup.id] ?? ''" :class="['gcomment', { req: data.structure.form.commentGroupsRequired && !(groupComments[currentGroup.id] ?? '').trim() }]" :readonly="readOnly" rows="2" :placeholder="data.structure.form.commentGroupsRequired ? t('assess.groupCommentRequired') : t('assess.groupComment')" :aria-label="t('assess.groupComment')" @input="setGroupComment(currentGroup.id, ($event.target as HTMLTextAreaElement).value)" />
      </section>
      <div class="actions">
        <button v-if="data.task.raterKind === 'peer' && step === 0" class="chip" @click="decline">{{ t('assess.decline') }}</button>
        <button v-if="step > 0" type="button" class="chip" @click="prevStep">{{ t('common.back') }}</button>
        <button class="primary" :disabled="!groupDone(currentGroup)" data-testid="to-summary" @click="nextStep">
          {{ isLastStep ? t('assess.review') : t('common.next') }}
        </button>
      </div>
    </template>

    <!-- Подана/протермінована оцінка — перегляд усіх груп одразу, без кроків -->
    <template v-else-if="!summary && readOnly">
      <section v-for="g in data.structure.groups" :key="g.id" class="group">
        <h2 class="gname">{{ g.name }}</h2>
        <p v-if="g.description" class="sub">{{ g.description }}</p>
        <div v-for="c in g.criteria" :key="c.id" class="crit" :data-testid="`crit-${c.id}`">
          <div class="crit-text">{{ c.text }}</div>
          <div v-if="c.description" class="hint">{{ c.description }}</div>
          <div class="scale" role="radiogroup" :aria-label="c.text">
            <button v-for="o in data.structure.scale.options" :key="o.value" type="button" role="radio" :aria-checked="answers[c.id]?.value === o.value" :class="['opt', { on: answers[c.id]?.value === o.value }]" disabled :title="o.label">{{ o.value }}<small v-if="o.label !== String(o.value)">{{ o.label }}</small></button>
            <button type="button" :class="['opt', 'na', { on: answers[c.id]?.isNa }]" disabled>{{ t('assess.na') }}</button>
          </div>
          <textarea v-if="answers[c.id]?.comment" :value="answers[c.id]?.comment" readonly rows="1" :aria-label="t('assess.comment')" />
        </div>
        <textarea v-if="groupComments[g.id]" :value="groupComments[g.id]" class="gcomment" readonly rows="2" :aria-label="t('assess.groupComment')" />
      </section>
    </template>
    <section v-else class="group">
      <h2>{{ t('assess.summary') }}</h2>
      <ul class="sum">
        <li v-for="g in data.structure.groups" :key="g.id"><span>{{ g.name }}</span><b>{{ groupAvg(g) }}</b></li>
      </ul>
      <p class="warn">{{ t('assess.commentsSeenBy', { who: data.commentsVisibleTo === 'manager' ? t('assess.seenManager') : t('assess.seenBoth') }) }}</p>
      <div class="actions">
        <button class="chip" @click="summary = false">{{ t('common.back') }}</button>
        <button class="primary" data-testid="submit" @click="submit">{{ t('assess.send') }}</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: var(--space-1) 0; }
.sticky { position: sticky; top: 0; background: var(--color-bg); padding: var(--space-2) 0; display: flex; justify-content: space-between; font-weight: 700; z-index: 2; }
.progress-bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; }
.progress-fill { height: 100%; background: var(--color-teal); border-radius: var(--radius-pill); }
.group { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-3); margin-top: var(--space-3); }
.crit { display: grid; gap: var(--space-1); padding-top: var(--space-2); border-top: 1px solid var(--color-bg-line-soft); }
.crit.flag { outline: 2px solid var(--color-coral); border-radius: var(--radius-m); padding: var(--space-2); }
.crit-text { font-weight: 700; }
.who { margin: var(--space-3) 0 0; font-weight: 700; line-height: 1.4; font-size: var(--font-size-body-s); background: var(--color-sun-soft); border: 2px solid var(--color-sun); border-radius: var(--radius-m); padding: var(--space-3); }
.gname { text-transform: uppercase; letter-spacing: 0.06em; font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.gcomment { margin-top: var(--space-2); }
.hint { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.scale { display: flex; flex-wrap: wrap; gap: var(--space-1); }
.opt { font: inherit; font-weight: 800; border: 1px solid var(--color-bg-line); background: var(--color-bg); border-radius: var(--radius-m); padding: var(--space-1) var(--space-2); min-width: 44px; display: grid; cursor: pointer; }
.opt small { font-weight: 500; font-size: 11px; color: var(--color-ink-muted); }
.opt.on { border-color: var(--color-ink); background: var(--color-ink); color: var(--color-bg); }
.opt.on small { color: var(--color-bg); }
.opt.na { color: var(--color-ink-muted); }
textarea { font: inherit; padding: var(--space-2); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); background: var(--color-bg); }
textarea.req { border-color: var(--color-coral-deep); }
.actions { display: flex; flex-wrap: wrap; gap: var(--space-2); justify-content: flex-end; margin: var(--space-3) 0; }
.chip, .primary { font: inherit; font-weight: 700; border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; }
.chip { border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); }
.primary { border: none; background: var(--color-sun); color: var(--color-ink); font-weight: 800; }
.primary:disabled { opacity: 0.5; }
.sum { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.sum li { display: flex; justify-content: space-between; }
.warn { background: var(--color-sun); color: var(--color-sun-ink); padding: var(--space-2); border-radius: var(--radius-m); margin: 0; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>

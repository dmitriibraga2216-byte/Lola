<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()

interface Q { id: string, type: 'scale' | 'yesno' | 'choice' | 'text', text: string, options?: string[], required?: boolean }
interface S { id: string, title: string, description: string | null, isAnonymous: boolean, closesAt: string | null, questions: Q[] }
const items = ref<S[]>([])
const active = ref<S | null>(null)
const answers = ref<Record<string, unknown>>({})
const error = ref('')
const notice = ref('')

async function load() {
  try { items.value = await api<S[]>('/learning/surveys') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function submit() {
  if (!active.value) return
  error.value = ''
  try {
    await api(`/learning/surveys/${active.value.id}/respond`, { method: 'POST', body: { answers: answers.value } })
    notice.value = t('survey.thanks')
    active.value = null
    answers.value = {}
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <h1>{{ t('survey.title') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>

    <template v-if="!active">
      <p v-if="items.length === 0" class="empty">{{ t('survey.empty') }}</p>
      <div class="list">
        <button v-for="s in items" :key="s.id" class="card" @click="active = s; answers = {}">
          <span class="card-title">{{ s.title }}</span>
          <span class="sub">{{ s.questions.length }} {{ t('survey.questions') }}{{ s.isAnonymous ? ` · ${t('survey.anonymous')}` : '' }}</span>
        </button>
      </div>
    </template>

    <div v-else class="form">
      <h2>{{ active.title }}</h2>
      <p v-if="active.description" class="sub">{{ active.description }}</p>
      <div v-for="q in active.questions" :key="q.id" class="q">
        <label class="q-text">{{ q.text }}<span v-if="q.required !== false" class="req">*</span></label>
        <div v-if="q.type === 'scale'" class="scale">
          <button v-for="n in 5" :key="n" :class="['opt', { on: answers[q.id] === n }]" @click="answers[q.id] = n">{{ n }}</button>
        </div>
        <div v-else-if="q.type === 'yesno'" class="scale">
          <button :class="['opt', { on: answers[q.id] === 'yes' }]" @click="answers[q.id] = 'yes'">{{ t('survey.yes') }}</button>
          <button :class="['opt', { on: answers[q.id] === 'no' }]" @click="answers[q.id] = 'no'">{{ t('survey.no') }}</button>
        </div>
        <div v-else-if="q.type === 'choice'" class="choices">
          <button v-for="o in q.options" :key="o" :class="['opt wide', { on: answers[q.id] === o }]" @click="answers[q.id] = o">{{ o }}</button>
        </div>
        <textarea v-else :value="String(answers[q.id] ?? '')" rows="3" @input="answers[q.id] = ($event.target as HTMLTextAreaElement).value" />
      </div>
      <div class="actions">
        <button class="ghost" @click="active = null">{{ t('common.cancel') }}</button>
        <button class="primary" @click="submit">{{ t('survey.send') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.list { display: grid; gap: var(--space-2); }
.card { font: inherit; text-align: left; background: var(--color-bg-soft); border: none; border-radius: var(--radius-m); padding: var(--space-3) var(--space-4); cursor: pointer; display: grid; gap: var(--space-1); color: var(--color-ink); }
.card-title { font-weight: 800; }
.form { display: grid; gap: var(--space-4); }
.q { display: grid; gap: var(--space-2); }
.q-text { font-weight: 700; }
.req { color: var(--color-coral-ink); }
.scale, .choices { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.opt { font: inherit; font-weight: 800; width: 48px; height: 48px; border: 2px solid var(--color-bg-line); background: var(--color-bg-soft); border-radius: var(--radius-pill); cursor: pointer; color: var(--color-ink); }
.opt.wide { width: auto; padding: 0 var(--space-4); border-radius: var(--radius-m); }
.opt.on { background: var(--color-ink); border-color: var(--color-ink); color: var(--color-bg-soft); }
textarea { font: inherit; border: 2px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-3); background: var(--color-bg-soft); color: var(--color-ink); }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.primary, .ghost { font: inherit; font-weight: 800; border: none; border-radius: var(--radius-pill); padding: var(--space-3) var(--space-5); cursor: pointer; }
.primary { background: var(--color-sun); color: var(--color-ink); }
.ghost { background: transparent; border: 1px solid var(--color-bg-line); color: var(--color-ink-muted); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-7); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>

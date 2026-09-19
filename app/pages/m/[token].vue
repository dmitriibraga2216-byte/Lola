<script setup lang="ts">
/** Тайный покупатель по одноразовой ссылке — без входа (docs/20 §7.8, Б.2). */
definePageMeta({ layout: false })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
interface Opt { value: number, label: string, color?: string }
interface Item { id: string, group?: string, text: string, scaleId: string, hint?: string }
interface Form { wave: string, checklist: { id: string, title: string, items: Item[] }, scales: { id: string, options: Opt[], allowNa: boolean }[], location: { name: string, address: string | null } | null, expiresAt: string }
const form = ref<Form | null>(null)
const error = ref('')
const answers = reactive<Record<string, { value: number | null, comment: string, isNa: boolean }>>({})
const startedAt = new Date().toISOString()
const done = ref<{ score: number, passed: boolean } | null>(null)
const busy = ref(false)
const flagged = ref<string[]>([])
onMounted(async () => {
  try { form.value = await api<Form>(`/public/mystery/${route.params.token}`); for (const it of form.value.checklist.items) answers[it.id] = { value: null, comment: '', isNa: false } }
  catch (err) { error.value = apiErrorOf(err).message }
})
const groups = computed(() => { const m = new Map<string, Item[]>(); for (const it of form.value?.checklist.items ?? []) { const g = it.group || ''; m.set(g, [...(m.get(g) ?? []), it]) } return [...m] })
const scaleOf = (it: Item) => form.value?.scales.find(s => s.id === it.scaleId)
const answered = computed(() => Object.values(answers).filter(a => a.value != null || a.isNa).length)
async function submit() {
  busy.value = true; error.value = ''; flagged.value = []
  try {
    done.value = await api(`/public/mystery/${route.params.token}`, { method: 'POST', body: { answers: Object.entries(answers).map(([itemId, a]) => ({ itemId, value: a.value, comment: a.comment || null, isNa: a.isNa })), startedAt } })
  }
  catch (err) { const e = apiErrorOf(err); error.value = e.message; flagged.value = (e.details?.itemIds as string[] | undefined) ?? [] }
  finally { busy.value = false }
}
</script>
<template>
  <main class="wrap">
    <header class="head"><span class="logo">Lola</span><span class="sub">{{ t('mystery.title') }}</span></header>
    <p v-if="error && !form" class="error" role="alert">{{ error }}</p>
    <section v-else-if="done" class="card center">
      <h1>{{ t('mystery.thanks') }}</h1>
      <p class="sub">{{ t('mystery.thanksHint') }}</p>
    </section>
    <template v-else-if="form">
      <h1>{{ form.checklist.title }}</h1>
      <p class="sub">{{ form.location?.name }}<template v-if="form.location?.address"> · {{ form.location.address }}</template> · {{ form.wave }}</p>
      <p class="sub">{{ t('mystery.hint') }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <section v-for="[g, its] in groups" :key="g" class="card">
        <h2 v-if="g">{{ g }}</h2>
        <div v-for="it in its" :key="it.id" :class="['item', { flag: flagged.includes(it.id) }]">
          <p class="text">{{ it.text }}</p>
          <p v-if="it.hint" class="sub">{{ it.hint }}</p>
          <div class="opts">
            <button v-for="o in scaleOf(it)?.options ?? []" :key="o.value" type="button" :class="['opt', { on: answers[it.id]?.value === o.value }]" @click="answers[it.id]!.value = o.value; answers[it.id]!.isNa = false">{{ o.label }}</button>
            <button v-if="scaleOf(it)?.allowNa" type="button" :class="['opt', { on: answers[it.id]?.isNa }]" @click="answers[it.id]!.isNa = !answers[it.id]!.isNa; if (answers[it.id]!.isNa) answers[it.id]!.value = null">{{ t('cl.na') }}</button>
          </div>
          <input v-model="answers[it.id]!.comment" class="field" :placeholder="t('assess.comment')" maxlength="2000">
        </div>
      </section>
      <div class="sticky">
        <span>{{ t('cl.doneN', { n: answered, total: form.checklist.items.length }) }}</span>
        <button class="primary" :disabled="busy || answered < form.checklist.items.length" @click="submit">{{ t('mystery.send') }}</button>
      </div>
    </template>
    <p v-else class="sub">{{ t('common.loading') }}</p>
  </main>
</template>
<style scoped>
.wrap { max-width: 640px; margin: 0 auto; padding: var(--space-4) var(--space-4) 96px; }
.head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-3); }
.logo { font-weight: 900; font-size: var(--font-size-title-l); }
h1 { margin: 0 0 var(--space-1); font-weight: 900; }
h2 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); color: var(--color-ink-muted); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); margin-bottom: var(--space-3); }
.center { text-align: center; padding: var(--space-7) var(--space-4); }
.item { display: grid; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--color-bg-line-soft); }
.item.flag { outline: 2px solid var(--color-coral); border-radius: var(--radius-s); }
.text { margin: 0; font-weight: 700; }
.opts { display: flex; gap: var(--space-1); flex-wrap: wrap; }
.opt { font: inherit; font-weight: 700; border: 1px solid var(--color-bg-line); background: var(--color-bg); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; min-height: 44px; }
.opt.on { background: var(--color-sun); border-color: var(--color-sun); }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2); background: var(--color-bg); color: var(--color-ink); width: 100%; box-sizing: border-box; }
.sticky { position: fixed; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--color-bg-soft); border-top: 1px solid var(--color-bg-line); }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-5); cursor: pointer; min-height: 44px; }
.primary:disabled { opacity: 0.5; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0 0 var(--space-2); }
.error { color: var(--color-coral-ink); }
</style>

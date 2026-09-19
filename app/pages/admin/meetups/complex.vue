<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'complextest.manage' })
const { t } = useI18n()
const { api } = useApi()
interface CT { id: string, title: string, parts: { quizId: string, weight: number, minScore: number | null, title: string }[], passScore: string, timeLimitSec: number | null, sequential: boolean, attemptsAllowed: number, isActive: boolean }
const items = ref<CT[]>([])
const quizzes = ref<{ id: string, title: string }[]>([])
const error = ref('')
const notice = ref('')
const form = reactive({ title: '', passScore: 70, timeLimitMin: 60 as number | null, sequential: true, attemptsAllowed: 1, showPartsResult: true, parts: [] as { quizId: string, weight: number, minScore: number | null }[] })
async function load() { try { items.value = await api('/complex-tests'); quizzes.value = (await api<{ id: string, title: string, status: string }[]>('/quizzes')).filter(q => q.status !== 'archived') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function save() {
  error.value = ''; notice.value = ''
  try { await api('/complex-tests', { method: 'PUT', body: { title: form.title, passScore: form.passScore, timeLimitSec: form.timeLimitMin ? form.timeLimitMin * 60 : null, sequential: form.sequential, attemptsAllowed: form.attemptsAllowed, showPartsResult: form.showPartsResult, parts: form.parts } }); notice.value = t('common.saved'); form.title = ''; form.parts = []; await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.complexTests') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('cx.parts') }}</th><th>{{ t('cx.pass') }}</th><th /></tr></thead>
      <tbody>
        <tr v-for="c in items" :key="c.id">
          <td><b>{{ c.title }}</b><div class="sub">{{ c.sequential ? t('cx.sequential') : '' }}<template v-if="c.timeLimitSec"> · {{ Math.round(c.timeLimitSec / 60) }} хв</template> · {{ t('cx.attemptsN', { n: c.attemptsAllowed || '∞' }) }}</div></td>
          <td class="sub">{{ c.parts.map(p => `${p.title} ×${p.weight}${p.minScore != null ? ` (≥${p.minScore})` : ''}`).join(' → ') }}</td>
          <td>{{ Number(c.passScore) }}%</td>
          <td><NuxtLink :to="`/learn/complex/${c.id}`" class="link">{{ t('cx.openLink') }}</NuxtLink></td>
        </tr>
      </tbody>
    </table>
    <section class="card">
      <h2>{{ t('cx.new') }}</h2>
      <div class="row">
        <input v-model="form.title" class="field grow" :placeholder="t('cx.titlePh')">
        <label class="sub">{{ t('cx.pass') }} <input v-model.number="form.passScore" class="field short" type="number" min="1" max="100"></label>
        <label class="sub">{{ t('cx.limitMin') }} <input v-model.number="form.timeLimitMin" class="field short" type="number" min="1"></label>
        <label class="sub">{{ t('cx.attemptsLabel') }} <input v-model.number="form.attemptsAllowed" class="field short" type="number" min="0" max="20"></label>
        <label class="check"><input v-model="form.sequential" type="checkbox"> {{ t('cx.sequential') }}</label>
        <label class="check"><input v-model="form.showPartsResult" type="checkbox"> {{ t('cx.showParts') }}</label>
      </div>
      <div v-for="(p, i) in form.parts" :key="i" class="row">
        <span class="sub">{{ i + 1 }}.</span>
        <select v-model="p.quizId" class="field grow"><option v-for="q in quizzes" :key="q.id" :value="q.id">{{ q.title }}</option></select>
        <label class="sub">×<input v-model.number="p.weight" class="field short" type="number" step="0.5" min="0.1"></label>
        <label class="sub">{{ t('cx.minScoreLabel') }} <input v-model.number="p.minScore" class="field short" type="number" min="0" max="100"></label>
        <button class="chip" @click="form.parts.splice(i, 1)">✕</button>
      </div>
      <div class="row">
        <button class="chip" @click="form.parts.push({ quizId: quizzes[0]?.id ?? '', weight: 1, minScore: null })">+ {{ t('cx.partWord') }}</button>
        <button class="primary" :disabled="form.title.length < 3 || form.parts.length < 2" @click="save">{{ t('common.save') }}</button>
      </div>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); vertical-align: top; }
.link { color: var(--color-ink); font-weight: 700; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.short { width: 70px; }
.grow { flex: 1; min-width: 160px; }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.primary:disabled { opacity: 0.5; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>

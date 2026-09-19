<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
interface W { id: string, title: string, status: string, submissionKinds: string[], criteriaCount: number, slaHours: number, pending: number, firstPassPct: number | null }
const items = ref<W[]>([])
const error = ref('')
const notice = ref('')
const form = reactive({ title: '', description: [{ id: 'd1', type: 'text', html: '<p></p>' }] as ContentBlock[], kinds: ['text', 'photo'] as string[], minTextLength: 50, criteria: [{ text: '', isCritical: false }], reviewerRule: 'location_mentor', maxReworks: 2, slaHours: 48, allowCameraOnly: false })
async function load() { try { items.value = await api<W[]>('/workshops') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function create() {
  error.value = ''
  try {
    await api('/workshops', { method: 'POST', body: { title: form.title, description: form.description, submissionKinds: form.kinds, minTextLength: form.kinds.includes('text') ? form.minTextLength : null, criteria: form.criteria.filter(c => c.text.trim()), reviewerRule: form.reviewerRule, maxReworks: form.maxReworks, slaHours: form.slaHours, allowCameraOnly: form.allowCameraOnly, status: 'published' } })
    notice.value = t('common.saved')
    Object.assign(form, { title: '', criteria: [{ text: '', isCritical: false }], description: [{ id: `d${Date.now()}`, type: 'text', html: '<p></p>' }] })
    await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.workshops') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="notice" class="notice">{{ notice }}</p>
    <table class="table">
      <thead><tr><th>{{ t('assign.col.title') }}</th><th>{{ t('workshop.col.kinds') }}</th><th>{{ t('workshop.col.criteria') }}</th><th>SLA</th><th>{{ t('workshop.col.pending') }}</th><th>{{ t('workshop.col.firstPass') }}</th></tr></thead>
      <tbody>
        <tr v-for="w in items" :key="w.id">
          <td><b>{{ w.title }}</b> <span :class="['badge', w.status]">{{ t(`course.status.${w.status}`) }}</span></td>
          <td class="sub">{{ w.submissionKinds.join(', ') }}</td><td>{{ w.criteriaCount }}</td><td>{{ w.slaHours }}h</td>
          <td :class="{ coral: w.pending > 0 }">{{ w.pending }}</td><td>{{ w.firstPassPct === null ? '—' : `${w.firstPassPct}%` }}</td>
        </tr>
        <tr v-if="items.length === 0"><td colspan="6" class="empty">{{ t('workshop.empty') }}</td></tr>
      </tbody>
    </table>
    <section v-if="hasScope('course.create')" class="card">
      <h2>{{ t('workshop.new') }}</h2>
      <input v-model="form.title" class="field" :placeholder="t('workshop.titleHint')">
      <BlockEditor v-model="form.description" />
      <div class="row">
        <label v-for="k in ['text', 'photo', 'file', 'video']" :key="k" class="check"><input v-model="form.kinds" type="checkbox" :value="k"> {{ k }}</label>
        <label v-if="form.kinds.includes('text')" class="check">{{ t('workshop.minChars', { n: '' }) }}<input v-model.number="form.minTextLength" type="number" min="10" max="5000" class="num"></label>
        <label v-if="form.kinds.includes('photo')" class="check"><input v-model="form.allowCameraOnly" type="checkbox"> {{ t('workshop.cameraOnly') }}</label>
      </div>
      <h3>{{ t('workshop.criteria') }}</h3>
      <div v-for="(c, i) in form.criteria" :key="i" class="row">
        <input v-model="c.text" class="field grow" :placeholder="t('workshop.criterionHint')">
        <label class="check"><input v-model="c.isCritical" type="checkbox"> {{ t('workshop.critical') }}</label>
        <button class="chip" @click="form.criteria.splice(i, 1)">✕</button>
      </div>
      <button class="chip" @click="form.criteria.push({ text: '', isCritical: false })">+ {{ t('workshop.criterion') }}</button>
      <div class="row">
        <label class="check">{{ t('workshop.reviewer') }}
          <select v-model="form.reviewerRule"><option value="location_mentor">{{ t('workshop.rev.location_mentor') }}</option><option value="any_mentor">{{ t('workshop.rev.any_mentor') }}</option><option value="author">{{ t('workshop.rev.author') }}</option></select>
        </label>
        <label class="check">{{ t('workshop.maxReworks') }}<input v-model.number="form.maxReworks" type="number" min="0" max="5" class="num"></label>
        <label class="check">SLA, h<input v-model.number="form.slaHours" type="number" min="1" max="720" class="num"></label>
      </div>
      <button class="primary" :disabled="form.title.length < 3 || !form.criteria.some(c => c.text.trim()) || !form.kinds.length" @click="create">{{ t('course.create') }}</button>
    </section>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
h2 { margin: 0; font-weight: 800; }
h3 { margin: var(--space-2) 0 0; font-size: var(--font-size-body-s); color: var(--color-ink-faint); text-transform: uppercase; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; margin-bottom: var(--space-4); }
th { text-align: left; font-size: var(--font-size-body-s); color: var(--color-ink-muted); padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line); }
td { padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); }
.field, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.grow { flex: 1; }
.num { width: 70px; margin-left: var(--space-1); }
.row { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; justify-self: start; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.primary:disabled { opacity: 0.5; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.badge.published { background: var(--color-teal); color: var(--color-teal-deep); }
.coral { color: var(--color-coral-ink); font-weight: 700; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>

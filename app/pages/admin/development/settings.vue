<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'development.manage' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const form = reactive({ goalsNeedApproval: false, externalTrainingThreshold: 5000, careerAssessmentFormId: '' as string })
const forms = ref<{ id: string, title: string }[]>([])
const error = ref('')
const notice = ref('')
onMounted(async () => {
  try { const s = await api<{ goalsNeedApproval: boolean, externalTrainingThreshold: number, careerAssessmentFormId: string | null }>('/settings/development'); Object.assign(form, { ...s, careerAssessmentFormId: s.careerAssessmentFormId ?? '' }) } catch (err) { error.value = apiErrorOf(err).message }
  try { forms.value = await api('/assessment/forms') } catch { /* нет прав на анкеты */ }
})
async function save() {
  error.value = ''; notice.value = ''
  try { await api('/settings/development', { method: 'PATCH', body: { goalsNeedApproval: form.goalsNeedApproval, externalTrainingThreshold: Number(form.externalTrainingThreshold), careerAssessmentFormId: form.careerAssessmentFormId || null } }); notice.value = t('common.saved') }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <h1>{{ t('dev.settings') }}</h1>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <form class="card" @submit.prevent="save">
      <label class="check"><input v-model="form.goalsNeedApproval" type="checkbox" :disabled="!hasScope('settings.tenant')"> {{ t('dev.goalsNeedApproval') }}</label>
      <p class="sub">{{ t('dev.goalsNeedApprovalHint') }}</p>
      <label>{{ t('dev.threshold') }}<input v-model="form.externalTrainingThreshold" type="number" min="0" step="100" :disabled="!hasScope('settings.tenant')"></label>
      <p class="sub">{{ t('dev.thresholdHint') }}</p>
      <label>{{ t('dev.careerForm') }}<select v-model="form.careerAssessmentFormId" :disabled="!hasScope('settings.tenant')"><option value="">—</option><option v-for="f in forms" :key="f.id" :value="f.id">{{ f.title }}</option></select></label>
      <p class="sub">{{ t('dev.careerFormHint') }}</p>
      <button v-if="hasScope('settings.tenant')" type="submit" class="primary">{{ t('common.save') }}</button>
    </form>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-2); max-width: 560px; }
label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.check { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); font-size: var(--font-size-body); }
input, select { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
input[type="checkbox"] { width: auto; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; justify-self: start; }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
.notice { color: var(--color-teal-ink); }
</style>

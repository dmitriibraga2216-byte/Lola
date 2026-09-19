<script setup lang="ts">
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'request.decide' })
const { t } = useI18n()
const { api } = useApi()
interface Ext { id: string, title: string, provider: string | null, format: string, cost: string | null, currency: string, justification: string | null, status: string, fullName: string }
interface Car { id: string, targetPosition: string, motivation: string | null, status: string, fullName: string }
const data = ref<{ external: Ext[], career: Car[] }>({ external: [], career: [] })
const error = ref('')
const comment = ref<Record<string, string>>({})
async function load() { try { data.value = await api('/development/requests/pending') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function decide(kind: 'external' | 'career', id: string, decision: 'approve' | 'reject') {
  error.value = ''
  try { await api(`/development/requests/${kind}/${id}/decide`, { method: 'POST', body: { decision, comment: comment.value[id] || undefined } }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <h1>{{ t('admin.nav.requests') }}</h1>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="data.external.length + data.career.length === 0" class="sub">{{ t('dev.noPending') }}</p>
    <div class="list">
      <div v-for="r in data.external" :key="r.id" class="card">
        <div class="row"><b>{{ r.fullName }}</b><span class="badge">{{ t(`dev.reqStatus.${r.status}`) }}</span></div>
        <div>{{ t('dev.external') }}: <b>{{ r.title }}</b><span v-if="r.provider"> · {{ r.provider }}</span> · {{ r.format }}<span v-if="r.cost"> · {{ r.cost }} {{ r.currency }}</span></div>
        <p v-if="r.justification" class="sub">{{ r.justification }}</p>
        <input v-model="comment[r.id]" class="field" :placeholder="t('dev.commentPh')">
        <div class="row"><button class="primary" @click="decide('external', r.id, 'approve')">{{ t('dev.approve') }}</button><button class="chip" @click="decide('external', r.id, 'reject')">{{ t('dev.reject') }}</button></div>
      </div>
      <div v-for="r in data.career" :key="r.id" class="card">
        <div class="row"><b>{{ r.fullName }}</b><span class="badge">{{ t(`dev.reqStatus.${r.status}`) }}</span></div>
        <div>{{ t('dev.career') }}: <b>{{ r.targetPosition }}</b></div>
        <p v-if="r.motivation" class="sub">{{ r.motivation }}</p>
        <input v-model="comment[r.id]" class="field" :placeholder="t('dev.commentPh')">
        <div class="row"><button class="primary" @click="decide('career', r.id, 'approve')">{{ t('dev.approve') }}</button><button class="chip" @click="decide('career', r.id, 'reject')">{{ t('dev.reject') }}</button></div>
      </div>
    </div>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-4); font-weight: 900; }
.list { display: grid; gap: var(--space-2); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); }
.row { display: flex; gap: var(--space-2); align-items: center; justify-content: space-between; flex-wrap: wrap; }
.field { font: inherit; border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); background: var(--color-bg); color: var(--color-ink); }
.chip { font: inherit; font-size: var(--font-size-body-s); font-weight: 700; border: 1px solid var(--color-bg-line); background: transparent; color: var(--color-ink-muted); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.primary { font: inherit; font-weight: 800; border: none; background: var(--color-sun); color: var(--color-ink); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; }
.badge { font-size: var(--font-size-body-s); font-weight: 700; border-radius: var(--radius-pill); padding: 2px var(--space-3); background: var(--color-bg-line-soft); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-faint); margin: 0; }
.error { color: var(--color-coral-ink); }
</style>

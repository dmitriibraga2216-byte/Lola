<script setup lang="ts">
import type { ContentBlock } from '../../../../shared/schemas/content'

/**
 * Практикуми за мокапом ContentWorkshops (docs/31): шапка «Практикуми» з «Додати», таблиця
 * НАЗВА · АВТОР · КРИТЕРІЇВ · ДАТА ЗМІНИ · ОПУБЛІКОВАНО. «Імпортувати» на цьому екрані
 * не додаємо — те саме рішення заказчика Q-03 (docs/34): формат файлу не описаний.
 * «Автор» (screens-7) — `listWorkshops` тепер віддає `authorNames` (join на users).
 * Колонка «Мітки» знята рішенням замовника 23.09.2026 (docs/33 D-074, docs/28): tag_scope
 * під практикуми не заводимо, у `workshops` немає стовпця tags і не буде.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
interface W { id: string, title: string, status: string, submissionKinds: string[], criteriaCount: number, slaHours: number, pending: number, firstPassPct: number | null, updatedAt: string, authorNames: string[] }
const items = ref<W[]>([])
const error = ref('')
const notice = ref('')
const formOpen = ref(false)
const form = reactive({ title: '', description: [{ id: 'd1', type: 'text', html: '<p></p>' }] as ContentBlock[], kinds: ['text', 'photo'] as string[], minTextLength: 50, criteria: [{ text: '', isCritical: false }], reviewerRule: 'location_mentor', maxReworks: 2, slaHours: 48, allowCameraOnly: false })
async function load() { try { items.value = await api<W[]>('/workshops') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function create() {
  error.value = ''
  try {
    await api('/workshops', { method: 'POST', body: { title: form.title, description: form.description, submissionKinds: form.kinds, minTextLength: form.kinds.includes('text') ? form.minTextLength : null, criteria: form.criteria.filter(c => c.text.trim()), reviewerRule: form.reviewerRule, maxReworks: form.maxReworks, slaHours: form.slaHours, allowCameraOnly: form.allowCameraOnly, status: 'published' } })
    notice.value = t('common.saved')
    formOpen.value = false
    Object.assign(form, { title: '', criteria: [{ text: '', isCritical: false }], description: [{ id: `d${Date.now()}`, type: 'text', html: '<p></p>' }] })
    await load()
  } catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <PageHeader :title="t('admin.nav.workshops')" :crumbs="[{ label: t('admin.section.content') }]">
      <template #actions>
        <button v-if="hasScope('course.create')" class="btn primary" @click="formOpen = true">{{ t('common.add') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('workshop.col.title') }}</th><th>{{ t('workshop.col.author') }}</th><th>{{ t('workshop.col.criteria') }}</th>
            <th>{{ t('workshop.col.updated') }}</th><th>{{ t('workshop.col.published') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="w in items" :key="w.id">
            <td>
              <b>{{ w.title }}</b>
              <span class="sub">{{ w.submissionKinds.join(', ') }} · {{ t('workshop.col.pending') }}: {{ w.pending }}<template v-if="w.firstPassPct !== null"> · {{ t('workshop.col.firstPass') }} {{ w.firstPassPct }}%</template></span>
            </td>
            <td class="muted">{{ w.authorNames.length ? w.authorNames.join(', ') : '—' }}</td>
            <td>{{ w.criteriaCount }}</td>
            <td class="muted">{{ new Date(w.updatedAt).toLocaleDateString('uk') }}</td>
            <td><span :class="['badge upper', w.status]">{{ t(`course.status.${w.status}`) }}</span></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="5" class="empty">{{ t('workshop.empty') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="formOpen" class="modal-backdrop" @click.self="formOpen = false">
      <form class="modal card" @submit.prevent="create">
        <h2 class="panel-title">{{ t('workshop.new') }}</h2>
        <input v-model="form.title" class="field" :placeholder="t('workshop.titleHint')">
        <BlockEditor v-model="form.description" />
        <div class="row">
          <label v-for="k in ['text', 'photo', 'file', 'video']" :key="k" class="check"><input v-model="form.kinds" type="checkbox" :value="k"> {{ k }}</label>
          <label v-if="form.kinds.includes('text')" class="check">{{ t('workshop.minChars', { n: '' }) }}<input v-model.number="form.minTextLength" type="number" min="10" max="5000" class="field num"></label>
          <label v-if="form.kinds.includes('photo')" class="check"><input v-model="form.allowCameraOnly" type="checkbox"> {{ t('workshop.cameraOnly') }}</label>
        </div>
        <h3 class="panel-title">{{ t('workshop.criteria') }}</h3>
        <div v-for="(c, i) in form.criteria" :key="i" class="row">
          <input v-model="c.text" class="field grow" :placeholder="t('workshop.criterionHint')">
          <label class="check"><input v-model="c.isCritical" type="checkbox"> {{ t('workshop.critical') }}</label>
          <button type="button" class="chip" @click="form.criteria.splice(i, 1)">✕</button>
        </div>
        <button type="button" class="chip outline" @click="form.criteria.push({ text: '', isCritical: false })">+ {{ t('workshop.criterion') }}</button>
        <div class="row">
          <label class="check">{{ t('workshop.reviewer') }}
            <select v-model="form.reviewerRule" class="field small"><option value="location_mentor">{{ t('workshop.rev.location_mentor') }}</option><option value="any_mentor">{{ t('workshop.rev.any_mentor') }}</option><option value="author">{{ t('workshop.rev.author') }}</option></select>
          </label>
          <label class="check">{{ t('workshop.maxReworks') }}<input v-model.number="form.maxReworks" type="number" min="0" max="5" class="field num"></label>
          <label class="check">SLA, h<input v-model.number="form.slaHours" type="number" min="1" max="720" class="field num"></label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" @click="formOpen = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn primary" :disabled="form.title.trim().length < 3 || !form.criteria.some(c => c.text.trim()) || !form.kinds.length">{{ t('course.create') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>
<style scoped>
.row { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; }
.grow { flex: 1; min-width: 200px; }
.num { width: 70px; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 0.4); display: grid; place-items: center; padding: var(--space-4); z-index: 20; }
.modal { width: min(560px, 100%); display: grid; gap: var(--space-3); max-height: 90dvh; overflow: auto; }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.field.small { width: auto; }
</style>

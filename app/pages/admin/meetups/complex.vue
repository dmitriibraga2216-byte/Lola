<script setup lang="ts">
/**
 * Комплексні тести за мокапом ContentComplexTests (docs/31): шапка «Комплексні тести» з
 * «Додати», таблиця НАЗВА · СКЛАД · ТЕМИ · АВТОР · ДАТА ЗМІНИ · ОПУБЛІКОВАНО. «Імпортувати»
 * не додаємо — те саме рішення заказчика Q-03 (docs/34): формат файлу не описаний.
 * «Автор» (screens-7): `listComplexTests` тепер приєднує users по `created_by` і віддає `authorName`.
 * Залишок:
 *  - «Теми»: у складі комплексного теста немає поняття «тема» — лише частини-тести
 *    (`parts`, docs/12 §14.2); чи це мітки складових тестів, чи окреме поле — не визначено
 *    в ТЗ, тому не вигадуємо і лишаємо «—» до рішення замовника.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'complextest.manage' })
const { t } = useI18n()
const { api } = useApi()
interface CT { id: string, title: string, parts: { quizId: string, weight: number, minScore: number | null, title: string }[], sequential: boolean, isActive: boolean, updatedAt: string, authorName: string | null }
const items = ref<CT[]>([])
const quizzes = ref<{ id: string, title: string }[]>([])
const error = ref('')
const notice = ref('')
const formOpen = ref(false)
const form = reactive({ title: '', sequential: true, showPartsResult: true, parts: [] as { quizId: string, weight: number, minScore: number | null }[] })
async function load() { try { items.value = await api('/complex-tests'); quizzes.value = (await api<{ id: string, title: string, status: string }[]>('/quizzes')).filter(q => q.status !== 'archived') } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function save() {
  error.value = ''; notice.value = ''
  try {
    await api('/complex-tests', { method: 'PUT', body: { title: form.title, sequential: form.sequential, showPartsResult: form.showPartsResult, parts: form.parts } })
    notice.value = t('common.saved')
    formOpen.value = false
    form.title = ''
    form.parts = []
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>
<template>
  <div>
    <PageHeader :title="t('admin.nav.complexTests')" :crumbs="[{ label: t('admin.section.content') }]">
      <template #actions>
        <button class="btn primary" @click="formOpen = true">{{ t('common.add') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('cx.col.title') }}</th><th>{{ t('cx.col.composition') }}</th><th>{{ t('cx.col.topics') }}</th>
            <th>{{ t('cx.col.author') }}</th><th>{{ t('cx.col.updated') }}</th><th>{{ t('cx.col.published') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in items" :key="c.id" class="ct-row" tabindex="0" @click="navigateTo(`/learn/complex/${c.id}`)" @keydown.enter="navigateTo(`/learn/complex/${c.id}`)">
            <td>
              <b>{{ c.title }}</b>
              <span class="sub">{{ c.sequential ? t('cx.sequential') : '' }}</span>
            </td>
            <td>{{ t('cx.col.compositionN', { n: c.parts.length }) }}</td>
            <td class="muted">—</td>
            <td class="muted">{{ c.authorName ?? '—' }}</td>
            <td class="muted">{{ new Date(c.updatedAt).toLocaleDateString('uk') }}</td>
            <td><span :class="['badge upper', c.isActive ? 'published' : 'draft']">{{ c.isActive ? t('course.status.published') : t('course.status.draft') }}</span></td>
          </tr>
          <tr v-if="items.length === 0"><td colspan="6" class="empty">{{ t('cx.empty') }}</td></tr>
        </tbody>
      </table>
    </div>

    <div v-if="formOpen" class="modal-backdrop" @click.self="formOpen = false">
      <form class="modal card" @submit.prevent="save">
        <h2 class="panel-title">{{ t('cx.new') }}</h2>
        <p class="sub">{{ t('cx.rulesInTask') }}</p>
        <div class="row">
          <input v-model="form.title" class="field grow" :placeholder="t('cx.titlePh')">
          <label class="check"><input v-model="form.sequential" type="checkbox"> {{ t('cx.sequential') }}</label>
          <label class="check"><input v-model="form.showPartsResult" type="checkbox"> {{ t('cx.showParts') }}</label>
        </div>
        <div v-for="(p, i) in form.parts" :key="i" class="row">
          <span class="sub">{{ i + 1 }}.</span>
          <select v-model="p.quizId" class="field grow"><option v-for="q in quizzes" :key="q.id" :value="q.id">{{ q.title }}</option></select>
          <label class="sub">×<input v-model.number="p.weight" class="field short" type="number" step="0.5" min="0.1"></label>
          <label class="sub">{{ t('cx.minScoreLabel') }} <input v-model.number="p.minScore" class="field short" type="number" min="0" max="100"></label>
          <button type="button" class="chip" @click="form.parts.splice(i, 1)">✕</button>
        </div>
        <div class="row">
          <button type="button" class="chip outline" @click="form.parts.push({ quizId: quizzes[0]?.id ?? '', weight: 1, minScore: null })">+ {{ t('cx.partWord') }}</button>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn ghost" @click="formOpen = false">{{ t('common.cancel') }}</button>
          <button type="submit" class="btn primary" :disabled="form.title.length < 3 || form.parts.length < 2">{{ t('common.save') }}</button>
        </div>
      </form>
    </div>
  </div>
</template>
<style scoped>
.ct-row { cursor: pointer; }
.ct-row:hover td, .ct-row:focus-visible td { background: var(--color-bg-line-soft); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.short { width: 70px; }
.grow { flex: 1; min-width: 160px; }
.check { display: flex; gap: var(--space-1); align-items: center; font-size: var(--font-size-body-s); }
.empty { color: var(--color-ink-faint); text-align: center; padding: var(--space-6); }
.modal-backdrop { position: fixed; inset: 0; background: rgb(12 15 20 / 0.4); display: grid; place-items: center; padding: var(--space-4); z-index: 20; }
.modal { width: min(560px, 100%); display: grid; gap: var(--space-3); max-height: 90dvh; overflow: auto; }
.modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
</style>

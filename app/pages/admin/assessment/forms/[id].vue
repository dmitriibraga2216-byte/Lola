<script setup lang="ts">
/**
 * Анкета оцінки за мокапом Assessment: зліва бібліотека критеріїв (фільтри «Групи критеріїв», «Мітки»),
 * посередині «КРИТЕРІЙ — ІНДИКАТОР · Норма», справа параметри (тип, шкала, правила коментування, оцінювачі).
 * Після першого заповнення — червона плашка: шкала, склад і норми недоступні (docs/20 §14.4); сервер відповідає 409.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'assessment.manage' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const router = useRouter()
interface Crit { id: string, text: string, groupId: string }
interface Group { id: string, name: string, tags: string[], criteria: Crit[] }
interface Scale { id: string, name: string, levels: { value: number | null, label: string }[] }
interface Item { criterionId: string, norm: number, cluster: string | null, text: string, groupName: string }
interface FormData { id: string, title: string, description: string | null, instruction: { type: string, html?: string }[], kind: string, scaleId: string, allowCommentGroups: boolean, commentGroupsRequired: boolean, commentWhenAboveNorm: boolean, commentWhenBelowNorm: boolean, commentWhenEqual: boolean, zeroMeansNoGrade: boolean, isLocked: boolean, tags: string[], isActive: boolean, items: Item[], raterRoles: { kind: string, weight: number, anonymous: boolean }[] }
const isNew = computed(() => route.params.id === 'new')
const groups = ref<Group[]>([])
const scales = ref<Scale[]>([])
const roles = ref<{ kind: string, weight: number, anonymous: boolean }[]>([])
const error = ref('')
const notice = ref('')
const lockedFields = ref<string[]>([])
const badNorm = ref<string[]>([])
const groupFilter = ref('')
const tagFilter = ref('')
const form = reactive({
  title: '', description: '', instruction: '', kind: 'by_criteria', scaleId: '', allowCommentGroups: false, commentGroupsRequired: false,
  commentWhenAboveNorm: false, commentWhenBelowNorm: true, commentWhenEqual: false, zeroMeansNoGrade: false, isLocked: false, tags: '', isActive: true,
  items: [] as Item[],
})
const scale = computed(() => scales.value.find(s => s.id === form.scaleId))
const scaleMax = computed(() => Math.max(...(scale.value?.levels ?? []).map(l => l.value ?? 0), 0))
const scaleMin = computed(() => Math.min(...(scale.value?.levels ?? []).map(l => l.value ?? 0), scaleMax.value))
const allTags = computed(() => [...new Set(groups.value.flatMap(g => g.tags))])
const library = computed(() => groups.value
  .filter(g => !groupFilter.value || g.id === groupFilter.value)
  .filter(g => !tagFilter.value || g.tags.includes(tagFilter.value))
  .flatMap(g => g.criteria.filter(c => !form.items.some(i => i.criterionId === c.id)).map(c => ({ ...c, groupName: g.name }))))
async function load() {
  try {
    groups.value = await api<Group[]>('/assessment/groups')
    scales.value = await api<Scale[]>('/scales?kind=levels')
    if (!isNew.value) {
      const f = await api<FormData>(`/assessment/forms/${route.params.id}`)
      Object.assign(form, { ...f, description: f.description ?? '', instruction: f.instruction.map(b => b.html ?? '').join('\n'), tags: f.tags.join(', ') })
      roles.value = f.raterRoles
    }
    else { form.scaleId = scales.value[0]?.id ?? ''; roles.value = [{ kind: 'manager', weight: 2, anonymous: false }, { kind: 'self', weight: 0, anonymous: false }, { kind: 'peer', weight: 1, anonymous: true }, { kind: 'subordinate', weight: 1, anonymous: true }] }
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
function add(c: Crit & { groupName: string }) { if (form.isLocked) return; form.items.push({ criterionId: c.id, norm: scaleMax.value, cluster: null, text: c.text, groupName: c.groupName }) }
function remove(i: number) { if (form.isLocked) return; form.items.splice(i, 1) }
function addCluster() { const name = prompt(t('assess.clusterName')); if (!name) return; for (const it of form.items) if (!it.cluster) it.cluster = name }
async function save() {
  error.value = ''; notice.value = ''; lockedFields.value = []; badNorm.value = []
  try {
    const body = {
      id: isNew.value ? undefined : route.params.id, title: form.title, description: form.description || null,
      instruction: form.instruction.trim() ? [{ id: 'i1', type: 'text', html: form.instruction }] : [],
      kind: form.kind, scaleId: form.scaleId, allowCommentGroups: form.allowCommentGroups, commentGroupsRequired: form.allowCommentGroups && form.commentGroupsRequired,
      commentWhenAboveNorm: form.commentWhenAboveNorm, commentWhenBelowNorm: form.commentWhenBelowNorm, commentWhenEqual: form.commentWhenEqual, zeroMeansNoGrade: form.zeroMeansNoGrade,
      tags: form.tags.split(',').map(s => s.trim()).filter(Boolean), isActive: form.isActive,
      items: form.items.map(i => ({ criterionId: i.criterionId, norm: Number(i.norm), cluster: i.cluster })),
    }
    const r = await api<{ id: string }>('/assessment/forms', { method: 'PUT', body })
    notice.value = t('common.saved')
    if (isNew.value) router.replace(`/admin/assessment/forms/${r.id}`)
  }
  catch (err) {
    const e = apiErrorOf(err)
    error.value = e.message
    lockedFields.value = (e.details?.fields as string[] | undefined) ?? []
    badNorm.value = (e.details?.criterionIds as string[] | undefined) ?? []
  }
}
</script>
<template>
  <div>
    <PageHeader :title="form.title || t('assess.newForm')" :crumbs="[{ label: t('assess.sectionTitle') }, { label: t('assess.forms'), to: '/admin/assessment/forms' }]">
      <template #actions><button class="btn primary" :disabled="form.title.length < 3 || !form.scaleId || !form.items.length" data-testid="form-save" @click="save">{{ t('common.save') }}</button></template>
    </PageHeader>
    <p v-if="error" class="note coral">{{ error }}<span v-if="lockedFields.length" class="sub"> ({{ lockedFields.join(', ') }})</span></p>
    <p v-if="notice" class="note teal">{{ notice }}</p>

    <div class="layout">
      <aside class="library">
        <div class="filters">
          <select v-model="groupFilter" class="field" :aria-label="t('assess.groups')"><option value="">{{ t('assess.groups') }}</option><option v-for="g in groups" :key="g.id" :value="g.id">{{ g.name }}</option></select>
          <select v-model="tagFilter" class="field" :aria-label="t('assess.tags')"><option value="">{{ t('assess.tags') }}</option><option v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</option></select>
        </div>
        <button v-for="c in library" :key="c.id" type="button" class="lib-item" :disabled="form.isLocked" @click="add(c)">
          <span>{{ c.text }}</span>
          <small>{{ t('assess.group') }}: {{ c.groupName }}</small>
        </button>
        <p v-if="!library.length" class="sub">{{ t('assess.libraryEmpty') }}</p>
      </aside>

      <section class="composition card">
        <p v-if="form.isLocked" class="note coral lock" data-testid="form-locked">{{ t('assess.lockedBanner') }}</p>
        <div class="label upper">{{ t('assess.criterionIndicator') }}</div>
        <div class="items">
          <div class="item-head"><label class="label">{{ t('assess.titleField') }}</label><input v-model="form.title" class="field" :placeholder="t('assess.formTitle')" data-testid="form-title"></div>
          <div v-for="(it, i) in form.items" :key="it.criterionId" :class="['item', { bad: badNorm.includes(it.criterionId) }]" :data-testid="`item-${it.criterionId}`">
            <div class="item-text">{{ it.text }}<small v-if="it.cluster"> · {{ it.cluster }}</small><small v-else> · {{ it.groupName }}</small></div>
            <label class="norm"><span>{{ t('assess.norm') }}</span><input v-model.number="it.norm" type="number" :min="scaleMin" :max="scaleMax" step="0.5" class="field mono" :disabled="form.isLocked" :aria-label="`${t('assess.norm')}: ${it.text}`"></label>
            <button type="button" class="chip" :disabled="form.isLocked" :aria-label="t('common.delete')" @click="remove(i)">✕</button>
          </div>
          <p v-if="!form.items.length" class="sub">{{ t('assess.pickCriteria') }}</p>
          <button type="button" class="chip outline" :disabled="form.isLocked || !form.items.length" @click="addCluster">+ {{ t('assess.addCluster') }}</button>
        </div>
        <label class="label">{{ t('assess.description') }}</label>
        <textarea v-model="form.description" class="field" rows="2" />
        <label class="label">{{ t('assess.instruction') }}</label>
        <textarea v-model="form.instruction" class="field" rows="3" :placeholder="t('assess.instructionHint')" />
        <label class="label">{{ t('assess.tags') }}</label>
        <input v-model="form.tags" class="field" :placeholder="t('assess.tagsHint')">
      </section>

      <aside class="params card">
        <h2 class="panel-title">{{ t('assess.params') }}</h2>
        <div class="label">{{ t('assess.type') }}</div>
        <div class="segmented" role="radiogroup">
          <button v-for="k in ['by_criteria', 'by_competencies']" :key="k" type="button" role="radio" :aria-checked="form.kind === k" :class="{ on: form.kind === k }" :disabled="form.isLocked" @click="form.kind = k">{{ t(`assess.formKind.${k}`) }}</button>
        </div>
        <label class="label" for="scale">{{ t('assess.scaleField') }}</label>
        <select id="scale" v-model="form.scaleId" class="field" :disabled="form.isLocked" data-testid="form-scale"><option v-for="s in scales" :key="s.id" :value="s.id">{{ s.name }}</option></select>
        <label class="toggle"><input v-model="form.allowCommentGroups" type="checkbox" :disabled="form.isLocked"><span>{{ t('assess.allowCommentGroups') }}</span></label>
        <label v-if="form.allowCommentGroups" class="toggle nested"><input v-model="form.commentGroupsRequired" type="checkbox" :disabled="form.isLocked"><span>{{ t('assess.makeRequired') }}</span></label>
        <label class="toggle"><input v-model="form.commentWhenBelowNorm" type="checkbox" :disabled="form.isLocked"><span>{{ t('assess.commentBelow') }}<span class="hint">{{ t('assess.commentBelowHint') }}</span></span></label>
        <label class="toggle"><input v-model="form.commentWhenAboveNorm" type="checkbox" :disabled="form.isLocked"><span>{{ t('assess.commentAbove') }}</span></label>
        <label class="toggle"><input v-model="form.commentWhenEqual" type="checkbox" :disabled="form.isLocked"><span>{{ t('assess.commentEqual') }}</span></label>
        <label class="toggle"><input v-model="form.zeroMeansNoGrade" type="checkbox" :disabled="form.isLocked"><span>{{ t('assess.zeroNoGrade') }}</span></label>
        <label class="toggle"><input v-model="form.isActive" type="checkbox"><span>{{ t('assess.published') }}</span></label>

        <h2 class="panel-title raters">{{ t('assess.raters') }}</h2>
        <p class="help">{{ t('assess.ratersHint') }}</p>
        <ul class="roles">
          <li v-for="r in roles" :key="r.kind"><span>{{ t(`assess.kind.${r.kind}`) }}</span><span class="sub">{{ t('assess.weight') }} {{ r.weight }}<template v-if="r.anonymous"> · {{ t('survey.anonymous') }}</template></span></li>
        </ul>
      </aside>
    </div>
  </div>
</template>
<style scoped>
.layout { display: grid; grid-template-columns: 270px minmax(0, 1fr) 330px; gap: var(--space-4); align-items: start; }
@media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } }
.library { display: grid; gap: var(--space-2); }
.filters { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.lib-item { font: inherit; text-align: left; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); cursor: pointer; display: grid; gap: 2px; color: var(--color-ink); }
.lib-item small { font-size: 11px; font-weight: 800; color: var(--color-ink-muted); }
.lib-item:disabled { opacity: 0.5; cursor: default; }
.composition { display: grid; gap: var(--space-2); }
.lock { margin: 0 0 var(--space-2); font-weight: 700; }
.upper { text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-ink-muted); }
.items { display: grid; gap: var(--space-2); }
.item-head { display: grid; gap: var(--space-1); }
.item { display: flex; gap: var(--space-3); align-items: center; background: var(--color-bg); border: 1px solid var(--color-bg-line); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); }
.item.bad { border-color: var(--color-coral); }
.item-text { flex: 1; font-weight: 600; min-width: 0; }
.item-text small { color: var(--color-ink-muted); }
.norm { display: flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-body-s); font-weight: 800; color: var(--color-ink-muted); }
.norm .field { width: 72px; text-align: center; }
.mono { font-family: ui-monospace, monospace; font-weight: 900; }
.params { display: grid; gap: var(--space-3); }
.toggle.nested { margin-left: var(--space-5); }
.raters { margin-top: var(--space-2); }
.roles { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); }
.roles li { display: flex; justify-content: space-between; gap: var(--space-2); font-weight: 700; }
@media (max-width: 480px) { .item { flex-wrap: wrap; } .filters { grid-template-columns: 1fr; } }
</style>

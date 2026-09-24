<script setup lang="ts">
/**
 * Правила маршрутизации жалоб — `/admin/content-issues/routing` (docs/v2/36 §6.3, §7.5).
 *
 * Видят все, кто разбирает жалобы (методист понимает, почему карточка пришла к нему); меняет —
 * только администратор (§2). Первым заводится запасное правило: непустой набор без него сервер
 * не сохранит (`content_issue.fallback_rule_required`). Правило, адресованное уволенному или
 * заблокированному, не ломает маршрутизацию — оно пропускается, и экран это показывает.
 */
import { CONTENT_ISSUE_TARGET_TYPES, CONTENT_ISSUE_TYPES } from '#shared/enums'
import type { RoutingRuleRow } from '#shared/schemas/contentIssues'

definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'content_issue.triage' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const canEdit = computed(() => hasScope('content_issue.assign'))

interface Option { id: string, name: string }

const rules = ref<RoutingRuleRow[]>([])
const people = ref<Option[]>([])
const roles = ref<Option[]>([])
const categories = ref<Option[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)

const hasFallback = computed(() => rules.value.some(r => r.fallback))
const form = reactive({
  sort: 100,
  targetType: '',
  issueType: '',
  categoryId: '',
  assignTo: 'person' as 'person' | 'role',
  assigneeUserId: '',
  assigneeRoleId: '',
  fallback: true,
  isActive: true,
})

async function load() {
  error.value = ''
  try {
    rules.value = await api<RoutingRuleRow[]>('/settings/content-issue-routing-rules')
    form.fallback = !hasFallback.value
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

onMounted(async () => {
  await load()
  if (!canEdit.value) return
  const [p, r, c] = await Promise.all([
    api<{ id: string, fullName: string }[]>('/people', { query: { limit: 300 } }).catch(() => []),
    api<{ id: string, name: string }[]>('/settings/roles').catch(() => []),
    api<{ id: string, name: string }[]>('/course-categories').catch(() => []),
  ])
  people.value = p.map(x => ({ id: x.id, name: x.fullName }))
  roles.value = r.map(x => ({ id: x.id, name: x.name }))
  categories.value = c.map(x => ({ id: x.id, name: x.name }))
})

async function create() {
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    await api('/settings/content-issue-routing-rules', {
      method: 'POST',
      body: {
        sort: form.sort,
        targetType: form.fallback ? null : form.targetType || null,
        issueType: form.fallback ? null : form.issueType || null,
        categoryId: form.fallback ? null : form.categoryId || null,
        assigneeUserId: form.assignTo === 'person' ? form.assigneeUserId || null : null,
        assigneeRoleId: form.assignTo === 'role' ? form.assigneeRoleId || null : null,
        fallback: form.fallback,
        isActive: form.isActive,
      },
    })
    notice.value = t('contentIssues.saved')
    Object.assign(form, { targetType: '', issueType: '', categoryId: '', assigneeUserId: '', assigneeRoleId: '' })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

async function toggle(rule: RoutingRuleRow) {
  error.value = ''
  try {
    await api(`/settings/content-issue-routing-rules/${rule.id}`, { method: 'PATCH', body: { isActive: !rule.isActive } })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

async function remove(rule: RoutingRuleRow) {
  error.value = ''
  try {
    await api(`/settings/content-issue-routing-rules/${rule.id}`, { method: 'DELETE' })
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

function conditionOf(r: RoutingRuleRow): string {
  if (r.fallback) return t('contentRouting.fallbackHint')
  const parts = [
    r.targetType ? t(`contentIssues.target.${r.targetType}`) : null,
    r.issueType ? t(`issue.type.${r.issueType}`) : null,
    r.categoryName,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : t('contentRouting.any')
}
</script>

<template>
  <div>
    <PageHeader
      :title="t('contentRouting.title')"
      :subtitle="t('contentRouting.hint')"
      :crumbs="[{ label: t('contentIssues.title'), to: '/admin/content-issues' }, { label: t('contentRouting.title') }]"
    />

    <p class="note sun">{{ t('contentRouting.order') }}</p>
    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="num">{{ t('contentRouting.sort') }}</th>
            <th>{{ t('contentRouting.col.filter') }}</th>
            <th>{{ t('contentRouting.col.assignee') }}</th>
            <th>{{ t('contentRouting.active') }}</th>
            <th v-if="canEdit" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rules" :key="r.id">
            <td class="num">{{ r.fallback ? '—' : r.sort }}</td>
            <td>
              <span v-if="r.fallback" class="badge sun">{{ t('contentRouting.fallback') }}</span>
              {{ conditionOf(r) }}
            </td>
            <td>
              {{ r.assigneeName ?? r.roleName ?? '—' }}
              <span v-if="r.roleName && !r.assigneeName" class="sub">{{ t('contentRouting.role') }}</span>
              <span v-if="r.assigneeActive === false" class="sub warn">{{ t('contentRouting.inactivePerson') }}</span>
            </td>
            <td>
              <label v-if="canEdit" class="check">
                <input type="checkbox" :checked="r.isActive" @change="toggle(r)">
                <span class="sr-only">{{ t('contentRouting.active') }}</span>
              </label>
              <span v-else>{{ r.isActive ? '✓' : '—' }}</span>
            </td>
            <td v-if="canEdit"><button class="btn ghost small" type="button" @click="remove(r)">{{ t('contentRouting.delete') }}</button></td>
          </tr>
          <tr v-if="rules.length === 0">
            <td :colspan="canEdit ? 5 : 4" class="muted">{{ t('contentRouting.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="!canEdit" class="faint">{{ t('contentRouting.readonly') }}</p>

    <form v-else class="card form" @submit.prevent="create">
      <h2 class="panel-title">{{ t('contentRouting.add') }}</h2>
      <label class="check"><input v-model="form.fallback" type="checkbox"> {{ t('contentRouting.fallback') }}</label>
      <p class="help">{{ t('contentRouting.fallbackHint') }}</p>
      <div v-if="!form.fallback" class="grid">
        <label>{{ t('contentRouting.sort') }}
          <input v-model.number="form.sort" class="field" type="number" min="0" max="10000" required>
        </label>
        <label>{{ t('contentRouting.targetType') }}
          <select v-model="form.targetType" class="field">
            <option value="">{{ t('contentRouting.any') }}</option>
            <option v-for="k in CONTENT_ISSUE_TARGET_TYPES" :key="k" :value="k">{{ t(`contentIssues.target.${k}`) }}</option>
          </select>
        </label>
        <label>{{ t('contentRouting.issueType') }}
          <select v-model="form.issueType" class="field">
            <option value="">{{ t('contentRouting.any') }}</option>
            <option v-for="k in CONTENT_ISSUE_TYPES" :key="k" :value="k">{{ t(`issue.type.${k}`) }}</option>
          </select>
        </label>
        <label>{{ t('contentRouting.category') }}
          <select v-model="form.categoryId" class="field">
            <option value="">{{ t('contentRouting.any') }}</option>
            <option v-for="c in categories" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
      </div>
      <fieldset class="assign">
        <legend class="label">{{ t('contentRouting.assignTo') }}</legend>
        <div class="segmented">
          <button type="button" :class="{ on: form.assignTo === 'person' }" :aria-pressed="form.assignTo === 'person'" @click="form.assignTo = 'person'">{{ t('contentRouting.person') }}</button>
          <button type="button" :class="{ on: form.assignTo === 'role' }" :aria-pressed="form.assignTo === 'role'" @click="form.assignTo = 'role'">{{ t('contentRouting.role') }}</button>
        </div>
        <select v-if="form.assignTo === 'person'" v-model="form.assigneeUserId" class="field" required :aria-label="t('contentRouting.person')">
          <option value="" disabled>—</option>
          <option v-for="p in people" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
        <select v-else v-model="form.assigneeRoleId" class="field" required :aria-label="t('contentRouting.role')">
          <option value="" disabled>—</option>
          <option v-for="r in roles" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
      </fieldset>
      <label class="check"><input v-model="form.isActive" type="checkbox"> {{ t('contentRouting.active') }}</label>
      <div><button class="btn primary" type="submit" :disabled="busy">{{ t('contentRouting.add') }}</button></div>
    </form>
  </div>
</template>

<style scoped>
.form { display: grid; gap: var(--space-3); margin-top: var(--space-4); max-width: 720px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--space-3); }
.grid label { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; }
.assign { border: 0; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.check { display: flex; align-items: center; gap: var(--space-2); }
.warn { color: var(--color-coral-ink); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

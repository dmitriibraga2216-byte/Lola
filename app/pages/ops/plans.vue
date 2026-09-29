<script setup lang="ts">
/**
 * Консоль оператора → «Тарифи» (docs/24 §4.4.2, docs/v2/35-billing-limits.md §3.1, §3.4, §7.3).
 *
 * Сітка тарифів з числом компаній на кожному; з правом `billing.plans` — створення, правка й архів
 * (видалення немає). Тариф, на якому є компанії, змінюється лише з причиною, а зменшений ліміт цим
 * компаніям закріплюється на поточному рівні — вирішує сервер (docs/v2/44 В-21), екран лише
 * попереджає. Зміна тарифу конкретній компанії — вкладка «Тариф і оплата» картки.
 */
definePageMeta({ layout: 'ops', middleware: 'ops-auth' })
const { t } = useI18n()
const { ops, can } = useOps()

const LIMIT_FIELDS = ['maxUsers', 'maxStorageGb', 'maxSmsPerMonth', 'maxCandidates', 'maxAiGenerateOps', 'maxAiReviewOps', 'maxAiInterviewOps', 'maxExportRows'] as const
type LimitField = typeof LIMIT_FIELDS[number]
/** Підпис осі — ті самі ключі, що й на вкладці «Ліміти» картки компанії */
const LIMIT_LABEL: Record<LimitField, string> = {
  maxUsers: 'users', maxStorageGb: 'storageGb', maxSmsPerMonth: 'smsPerMonth', maxCandidates: 'candidates',
  maxAiGenerateOps: 'aiGenerateOps', maxAiReviewOps: 'aiReviewOps', maxAiInterviewOps: 'aiInterviewOps', maxExportRows: 'exportRows',
}

interface Plan extends Record<LimitField, number | null> {
  code: string, name: string, titleUk: string | null, tier: number
  aiIncluded: boolean, aiTermDays: number | null, addonsAllowed: string[], priceUah: number | null
  isActive: boolean, sort: number, validFrom: string, validTo: string | null, companies: number
}
const plans = ref<Plan[]>([])
const error = ref('')
const notice = ref('')
const busy = ref(false)
const manage = computed(() => can('billing.plans'))

async function load() {
  try { plans.value = await ops<Plan[]>('/plans') }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
const n = (v: number | null) => v == null ? t('opsConsole.overview.unlimited') : String(v)

// ── Форма створення / правки ───────────────────────────────────────────
type Num = number | string | null
const blank = () => ({
  code: '', name: '', titleUk: '', tier: 0 as Num, sort: 0 as Num, priceUah: null as Num,
  limits: Object.fromEntries(LIMIT_FIELDS.map(f => [f, null])) as Record<LimitField, Num>,
  aiIncluded: true, aiTermDays: null as Num, addonsAllowed: '', validFrom: '', validTo: '', reason: '',
})
const editing = ref<Plan | null>(null)
const formOpen = ref(false)
const form = reactive(blank())
const firstField = ref<HTMLInputElement | null>(null)

/** Порожнє поле числа — `null` («без обмежень» для лімітів); `<input type=number>` віддає '' */
const num = (v: Num) => v === '' || v == null ? null : Number(v)

async function openForm(p: Plan | null) {
  editing.value = p
  Object.assign(form, blank(), p
    ? {
        code: p.code, name: p.name, titleUk: p.titleUk ?? '', tier: p.tier, sort: p.sort, priceUah: p.priceUah,
        limits: Object.fromEntries(LIMIT_FIELDS.map(f => [f, p[f]])),
        aiIncluded: p.aiIncluded, aiTermDays: p.aiTermDays, addonsAllowed: p.addonsAllowed.join(', '),
        validFrom: p.validFrom, validTo: p.validTo ?? '',
      }
    : {})
  formOpen.value = true
  error.value = ''
  await nextTick()
  firstField.value?.focus()
}
function closeForm() { formOpen.value = false; editing.value = null }

function payload() {
  return {
    name: form.name.trim(),
    titleUk: form.titleUk.trim() || null,
    tier: num(form.tier) ?? 0,
    sort: num(form.sort) ?? 0,
    priceUah: num(form.priceUah),
    ...Object.fromEntries(LIMIT_FIELDS.map(f => [f, num(form.limits[f])])),
    aiIncluded: form.aiIncluded,
    aiTermDays: num(form.aiTermDays),
    addonsAllowed: form.addonsAllowed.split(/[\s,]+/).filter(Boolean),
    ...(form.validFrom ? { validFrom: form.validFrom } : {}),
    validTo: form.validTo || null,
  }
}
/** Причина потрібна, коли тариф уже використовують компанії (перевіряє й сервер) */
const needsReason = computed(() => (editing.value?.companies ?? 0) > 0)
/** Які осі зменшуються — екран попереджає, що компаніям їх буде закріплено */
const tightened = computed(() => editing.value
  ? LIMIT_FIELDS.filter((f) => { const a = num(form.limits[f]); const b = editing.value![f]; return a != null && (b == null || a < b) })
  : [])
const formReady = computed(() => form.name.trim().length >= 2 && (editing.value || /^[a-z0-9][a-z0-9_-]{1,29}$/.test(form.code.trim()))
  && (!needsReason.value || form.reason.trim().length >= 10))

async function save() {
  if (!formReady.value || busy.value) return
  error.value = ''
  busy.value = true
  try {
    if (editing.value) {
      const r = await ops<{ companies: number, pinned: number }>(`/plans/${editing.value.code}`, { method: 'PATCH', body: { ...payload(), ...(needsReason.value ? { reason: form.reason.trim() } : {}) } })
      notice.value = r.pinned ? t('opsConsole.plansPage.savedPinned', { n: r.pinned }) : t('opsConsole.plansPage.saved')
    }
    else {
      await ops('/plans', { method: 'POST', body: { code: form.code.trim(), ...payload() } })
      notice.value = t('opsConsole.plansPage.created')
    }
    closeForm()
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}

// ── Архів ──────────────────────────────────────────────────────────────
const archiving = ref<Plan | null>(null)
const archiveReason = ref('')
const archiveReady = computed(() => !archiving.value?.companies || archiveReason.value.trim().length >= 10)
function openArchive(p: Plan) { archiving.value = p; archiveReason.value = ''; error.value = '' }
async function runArchive() {
  const p = archiving.value
  if (!p || !archiveReady.value || busy.value) return
  busy.value = true
  try {
    await ops(`/plans/${p.code}/${p.isActive ? 'archive' : 'restore'}`, { method: 'POST', body: p.companies ? { reason: archiveReason.value.trim() } : {} })
    notice.value = t(p.isActive ? 'opsConsole.plansPage.archived' : 'opsConsole.plansPage.restored')
    archiving.value = null
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = false }
}
</script>

<template>
  <section>
    <h1 class="title">{{ t('opsConsole.nav.plans') }}</h1>
    <p class="help">{{ t(manage ? 'opsConsole.plansPage.hintManage' : 'opsConsole.plansPage.hint') }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="notice" class="note teal" role="status">{{ notice }} <button type="button" class="link" :aria-label="t('common.close')" @click="notice = ''">×</button></p>
    <div v-if="manage && !formOpen" class="chips head"><button type="button" class="btn primary" data-testid="ops-plan-new" @click="openForm(null)">{{ t('opsConsole.plansPage.new') }}</button></div>

    <form v-if="formOpen" class="card create" data-testid="ops-plan-form" @submit.prevent="save" @keydown.esc="closeForm">
      <h2>{{ editing ? t('opsConsole.plansPage.editTitle', { name: editing.name }) : t('opsConsole.plansPage.new') }}</h2>
      <div class="row">
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.f.code') }}</span>
          <input ref="firstField" v-model="form.code" class="field" maxlength="30" autocomplete="off" :disabled="!!editing" :aria-describedby="editing ? 'plan-code-help' : undefined">
          <small v-if="editing" id="plan-code-help" class="muted">{{ t('opsConsole.plansPage.f.codeLocked') }}</small>
        </label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.f.name') }}</span><input v-model="form.name" class="field" maxlength="120" required></label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.f.titleUk') }}</span><input v-model="form.titleUk" class="field" maxlength="120"></label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.f.tier') }}</span><input v-model="form.tier" class="field" type="number" min="0" max="9" inputmode="numeric"></label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.price') }}</span><input v-model="form.priceUah" class="field" type="number" min="0" inputmode="numeric"></label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.f.sort') }}</span><input v-model="form.sort" class="field" type="number" min="0" inputmode="numeric"></label>
      </div>
      <fieldset class="group">
        <legend class="label">{{ t('opsConsole.limits.title') }} <span class="muted">· {{ t('opsConsole.plansPage.f.emptyUnlimited') }}</span></legend>
        <div class="row">
          <label v-for="f in LIMIT_FIELDS" :key="f" class="field-wrap">
            <span class="label">{{ t(`opsConsole.limits.${LIMIT_LABEL[f]}`) }}<em v-if="editing" class="muted"> · {{ t('opsConsole.plansPage.f.now') }}: {{ editing[f] ?? '∞' }}</em></span>
            <input v-model="form.limits[f]" class="field" type="number" min="0" inputmode="numeric" :placeholder="'∞'">
          </label>
        </div>
      </fieldset>
      <div class="row">
        <label class="pick"><input v-model="form.aiIncluded" type="checkbox">{{ t('opsConsole.plansPage.f.aiIncluded') }}</label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.f.aiTermDays') }}</span><input v-model="form.aiTermDays" class="field" type="number" min="1" max="3650" inputmode="numeric"></label>
        <label class="field-wrap"><span class="label">{{ t('opsConsole.plansPage.f.addons') }}</span><input v-model="form.addonsAllowed" class="field" autocomplete="off" :placeholder="t('opsConsole.plansPage.f.addonsAll')"></label>
        <div class="field-wrap date-label"><label for="dt-form-validFrom"><span class="label">{{ t('opsConsole.plansPage.f.validFrom') }}</span></label><input id="dt-form-validFrom" v-model="form.validFrom" class="field" type="date"></div>
        <div class="field-wrap date-label"><label for="dt-form-validTo"><span class="label">{{ t('opsConsole.plansPage.f.validTo') }}</span></label><input id="dt-form-validTo" v-model="form.validTo" class="field" type="date"></div>
      </div>
      <div v-if="needsReason" class="note sun" role="note" data-testid="ops-plan-affected">
        <p>{{ t('opsConsole.plansPage.affected', { n: editing!.companies }) }}</p>
        <p v-if="tightened.length">{{ t('opsConsole.plansPage.pinWarn', { axes: tightened.map(f => t(`opsConsole.limits.${LIMIT_LABEL[f]}`)).join(', ') }) }}</p>
      </div>
      <label v-if="needsReason" class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><input v-model="form.reason" class="field" maxlength="500" placeholder="10–500" required></label>
      <div class="chips">
        <button type="button" class="btn ghost" @click="closeForm">{{ t('common.cancel') }}</button>
        <button type="submit" class="btn primary" :disabled="!formReady || busy">{{ editing ? t('common.save') : t('opsConsole.plansPage.create') }}</button>
      </div>
    </form>

    <form v-if="archiving" class="card create" role="dialog" :aria-label="t(archiving.isActive ? 'opsConsole.plansPage.archive' : 'opsConsole.plansPage.restore')" data-testid="ops-plan-archive" @submit.prevent="runArchive" @keydown.esc="archiving = null">
      <h2>{{ t(archiving.isActive ? 'opsConsole.plansPage.archiveTitle' : 'opsConsole.plansPage.restoreTitle', { name: archiving.name }) }}</h2>
      <p class="help">{{ t(archiving.isActive ? 'opsConsole.plansPage.archiveText' : 'opsConsole.plansPage.restoreText') }}</p>
      <p v-if="archiving.companies" class="note sun">{{ t('opsConsole.plansPage.affected', { n: archiving.companies }) }}</p>
      <label v-if="archiving.companies" class="field-wrap"><span class="label">{{ t('opsConsole.actionsTab.reason') }}</span><input v-model="archiveReason" class="field" maxlength="500" placeholder="10–500" required></label>
      <div class="chips">
        <button type="button" class="btn ghost" @click="archiving = null">{{ t('common.cancel') }}</button>
        <button type="submit" class="btn primary" :disabled="!archiveReady || busy">{{ t(archiving.isActive ? 'opsConsole.plansPage.archive' : 'opsConsole.plansPage.restore') }}</button>
      </div>
    </form>

    <div class="table-wrap">
      <table class="table" data-testid="ops-plans">
        <thead>
          <tr>
            <th>{{ t('opsConsole.plansPage.name') }}</th>
            <th class="num">{{ t('opsConsole.plansPage.companies') }}</th>
            <th class="num">{{ t('opsConsole.limits.users') }}</th>
            <th class="num">{{ t('opsConsole.limits.storageGb') }}</th>
            <th class="num">{{ t('opsConsole.limits.smsPerMonth') }}</th>
            <th class="num">{{ t('opsConsole.limits.candidates') }}</th>
            <th class="num">{{ t('opsConsole.plansPage.price') }}</th>
            <th>{{ t('opsConsole.plansPage.state') }}</th>
            <th v-if="manage"><span class="sr">{{ t('opsConsole.plansPage.actions') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in plans" :key="p.code">
            <td><b>{{ p.name }}</b><span class="sub">{{ p.code }}</span></td>
            <td class="num">{{ p.companies }}</td>
            <td class="num">{{ n(p.maxUsers) }}</td>
            <td class="num">{{ n(p.maxStorageGb) }}</td>
            <td class="num">{{ n(p.maxSmsPerMonth) }}</td>
            <td class="num">{{ n(p.maxCandidates) }}</td>
            <td class="num">{{ p.priceUah != null ? `${p.priceUah} ₴` : '—' }}</td>
            <td><span class="badge" :class="p.isActive ? 'teal' : 'muted'">{{ t(p.isActive ? 'opsConsole.plansPage.active' : 'opsConsole.plansPage.inactive') }}</span></td>
            <td v-if="manage">
              <div class="actions">
                <button type="button" class="btn ghost small" :aria-label="`${t('opsConsole.plansPage.edit')}: ${p.name}`" @click="openForm(p)">{{ t('opsConsole.plansPage.edit') }}</button>
                <button v-if="p.isActive ? p.code !== 'trial' : true" type="button" class="btn ghost small" :aria-label="`${t(p.isActive ? 'opsConsole.plansPage.archive' : 'opsConsole.plansPage.restore')}: ${p.name}`" @click="openArchive(p)">{{ t(p.isActive ? 'opsConsole.plansPage.archive' : 'opsConsole.plansPage.restore') }}</button>
              </div>
            </td>
          </tr>
          <tr v-if="!plans.length"><td :colspan="manage ? 9 : 8" class="muted">{{ t('opsConsole.plansPage.empty') }}</td></tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.title { margin: 0 0 var(--space-2); font-size: var(--font-size-title-l); font-weight: 900; }
.head { margin-bottom: var(--space-3); }
.create { margin-bottom: var(--space-4); display: grid; gap: var(--space-2); }
h2 { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: var(--space-2); }
.field-wrap { display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); align-content: start; }
.field-wrap em { font-style: normal; }
.group { border: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.pick { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--font-size-body-s); font-weight: 700; }
.pick input { width: auto; }
.note p { margin: 0; }
.actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
/* Скрытый заголовок колонки — внутри прокрутки таблицы, иначе абсолютный span растягивает страницу на 320px */
.table-wrap { position: relative; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

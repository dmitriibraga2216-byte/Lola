<script setup lang="ts">
/**
 * Налаштування простору (мокап Settings, docs/24 §3): слева группы — Простір, Модулі, десять групп политик
 * эталона и наши сессии/коды; изменения копятся и сохраняются пачкой («Відхилити зміни / Зберегти»).
 *
 * PR-39 (docs/v2/39 П-24.1 — шесть блоков настроек компании со второго эталона): в «Простір»
 * добавлены логотип с колонтитулом материалов и мови інтерфейсу; отдельными группами —
 * «Двофакторна автентифікація», «Кількість днів відпустки» и «Поведінка таблиць». Шестой блок —
 * API-токен — живёт в «Інтеграції» (`/admin/settings/integrations`), где и был.
 */
import { ACCENT_TOKENS, MODULES } from '#shared/schemas/settings'
import type { TenantPolicies } from '#shared/schemas/settings'
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'settings.tenant' })
const { t } = useI18n()
const { api } = useApi()
const { fetchMe, hasScope } = useAuth()
const { upload } = useMediaUpload()
const { autoLoad, readPreference, setAutoLoad } = useTableBehavior()

interface Space { name: string, slug: string, slugLocked: boolean, locale: string, timezone: string, plan: string, accent: string, logoMediaId: string | null, space: { localesEnabled: string[], contentFooter: boolean }, modules: Record<string, boolean>, lockedModules: Record<string, string>, defaults: Record<string, unknown>, quietHours: { enabled: boolean, from: number, to: number } }

const ALL_GROUPS = ['space', 'modules', 'twoFactor', 'absence', 'tables', 'auth', 'roles', 'subordinates', 'orgStructure', 'passwords', 'phones', 'notifications', 'tasks', 'users', 'dataProtection', 'session'] as const
type Group = typeof ALL_GROUPS[number]
// Нормы отпуска правит носитель `person.absence.manage` (docs/v2/38 §2) — у остальных группы нет
const GROUPS = computed(() => ALL_GROUPS.filter(g => g !== 'absence' || hasScope('person.absence.manage')))
const active = ref<Group>('auth')
const INTERFACE_LOCALES = ['uk', 'en', 'ru'] as const

const space = ref<Space | null>(null)
const spaceForm = reactive({ name: '', slug: '', accent: 'sun', locale: 'uk', timezone: 'Europe/Kyiv', logoMediaId: null as string | null, contentFooter: false, localesEnabled: ['uk'] as string[] })
const logoBusy = ref(false)
const modules = reactive<Record<string, boolean>>({})
const policies = ref<TenantPolicies | null>(null)
const draft = ref<TenantPolicies | null>(null)
const roles = ref<{ code: string, name: string }[]>([])
const error = ref('')
const saved = ref(false)
const listInput = reactive({ virtualDomain: '', countryCode: '' })

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T }
/** Изменились ли поля пространства — колонки tenants, бренд и группа `space` настроек */
const spaceDirty = computed(() => space.value !== null && (spaceForm.name !== space.value.name || spaceForm.slug !== space.value.slug || spaceForm.accent !== space.value.accent || spaceForm.locale !== space.value.locale || spaceForm.timezone !== space.value.timezone
  || spaceForm.logoMediaId !== space.value.logoMediaId || spaceForm.contentFooter !== space.value.space.contentFooter
  || [...spaceForm.localesEnabled].sort().join() !== [...space.value.space.localesEnabled].sort().join()))
const dirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(policies.value)
  || Object.keys(modules).some(k => modules[k] !== space.value?.modules[k])
  || spaceDirty.value)

function fillSpace(s: Space) {
  Object.assign(spaceForm, { name: s.name, slug: s.slug, accent: s.accent, locale: s.locale, timezone: s.timezone, logoMediaId: s.logoMediaId, contentFooter: s.space.contentFooter, localesEnabled: [...s.space.localesEnabled] })
}

async function load() {
  try {
    const [s, p, r] = await Promise.all([api<Space>('/settings/tenant'), api<TenantPolicies>('/settings/policies'), api<{ code: string, name: string }[]>('/settings/roles')])
    space.value = s
    fillSpace(s)
    for (const m of MODULES) modules[m] = s.modules[m] ?? true
    policies.value = p
    draft.value = clone(p)
    roles.value = r
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(() => { load(); readPreference() })

function discard() {
  if (policies.value) draft.value = clone(policies.value)
  if (space.value) {
    fillSpace(space.value)
    for (const m of MODULES) modules[m] = space.value.modules[m] ?? true
  }
  error.value = ''
}

async function save() {
  error.value = ''; saved.value = false
  try {
    if (space.value && spaceDirty.value) {
      const body: Record<string, unknown> = { name: spaceForm.name, accent: spaceForm.accent, locale: spaceForm.locale, timezone: spaceForm.timezone }
      if (spaceForm.slug !== space.value.slug) body.slug = spaceForm.slug
      if (spaceForm.logoMediaId !== space.value.logoMediaId) body.logoMediaId = spaceForm.logoMediaId
      body.space = { contentFooter: spaceForm.contentFooter, localesEnabled: spaceForm.localesEnabled }
      await api('/settings/tenant', { method: 'PATCH', body })
    }
    const modPatch = Object.fromEntries(Object.entries(modules).filter(([k, v]) => v !== space.value?.modules[k]))
    if (Object.keys(modPatch).length) await api('/settings/modules', { method: 'PATCH', body: modPatch })
    if (draft.value && JSON.stringify(draft.value) !== JSON.stringify(policies.value)) {
      const patch: Record<string, unknown> = {}
      for (const g of Object.keys(draft.value) as (keyof TenantPolicies)[]) if (JSON.stringify(draft.value[g]) !== JSON.stringify(policies.value?.[g])) patch[g] = draft.value[g]
      await api('/settings/policies', { method: 'PATCH', body: patch })
    }
    saved.value = true
    await load()
    await fetchMe() // акцент и модули в меню
  }
  catch (err) { error.value = apiErrorOf(err).message }
}

function addTo(list: string[], value: string, re: RegExp) {
  const v = value.trim().toLowerCase()
  if (v && re.test(v) && !list.includes(v)) list.push(v)
}
const removeAt = (list: string[], i: number) => list.splice(i, 1)

/** Логотип пространства (docs/24 §3.1): фирменный файл `brand_asset`, до 2 МБ; сохраняется общей кнопкой. */
async function pickLogo(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''
  if (!file.type.startsWith('image/') || file.size > 2 * 1024 * 1024) { error.value = t('settings.space.logoInvalid'); return }
  logoBusy.value = true
  try { spaceForm.logoMediaId = await upload(file, file.name, 'brand_asset') }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { logoBusy.value = false }
}

/** Мови інтерфейсу (П-24.1): хоча б одна залишається увімкненою. */
function toggleLocale(l: string, on: boolean) {
  const next = on ? [...new Set([...spaceForm.localesEnabled, l])] : spaceForm.localesEnabled.filter(x => x !== l)
  if (next.length) spaceForm.localesEnabled = next
}

// Другий канал OTP — e-mail (docs/28 «Вхід: код на e-mail»): otpChannels — масив, на екрані — перемикач
const otpEmailEnabled = computed({
  get: () => draft.value?.session.otpChannels.includes('email') ?? false,
  set: (v: boolean) => {
    if (!draft.value) return
    const chans = draft.value.session.otpChannels
    draft.value.session.otpChannels = v ? [...new Set([...chans, 'email' as const])] : chans.filter(c => c !== 'email')
  },
})
</script>

<template>
  <div>
    <PageHeader :title="t('settings.policies.title')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('settings.policies.title') }]">
      <template #actions>
        <button class="btn ghost" type="button" :disabled="!dirty" @click="discard">{{ t('settings.discard') }}</button>
        <button class="btn primary" type="button" :disabled="!dirty" @click="save">{{ t('common.save') }}</button>
      </template>
    </PageHeader>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <p v-if="saved && !dirty" class="note teal" role="status">{{ t('common.saved') }}</p>

    <div class="layout">
      <nav class="groups" :aria-label="t('settings.policies.title')">
        <button v-for="g in GROUPS" :key="g" type="button" class="group" :class="{ on: active === g }" @click="active = g">{{ t(`settings.group.${g}`) }}</button>
      </nav>

      <section v-if="draft && space" class="card panel">
        <h2 class="panel-title">{{ t(`settings.group.${active}`) }}</h2>

        <!-- Простір -->
        <template v-if="active === 'space'">
          <label class="label" for="sp-name">{{ t('settings.space.name') }}</label><input id="sp-name" v-model="spaceForm.name" class="field" maxlength="120">
          <label class="label top" for="sp-slug">{{ t('settings.space.slug') }}</label>
          <input id="sp-slug" v-model="spaceForm.slug" class="field" maxlength="30" :disabled="space.slugLocked" pattern="[a-z0-9-]{3,30}">
          <p class="help">{{ space.slugLocked ? t('settings.space.slugLocked') : t('settings.space.slugHint') }}</p>
          <p class="label top">{{ t('settings.space.accent') }}</p>
          <div class="accents" role="radiogroup" :aria-label="t('settings.space.accent')">
            <label v-for="a in ACCENT_TOKENS" :key="a" class="accent" :class="[a, { on: spaceForm.accent === a }]">
              <input v-model="spaceForm.accent" type="radio" name="accent" :value="a"><span>{{ t(`settings.space.accents.${a}`) }}</span>
            </label>
          </div>
          <p class="help">{{ t('settings.space.accentHint') }}</p>
          <label class="label top" for="sp-locale">{{ t('settings.space.locale') }}</label>
          <select id="sp-locale" v-model="spaceForm.locale" class="field"><option value="uk">Українська</option><option value="en">English</option><option value="ru">Русский</option></select>
          <label class="label top" for="sp-tz">{{ t('settings.space.timezone') }}</label><input id="sp-tz" v-model="spaceForm.timezone" class="field" maxlength="60">
          <p class="help">{{ t('settings.space.plan') }}: <b>{{ space.plan }}</b></p>

          <p class="label top">{{ t('settings.space.logo') }}</p>
          <div class="logo-row">
            <img v-if="spaceForm.logoMediaId" :src="`/api/v1/media/${spaceForm.logoMediaId}?redirect=1&variant=320`" :alt="t('settings.space.logo')" class="logo">
            <label class="btn ghost small" :class="{ off: logoBusy }">
              <input type="file" accept="image/*" class="visually-hidden" :disabled="logoBusy" @change="pickLogo">{{ spaceForm.logoMediaId ? t('settings.space.logoReplace') : t('settings.space.logoUpload') }}
            </label>
            <button v-if="spaceForm.logoMediaId" class="btn ghost small" type="button" @click="spaceForm.logoMediaId = null">{{ t('settings.space.logoRemove') }}</button>
          </div>
          <label class="toggle row top"><input v-model="spaceForm.contentFooter" type="checkbox" data-testid="content-footer-toggle"><span>{{ t('settings.space.contentFooter') }}<span class="hint">{{ t('settings.space.contentFooterHint') }}</span></span></label>

          <p class="label top">{{ t('settings.space.localesEnabled') }}</p>
          <p class="help">{{ t('settings.space.localesEnabledHint') }}</p>
          <label v-for="l in INTERFACE_LOCALES" :key="l" class="check">
            <input type="checkbox" :checked="spaceForm.localesEnabled.includes(l)" :disabled="spaceForm.localesEnabled.length === 1 && spaceForm.localesEnabled.includes(l)" @change="toggleLocale(l, ($event.target as HTMLInputElement).checked)"><span>{{ t(`settings.space.locales.${l}`) }}</span>
          </label>
        </template>

        <!-- Двофакторна автентифікація (docs/24 §3.4, П-24.1) -->
        <template v-else-if="active === 'twoFactor'">
          <TwoFactorPanel v-model="draft.passwords.adminTwoFactor" />
        </template>

        <!-- Кількість днів відпустки (docs/v2/38 §5.4, П-24.1) -->
        <template v-else-if="active === 'absence'">
          <AbsenceNormsPanel />
        </template>

        <!-- Поведінка таблиць (П-24.1): налаштування цього браузера, не простору -->
        <template v-else-if="active === 'tables'">
          <p class="help">{{ t('tables.hint') }}</p>
          <label class="toggle row"><input type="checkbox" :checked="autoLoad" data-testid="tables-auto-load" @change="setAutoLoad(($event.target as HTMLInputElement).checked)"><span>{{ t('tables.autoLoad') }}<span class="hint">{{ t('tables.thisBrowser') }}</span></span></label>
        </template>

        <!-- Модулі -->
        <template v-else-if="active === 'modules'">
          <p class="help">{{ t('settings.modules.hint') }}</p>
          <label v-for="m in MODULES" :key="m" class="toggle row">
            <input v-model="modules[m]" type="checkbox" :disabled="!!space?.lockedModules?.[m]">
            <span>{{ t(`settings.modules.names.${m}`) }}</span>
            <span v-if="space?.lockedModules?.[m]" class="badge sun">{{ t('settings.modules.locked', { plan: space.lockedModules[m] }) }}</span>
          </label>
        </template>

        <!-- Аутентифікація -->
        <template v-else-if="active === 'auth'">
          <label class="toggle row"><input v-model="draft.auth.tempPasswordLogin" type="checkbox"><span>{{ t('settings.auth.tempPasswordLogin') }}</span></label>
          <label class="toggle row"><input v-model="draft.auth.hideLoginForm" type="checkbox"><span>{{ t('settings.auth.hideLoginForm') }}</span></label>
          <label class="toggle row"><input v-model="draft.auth.limitLoginAttempts" type="checkbox"><span>{{ t('settings.auth.limitLoginAttempts') }}</span></label>
          <label class="label top" for="p-attempts">{{ t('settings.auth.loginAttempts') }}</label>
          <input id="p-attempts" v-model.number="draft.auth.loginAttempts" class="field num" type="number" min="3" max="10" :disabled="!draft.auth.limitLoginAttempts">
        </template>

        <!-- Ролі -->
        <template v-else-if="active === 'roles'">
          <label class="label" for="p-role">{{ t('settings.rolesPolicy.defaultRole') }}</label>
          <select id="p-role" v-model="draft.roles.defaultRoleCode" class="field"><option v-for="r in roles" :key="r.code" :value="r.code">{{ r.name }}</option></select>
          <label class="toggle row top"><input v-model="draft.roles.noGlobalRoles" type="checkbox"><span>{{ t('settings.rolesPolicy.noGlobalRoles') }}</span></label>
          <p class="label top">{{ t('settings.rolesPolicy.assignmentMode') }}</p>
          <div class="segmented">
            <button v-for="m in ['position_map', 'import']" :key="m" type="button" :class="{ on: draft.roles.assignmentMode === m }" @click="draft.roles.assignmentMode = m as 'position_map'">{{ t(`settings.modes.${m}`) }}</button>
          </div>
        </template>

        <!-- Підлеглі -->
        <template v-else-if="active === 'subordinates'">
          <p class="label">{{ t('settings.subordinates.mode') }}</p>
          <div class="segmented">
            <button v-for="m in ['position_map', 'import']" :key="m" type="button" :class="{ on: draft.subordinates.mode === m }" @click="draft.subordinates.mode = m as 'position_map'">{{ t(`settings.modes.${m}`) }}</button>
          </div>
          <label class="toggle row top"><input v-model="draft.subordinates.includeNestedUnits" type="checkbox"><span>{{ t('settings.subordinates.includeNestedUnits') }}</span></label>
        </template>

        <!-- Оргструктура -->
        <template v-else-if="active === 'orgStructure'">
          <p class="label">{{ t('settings.org.mode') }}</p>
          <div class="segmented">
            <button v-for="m in ['user_groups', 'import', 'hybrid']" :key="m" type="button" :class="{ on: draft.orgStructure.mode === m }" @click="draft.orgStructure.mode = m as 'hybrid'">{{ t(`settings.modes.${m}`) }}</button>
          </div>
          <label class="toggle row top" :class="{ off: draft.orgStructure.mode === 'user_groups' }">
            <input v-model="draft.orgStructure.allowMultipleUnits" type="checkbox" :disabled="draft.orgStructure.mode === 'user_groups'">
            <span>{{ t('settings.org.allowMultipleUnits') }}<span class="hint">{{ t('settings.org.allowMultipleUnitsHint') }}</span></span>
          </label>
          <label class="toggle row"><input v-model="draft.orgStructure.allowMultipleImports" type="checkbox"><span>{{ t('settings.org.allowMultipleImports') }}</span></label>
        </template>

        <!-- Паролі -->
        <template v-else-if="active === 'passwords'">
          <label class="toggle row"><input v-model="draft.passwords.loginEnabled" type="checkbox"><span>{{ t('settings.passwords.loginEnabled') }}</span></label>
          <label class="toggle row"><input v-model="draft.passwords.disableRecovery" type="checkbox"><span>{{ t('settings.passwords.disableRecovery') }}</span></label>
          <label class="toggle row"><input v-model="draft.passwords.allowPhoneRecovery" type="checkbox"><span>{{ t('settings.passwords.allowPhoneRecovery') }}</span></label>
          <label class="label top" for="p-maxage">{{ t('settings.passwords.maxAgeDays') }}</label>
          <input id="p-maxage" v-model.number="draft.passwords.maxAgeDays" class="field num" type="number" min="1" max="365" :placeholder="t('settings.passwords.noLimit')">
          <label class="label top" for="p-minlen">{{ t('settings.passwords.minLength') }}</label>
          <input id="p-minlen" v-model.number="draft.passwords.minLength" class="field num" type="number" min="8" max="32">
          <label class="toggle row top"><input v-model="draft.passwords.forbidWeak" type="checkbox"><span>{{ t('settings.passwords.forbidWeak') }}</span></label>
          <label class="toggle row"><input v-model="draft.passwords.changeAfterFirstLogin" type="checkbox"><span>{{ t('settings.passwords.changeAfterFirstLogin') }}</span></label>
          <p class="help">{{ t('settings.passwords.twoFactorMoved') }}</p>
        </template>

        <!-- Телефони -->
        <template v-else-if="active === 'phones'">
          <p class="label">{{ t('settings.phones.allowedCountryCodes') }}</p>
          <div class="chips">
            <span v-for="(c, i) in draft.phones.allowedCountryCodes" :key="c" class="chip on">+{{ c }} <button type="button" class="x" :aria-label="t('common.delete')" @click="removeAt(draft.phones.allowedCountryCodes, i)">×</button></span>
          </div>
          <div class="add">
            <input v-model="listInput.countryCode" class="field num" inputmode="numeric" maxlength="4" :placeholder="'380'" :aria-label="t('settings.phones.add')" @keydown.enter.prevent="addTo(draft.phones.allowedCountryCodes, listInput.countryCode, /^\d{1,4}$/); listInput.countryCode = ''">
            <button class="btn ghost small" type="button" @click="addTo(draft.phones.allowedCountryCodes, listInput.countryCode, /^\d{1,4}$/); listInput.countryCode = ''">{{ t('settings.phones.add') }}</button>
          </div>
        </template>

        <!-- Сповіщення -->
        <template v-else-if="active === 'notifications'">
          <p class="label">{{ t('settings.notif.virtualDomains') }}</p>
          <p class="help">{{ t('settings.notif.virtualDomainsHint') }}</p>
          <div class="chips">
            <span v-for="(d, i) in draft.notifications.virtualEmailDomains" :key="d" class="chip on">@{{ d }} <button type="button" class="x" :aria-label="t('common.delete')" @click="removeAt(draft.notifications.virtualEmailDomains, i)">×</button></span>
          </div>
          <div class="add">
            <input v-model="listInput.virtualDomain" class="field" maxlength="60" placeholder="local" :aria-label="t('settings.notif.addDomain')" @keydown.enter.prevent="addTo(draft.notifications.virtualEmailDomains, listInput.virtualDomain, /^[a-z0-9.-]{1,60}$/); listInput.virtualDomain = ''">
            <button class="btn ghost small" type="button" @click="addTo(draft.notifications.virtualEmailDomains, listInput.virtualDomain, /^[a-z0-9.-]{1,60}$/); listInput.virtualDomain = ''">{{ t('settings.notif.addDomain') }}</button>
          </div>
        </template>

        <!-- Завдання -->
        <template v-else-if="active === 'tasks'">
          <label class="toggle row"><input v-model="draft.tasks.allowSelfAssignDevelopmentSets" type="checkbox"><span>{{ t('settings.tasks.allowSelfAssign') }}</span></label>
          <label class="toggle row"><input v-model="draft.tasks.showArchivedTasks" type="checkbox"><span>{{ t('settings.tasks.showArchived') }}</span></label>
        </template>

        <!-- Користувачі -->
        <template v-else-if="active === 'users'">
          <label class="toggle row"><input v-model="draft.users.showBlockedInReports" type="checkbox"><span>{{ t('settings.users.showBlockedInReports') }}</span></label>
          <p class="label top">{{ t('settings.users.importKeep') }}</p>
          <p class="help">{{ t('settings.users.importKeepHint') }}</p>
          <label v-for="f in ['tags', 'fullName', 'email', 'phone', 'position', 'location', 'orgUnit']" :key="f" class="check">
            <input v-model="draft.users.importKeepFields" type="checkbox" :value="f"><span>{{ t(`settings.users.fields.${f}`) }}</span>
          </label>
        </template>

        <!-- Захист даних -->
        <template v-else-if="active === 'dataProtection'">
          <label class="toggle row"><input v-model="draft.dataProtection.disablePrint" type="checkbox"><span>{{ t('settings.dataProtection.disablePrint') }}</span></label>
          <label class="toggle row"><input v-model="draft.dataProtection.disableCopy" type="checkbox"><span>{{ t('settings.dataProtection.disableCopy') }}</span></label>
        </template>

        <!-- Сесії та коди -->
        <template v-else-if="active === 'session'">
          <div class="nums">
            <div><label class="label" for="s-len">{{ t('settings.session.lengthDays') }}</label><input id="s-len" v-model.number="draft.session.lengthDays" class="field num" type="number" min="1" max="90"><p class="help">{{ t('settings.session.lengthHint') }}</p></div>
            <div><label class="label" for="s-conc">{{ t('settings.session.maxConcurrent') }}</label><input id="s-conc" v-model.number="draft.session.maxConcurrent" class="field num" type="number" min="1" max="10"></div>
            <div><label class="label" for="s-idle">{{ t('settings.session.idleTimeoutMinutes') }}</label><input id="s-idle" v-model.number="draft.session.idleTimeoutMinutes" class="field num" type="number" min="15" max="43200"></div>
            <div><label class="label" for="s-otplen">{{ t('settings.session.otpLength') }}</label><input id="s-otplen" v-model.number="draft.session.otpLength" class="field num" type="number" min="4" max="8"></div>
            <div><label class="label" for="s-otpttl">{{ t('settings.session.otpTtlMinutes') }}</label><input id="s-otpttl" v-model.number="draft.session.otpTtlMinutes" class="field num" type="number" min="1" max="15"></div>
            <div><label class="label" for="s-otpatt">{{ t('settings.session.otpAttempts') }}</label><input id="s-otpatt" v-model.number="draft.session.otpAttempts" class="field num" type="number" min="3" max="10"></div>
            <div><label class="label" for="s-sends">{{ t('settings.session.otpSendsPer15Min') }}</label><input id="s-sends" v-model.number="draft.session.otpSendsPer15Min" class="field num" type="number" min="1" max="5"></div>
            <div><label class="label" for="s-block">{{ t('settings.session.blockMinutes') }}</label><input id="s-block" v-model.number="draft.session.blockMinutes" class="field num" type="number" min="5" max="120"></div>
          </div>
          <label class="toggle row top"><input v-model="otpEmailEnabled" type="checkbox"><span>{{ t('settings.session.otpEmailEnabled') }}<span class="hint">{{ t('settings.session.otpEmailEnabledHint') }}</span></span></label>
          <label class="toggle row" :class="{ off: !otpEmailEnabled }"><input v-model="draft.session.otpFallbackToEmail" type="checkbox" :disabled="!otpEmailEnabled"><span>{{ t('settings.session.otpFallbackToEmail') }}</span></label>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.layout { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: var(--space-4); align-items: start; }
.groups { display: grid; gap: 2px; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-m); padding: var(--space-2); }
.group { font: inherit; font-weight: 700; text-align: left; border: none; background: transparent; color: var(--color-ink); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); cursor: pointer; }
.group.on { background: var(--color-ink); color: var(--color-bg); }
.panel { display: grid; gap: var(--space-2); }
.row { display: flex; padding: var(--space-2) 0; }
.row.off { opacity: 0.5; }
.top { margin-top: var(--space-3); }
.num { max-width: 160px; }
.nums { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: var(--space-3); }
.add { display: flex; gap: var(--space-2); align-items: center; margin-top: var(--space-2); flex-wrap: wrap; }
.check { display: flex; gap: var(--space-2); align-items: center; padding: var(--space-1) 0; }
.chip .x { font: inherit; border: none; background: transparent; color: inherit; cursor: pointer; margin-left: var(--space-1); }
.accents { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.accent { display: inline-flex; align-items: center; gap: var(--space-2); border: 2px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; font-weight: 700; }
.accent input { appearance: none; width: 16px; height: 16px; border-radius: 50%; margin: 0; }
.accent.sun input { background: var(--color-sun); }
.accent.teal input { background: var(--color-teal); }
.accent.coral input { background: var(--color-coral); }
.accent.ink input { background: var(--color-ink); }
.accent.on { border-color: var(--color-ink); }
.logo-row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.logo { height: 40px; width: auto; max-width: 160px; object-fit: contain; background: var(--color-bg-soft); border-radius: var(--radius-s); padding: var(--space-1); }
.logo-row .off { opacity: 0.5; }
.logo-row label:focus-within { outline: 2px solid var(--color-ink); outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (max-width: 800px) {
  .layout { grid-template-columns: 1fr; }
  .groups { display: flex; overflow-x: auto; }
  .group { white-space: nowrap; }
}
</style>

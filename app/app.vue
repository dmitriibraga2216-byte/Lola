<script setup lang="ts">
/**
 * Оболочка: плашка «Ви увійшли як …» при входе «от имени» (docs/24 §4.5), акцент бренда тенанта
 * CSS-переменной из токенов (docs/29 Б.14) и переводы тенанта поверх словаря (docs/24 §3.6).
 */
const { t, locale, mergeLocaleMessage, setLocale } = useI18n()
const { me, stopImpersonation, stopPreview } = useAuth()
const { api } = useApi()
const route = useRoute()
const isPublic = computed(() => route.path.startsWith('/login') || route.path.startsWith('/ops') || route.path.startsWith('/c/') || route.path.startsWith('/m/'))

const accentVar = computed(() => `var(--color-${me.value?.tenant?.accent ?? 'sun'})`)
// Текст на акценте: на солнце — чернила, на бирюзе/коралле — их глубокий тон, на чернилах — беж
const accentInkVar = computed(() => ({ sun: 'var(--color-ink)', teal: 'var(--color-teal-deep)', coral: 'var(--color-coral-deep)', ink: 'var(--color-bg)' })[me.value?.tenant?.accent ?? 'sun'])

const expiresIn = computed(() => {
  const at = me.value?.impersonation?.expiresAt
  if (!at) return 0
  return Math.max(0, Math.round((new Date(at).getTime() - Date.now()) / 60_000))
})

/** Переопределения строк тенанта: плоские ключи → дерево, поверх текущей локали. */
function unflatten(flat: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.')
    let cur = out
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>
    cur[parts[parts.length - 1]!] = value
  }
  return out
}
// Мова інтерфейсу (docs/24 §3.1, §3.6): своя людини → мова тенанта → uk. Людина ще може
// перемкнути мову вручну на екрані профілю/налаштувань — це просто інший запис у users.locale/
// tenants.locale, який прилетить сюди тим самим шляхом при наступному fetchMe(). Перемикати
// через setLocale() модуля, не через пряме присвоєння locale.value: з увімкненим
// bundle.optimizeTranslationDirective (nuxt.config.ts не вимикає цю дефолтну, але «баговану»
// за словами самого модуля опцію) пряме присвоєння не оновлює вже змонтовані v-t-директиви —
// текст лишається сирим ключем («profile.tiles.rating») доти, доки не перемкнути саме так.
const SUPPORTED_LOCALES = ['uk', 'en', 'ru'] as const
watch(() => me.value ? { user: me.value.user.locale, tenant: me.value.tenant?.locale } : null, (resolved) => {
  if (!resolved) return
  const next = resolved.user ?? resolved.tenant ?? 'uk'
  if ((SUPPORTED_LOCALES as readonly string[]).includes(next) && locale.value !== next) setLocale(next as typeof SUPPORTED_LOCALES[number])
}, { immediate: true })

const loadedFor = ref('')
watch([() => me.value?.tenant?.id, locale], async ([tenantId, loc]) => {
  if (!tenantId || loadedFor.value === `${tenantId}:${loc}`) return
  loadedFor.value = `${tenantId}:${loc}`
  try {
    const overrides = await api<Record<string, string>>(`/translations/${loc}`)
    if (Object.keys(overrides).length) mergeLocaleMessage(loc, unflatten(overrides))
  }
  catch { /* без переопределений — стандартный словарь */ }
}, { immediate: true })
</script>

<template>
  <div :style="{ '--color-accent': accentVar, '--color-accent-ink': accentInkVar }">
    <div v-if="me?.impersonation" class="impersonation-bar" role="status">
      <span>{{ t('impersonation.banner', { name: me?.user.fullName ?? '' }) }} · {{ t('impersonation.operator', { email: me?.impersonation?.operator ?? '' }) }} · {{ t('impersonation.expires', { min: expiresIn }) }}</span>
      <button class="btn small exit" type="button" @click="stopImpersonation">{{ t('impersonation.exit') }}</button>
    </div>
    <div v-else-if="me?.preview" class="impersonation-bar" role="status">
      <span>{{ t('previewAs.banner', { role: me.preview.name }) }}</span>
      <button class="btn small exit" type="button" @click="stopPreview">{{ t('previewAs.exit') }}</button>
    </div>
    <!-- Без NuxtLayout лейауты (сайдбар админки, нижняя панель кабинета) не применяются вовсе -->
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <AnnouncementGate v-if="!isPublic" />
  </div>
</template>

<style>
.impersonation-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  align-items: center;
  gap: var(--space-2) var(--space-3);
  background: var(--color-coral);
  color: var(--color-coral-deep);
  font-family: var(--font-family);
  font-weight: 800;
  font-size: var(--font-size-body-s);
  text-align: center;
  padding: var(--space-1) var(--space-3);
}
.impersonation-bar .exit { background: var(--color-coral-deep); color: var(--color-bg); border: 1px solid var(--color-coral-deep); }
</style>

<script setup lang="ts">
/**
 * Баннер лимита (docs/v2/35-billing-limits.md §5.5, §7.9) — полоса под шапкой на каждом
 * экране тенанта. Видят `admin` и `owner` (скоуп `billing.view`), `employee` и `manager` —
 * никогда.
 *
 * `warn`: «Незабаром буде досягнуто ліміту: {ось} — {використано} із {ліміт}.» плюс
 * «Змінити тариф» и крестик (прячет на 24 часа). `exceeded`: «Ліміт вичерпано: …» плюс
 * последствие из §7.1 — крестика нет. При нескольких сработавших осях — одна полоса с
 * наиболее тяжёлым уровнем и счётчиком «та ще N» (§7.9 п. 1).
 *
 * Считает сервер: и факт, и лимит, и уровень приходят готовыми (`GET /billing/notices`).
 */
const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()

interface Notice {
  id: string
  axis: string
  level: 'warn' | 'exceeded'
  valueAtRaise: number
  limitAtRaise: number | null
  degradation: string | null
}

const notices = ref<Notice[]>([])
const busy = ref(false)

async function load() {
  if (!hasScope('billing.view')) return
  try { notices.value = await api<Notice[]>('/billing/notices') }
  catch { notices.value = [] }
}
onMounted(load)

const top = computed(() => notices.value[0] ?? null)
const more = computed(() => Math.max(0, notices.value.length - 1))

const GIB = 1024 ** 3
function amount(axis: string, n: number | null): string {
  if (n === null) return t('billing.unlimited')
  return axis === 'storage_bytes' ? `${(n / GIB).toFixed(1)} ${t('settings.usage.gb')}` : String(n)
}

const message = computed(() => {
  const n = top.value
  if (!n) return ''
  const params = {
    axis: t(`billing.axis.${n.axis}`),
    used: amount(n.axis, n.valueAtRaise),
    limit: amount(n.axis, n.limitAtRaise),
  }
  const head = t(n.level === 'exceeded' ? 'billing.limitExceeded' : 'billing.limitWarning', params)
  return n.level === 'exceeded' ? `${head} ${t(`billing.limitConsequence.${n.axis}`)}` : head
})

async function dismiss(id: string) {
  busy.value = true
  try {
    await api(`/billing/notices/${id}/dismiss`, { method: 'POST' })
    notices.value = notices.value.filter(n => n.id !== id)
  }
  catch { /* закрыть нельзя — баннер остаётся, это и есть ответ пользователю */ }
  finally { busy.value = false }
}
</script>

<template>
  <div v-if="top" class="limit-banner" :class="top.level" role="status">
    <p class="msg">
      {{ message }}
      <span v-if="more" class="more">{{ t('billing.banner.more', { n: more }) }}</span>
    </p>
    <NuxtLink to="/admin/settings/usage" class="act">{{ t('billing.banner.change') }}</NuxtLink>
    <button v-if="top.level === 'warn'" class="close" :disabled="busy" :aria-label="t('billing.banner.hide')" @click="dismiss(top.id)">×</button>
  </div>
</template>

<style scoped>
.limit-banner { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-bg-line-soft); }
.limit-banner.warn { background: var(--color-sun-soft); color: var(--color-ink); }
.limit-banner.exceeded { background: var(--color-coral-soft); color: var(--color-coral-ink); }
.msg { margin: 0; font-weight: 700; font-size: var(--font-size-body-s); min-width: 0; }
.more { color: var(--color-ink-muted); font-weight: 700; }
.act { margin-left: auto; font-weight: 800; font-size: var(--font-size-body-s); color: inherit; }
.close { font: inherit; font-size: var(--font-size-h3); line-height: 1; border: none; background: transparent; color: inherit; cursor: pointer; padding: 0 var(--space-2); border-radius: var(--radius-s); }
.close:disabled { opacity: .6; cursor: progress; }
</style>

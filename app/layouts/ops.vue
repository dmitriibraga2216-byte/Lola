<script setup lang="ts">
/**
 * Каркас консоли оператора платформы (docs/25 §7 п. 6): боковое меню, кто вошёл и с какой ролью,
 * выход. На узком экране (от 320px) меню сворачивается в кнопку. Со вторым PR (ops-console-2)
 * все разделы полноценны; прежняя панель `/ops` осталась только редиректом на `/ops/companies`.
 */
const { t } = useI18n()
const { me, fetchMe, logout } = useOps()
// Страховка к гарду `ops-auth`: данные консоли — только в браузере, и если гард на первой
// загрузке не отработал на клиенте, каркас сам узнаёт оператора, а не висит на «Завантаження…»
onMounted(async () => {
  if (me.value) return
  const who = await fetchMe()
  if (!who) await navigateTo('/ops/login')
  else if (who.twoFactor) await navigateTo('/ops/two-factor')
})
const route = useRoute()
const open = ref(false)
watch(() => route.path, () => { open.value = false })

const items = [
  { to: '/ops/companies', key: 'companies' },
  { to: '/ops/plans', key: 'plans' },
  { to: '/ops/announcements', key: 'announcements' },
  { to: '/ops/metrics', key: 'metrics' },
  { to: '/ops/operators', key: 'operators' },
  { to: '/ops/audit', key: 'audit' },
] as const
</script>

<template>
  <div class="ops-shell">
    <header class="ops-top">
      <button type="button" class="btn ghost small menu-toggle" :aria-expanded="open" aria-controls="ops-nav" @click="open = !open">{{ t('opsConsole.menu') }}</button>
      <NuxtLink to="/ops/companies" class="brand"><span class="dots" aria-hidden="true"><i class="sun" /><i class="teal" /><i class="coral" /><i class="ink" /></span><b>{{ t('opsConsole.title') }}</b></NuxtLink>
      <div v-if="me" class="who">
        <span class="muted">{{ me.email }}</span>
        <span class="badge">{{ t(`opsConsole.roles.${me.role}`) }}</span>
        <button type="button" class="btn ghost small" @click="logout">{{ t('home.logout') }}</button>
      </div>
    </header>
    <div class="ops-body">
      <nav id="ops-nav" class="ops-nav" :class="{ open }" :aria-label="t('opsConsole.menu')">
        <NuxtLink v-for="i in items" :key="i.to" :to="i.to" class="nav-item">{{ t(`opsConsole.nav.${i.key}`) }}</NuxtLink>
      </nav>
      <main class="ops-main">
        <slot v-if="me" />
        <p v-else class="muted">{{ t('opsConsole.loading') }}</p>
      </main>
    </div>
  </div>
</template>

<style scoped>
.ops-shell { min-height: 100vh; background: var(--color-bg); color: var(--color-ink); font-family: var(--font-family); }
.ops-top { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--color-bg-line); }
.brand { display: flex; align-items: center; gap: var(--space-2); color: var(--color-ink); text-decoration: none; }
.dots { display: inline-flex; gap: var(--space-1); }
.dots i { width: var(--space-2); height: var(--space-2); border-radius: var(--radius-pill); display: inline-block; }
.dots .sun { background: var(--color-sun); }
.dots .teal { background: var(--color-teal); }
.dots .coral { background: var(--color-coral); }
.dots .ink { background: var(--color-ink); }
.who { margin-left: auto; display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); min-width: 0; }
.who .muted { overflow-wrap: anywhere; }
.menu-toggle { display: none; }
.ops-body { display: flex; }
.ops-nav { display: flex; flex-direction: column; gap: var(--space-1); padding: var(--space-4); min-width: 200px; border-right: 1px solid var(--color-bg-line); }
.nav-item { color: var(--color-ink); text-decoration: none; font-weight: 700; padding: var(--space-2) var(--space-3); border-radius: var(--radius-s); }
.nav-item:hover, .nav-item:focus-visible { background: var(--color-bg-soft); }
.nav-item.router-link-exact-active, .nav-item.router-link-active { background: var(--color-ink); color: var(--color-bg); }
.ops-main { flex: 1; min-width: 0; padding: var(--space-4); }
@media (max-width: 720px) {
  .menu-toggle { display: inline-flex; }
  .ops-body { flex-direction: column; }
  .ops-nav { display: none; border-right: 0; border-bottom: 1px solid var(--color-bg-line); }
  .ops-nav.open { display: flex; }
  .who { margin-left: 0; width: 100%; }
}
</style>

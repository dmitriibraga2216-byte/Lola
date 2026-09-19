<script setup lang="ts">
/**
 * Каркас кабинета сотрудника (телефон 390×844, docs/31): без шапки, нижняя панель
 * «Навчання · Каталог · Бонуси · Профіль». «Бонуси» — R3, вкладка появится с модулем.
 */
const { t } = useI18n()
const route = useRoute()
const isTab = (path: string) => route.path === path || (path !== '/learn' && route.path.startsWith(`${path}/`))
</script>

<template>
  <div class="learner">
    <main class="content">
      <slot />
    </main>
    <nav class="bottom" :aria-label="t('learner.nav.aria')">
      <NuxtLink to="/learn" :class="['tab', { on: isTab('/learn') }]">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h10a3 3 0 0 1 3 3v13H7a2 2 0 0 0-2 2V4zm2 2v12.2A4 4 0 0 1 8 18h8V7a1 1 0 0 0-1-1H7z" fill="currentColor" /></svg>
        <span>{{ t('learner.nav.learning') }}</span>
      </NuxtLink>
      <NuxtLink to="/learn/catalog" :class="['tab', { on: isTab('/learn/catalog') }]">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm6.3 9.9 4.4 4.4-1.4 1.4-4.4-4.4 1.4-1.4z" fill="currentColor" /></svg>
        <span>{{ t('learner.nav.catalog') }}</span>
      </NuxtLink>
      <NuxtLink to="/learn/profile" :class="['tab', { on: isTab('/learn/profile') }]">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 8a7 7 0 0 1 14 0H5z" fill="currentColor" /></svg>
        <span>{{ t('learner.nav.profile') }}</span>
      </NuxtLink>
    </nav>
  </div>
</template>

<style scoped>
.learner { min-height: 100dvh; background: var(--color-bg); font-family: var(--font-family); color: var(--color-ink); display: flex; flex-direction: column; }
.content { flex: 1; padding: var(--space-4); padding-bottom: calc(72px + var(--space-4) + env(safe-area-inset-bottom)); max-width: 720px; width: 100%; margin: 0 auto; box-sizing: border-box; }
.bottom { position: fixed; bottom: 0; left: 0; right: 0; display: flex; justify-content: space-around; background: var(--color-bg-soft); border-top: 1px solid var(--color-bg-line-soft); padding: var(--space-2) var(--space-2) calc(var(--space-2) + env(safe-area-inset-bottom)); }
.tab { display: grid; justify-items: center; gap: 2px; font-weight: 700; font-size: 11px; color: var(--color-ink-muted); text-decoration: none; padding: var(--space-1) var(--space-3); min-width: 72px; }
.tab svg { width: 22px; height: 22px; }
.tab.on { color: var(--color-ink); font-weight: 800; }
</style>

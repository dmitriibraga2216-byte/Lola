<script setup lang="ts">
const { t } = useI18n()
const { me, hasScope } = useAuth()
</script>

<template>
  <div class="learner">
    <main class="content">
      <slot />
    </main>
    <nav class="bottom">
      <NuxtLink to="/learn" class="tab">{{ t('learner.nav.learning') }}</NuxtLink>
      <NuxtLink to="/learn/catalog" class="tab">{{ t('learner.nav.catalog') }}</NuxtLink>
      <NuxtLink to="/learn/knowledge" class="tab">{{ t('kb.short') }}</NuxtLink>
      <NuxtLink to="/learn/news" class="tab">{{ t('news.short') }}</NuxtLink>
      <NuxtLink to="/learn/development" class="tab">{{ t('dev.short') }}</NuxtLink>
      <NuxtLink v-if="hasScope('people.view')" to="/admin/people" class="tab">{{ t('learner.nav.admin') }}</NuxtLink>
      <NuxtLink to="/" class="tab">{{ me?.user.fullName.split(' ')[0] || t('learner.nav.profile') }}</NuxtLink>
    </nav>
  </div>
</template>

<style scoped>
.learner {
  min-height: 100dvh;
  background: var(--color-bg);
  font-family: var(--font-family);
  color: var(--color-ink);
  display: flex;
  flex-direction: column;
}

.content {
  flex: 1;
  padding: var(--space-4);
  padding-bottom: calc(var(--space-7) + var(--space-4));
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
}

.bottom {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-around;
  background: var(--color-bg-soft);
  border-top: 1px solid var(--color-bg-line);
  padding: var(--space-2) var(--space-2) calc(var(--space-2) + env(safe-area-inset-bottom));
}

.tab {
  font-weight: 700;
  font-size: var(--font-size-body-s);
  color: var(--color-ink-muted);
  text-decoration: none;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-pill);
}

.tab.router-link-exact-active {
  background: var(--color-ink);
  color: var(--color-bg-soft);
}
</style>

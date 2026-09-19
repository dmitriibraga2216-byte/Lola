<script setup lang="ts">
/**
 * Шапка страницы админки по мокапам: хлебные крошки, заголовок 900, справа действия
 * (одно солнечное + ghost). Крошки — массив [{label, to?}]; последняя — текущий раздел.
 */
defineProps<{
  title: string
  crumbs?: { label: string, to?: string }[]
  subtitle?: string
}>()
</script>

<template>
  <header class="page-header">
    <div class="titles">
      <nav v-if="crumbs?.length" class="crumbs" aria-label="breadcrumb">
        <template v-for="(c, i) in crumbs" :key="i">
          <NuxtLink v-if="c.to" :to="c.to" class="crumb">{{ c.label }}</NuxtLink>
          <span v-else class="crumb">{{ c.label }}</span>
          <span v-if="i < crumbs.length - 1" class="sep" aria-hidden="true">·</span>
        </template>
      </nav>
      <h1 class="title">{{ title }}</h1>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); padding: 0 0 var(--space-4); border-bottom: 1px solid var(--color-bg-line-soft); margin-bottom: var(--space-4); }
.titles { min-width: 0; }
.crumbs { display: flex; flex-wrap: wrap; gap: var(--space-1); font-size: var(--font-size-body-s); font-weight: 700; color: var(--color-ink-muted); margin-bottom: var(--space-1); }
.crumb { color: inherit; text-decoration: none; }
.sep { color: var(--color-ink-faint); }
.title { margin: 0; font-size: 28px; font-weight: 900; letter-spacing: -0.02em; line-height: 1.15; }
.subtitle { margin: var(--space-1) 0 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.actions { display: flex; gap: var(--space-2); flex: none; flex-wrap: wrap; justify-content: flex-end; }
@media (max-width: 600px) {
  .page-header { flex-direction: column; align-items: stretch; }
  .actions { justify-content: flex-start; }
}
</style>

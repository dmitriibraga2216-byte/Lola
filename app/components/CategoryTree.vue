<script setup lang="ts">
/**
 * Дерево категорій (докс/33 D-041): рекурсивний список — стільки рівнів, скільки в
 * `resource_categories.parent_id`. Nuxt реєструє компонент глобально за іменем файлу,
 * тож рекурсивне використання нижче працює без додаткової реєстрації.
 */
interface Node { id: string, name: string, children: Node[] }
defineProps<{ nodes: Node[], activeId: string | null }>()
const emit = defineEmits<{ select: [id: string] }>()
</script>

<template>
  <ul class="tree">
    <li v-for="n in nodes" :key="n.id">
      <button type="button" :class="['node', { on: activeId === n.id }]" @click="emit('select', n.id)">{{ n.name }}</button>
      <CategoryTree v-if="n.children.length" :nodes="n.children" :active-id="activeId" @select="(id: string) => emit('select', id)" />
    </li>
  </ul>
</template>

<style scoped>
.tree { list-style: none; margin: 0; padding: 0; }
.tree .tree { padding-left: var(--space-3); }
.node { display: block; width: 100%; text-align: left; font: inherit; background: none; border: none; padding: var(--space-1) var(--space-2); border-radius: var(--radius-s); cursor: pointer; color: var(--color-ink); }
.node.on { background: var(--color-sun); font-weight: 800; }
.node:hover { background: var(--color-bg-line-soft); }
</style>

<script setup lang="ts">
import type { LibraryTypeIcon } from '#shared/domain/library'

/**
 * Иконка колонки «Тип» модуля библиотеки (docs/v2/31 §7.7, критерий 7): `file` — документ,
 * `video` — плёнка, `link` — цепочка; `article` — «T», чек-лист или таблица по доминирующему
 * блоку тела. Какую иконку показать, решает сервер (`typeIcon` карточки); здесь — только рисунок.
 */
const props = defineProps<{ icon: LibraryTypeIcon }>()
const { t } = useI18n()
const label = computed(() => t(`library.icon.${props.icon}`))
</script>

<template>
  <svg class="type-icon" viewBox="0 0 24 24" role="img" :aria-label="label">
    <title>{{ label }}</title>
    <g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path v-if="icon === 'text'" d="M5 5h14M12 5v14M9 19h6" />
      <path v-else-if="icon === 'checklist'" d="M4 7l2 2 3-3M12 8h8M4 15l2 2 3-3M12 16h8" />
      <template v-else-if="icon === 'table'">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M3 10h18M3 15h18M9 4v16M15 4v16" />
      </template>
      <path v-else-if="icon === 'file'" d="M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6" />
      <template v-else-if="icon === 'video'">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4" />
      </template>
      <path v-else d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </g>
  </svg>
</template>

<style scoped>
.type-icon { width: 20px; height: 20px; flex: none; color: var(--color-ink); }
</style>

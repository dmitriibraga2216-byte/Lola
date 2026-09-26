<script setup lang="ts">
/**
 * Стара панель оператора (docs/24 §4, ops-console-2): усі дії перенесено в нову консоль
 * (`/ops/companies`, картка компанії та її вкладки, «Тарифи», «Оголошення», «Метрики»,
 * «Журнал»). Сторінка лишається редиректом — старі закладки й посилання не мають ламатись.
 */
definePageMeta({ layout: false })
await navigateTo('/ops/companies', { replace: true })
</script>

<template>
  <div />
</template>

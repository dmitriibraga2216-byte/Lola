<script setup lang="ts">
// Корень сайта — не отдельный экран (в мокапах его нет): сразу домашний экран по активной роли.
definePageMeta({ layout: false })
const { me } = useAuth()
await navigateTo(homeFor(me.value), { replace: true })
</script>

<template>
  <div />
</template>

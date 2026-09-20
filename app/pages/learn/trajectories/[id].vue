<script setup lang="ts">
import type { Ladder } from '~/components/TrajectoryLadder.vue'

/** Моя траектория по мокапу MyTrajectory: лента шагов — только мой фактический путь. */
definePageMeta({ layout: 'learner' })
const { api } = useApi()
const route = useRoute()
const ladder = ref<Ladder | null>(null)
const error = ref('')
onMounted(async () => { try { ladder.value = await api(`/me/trajectories/${route.params.id}`) } catch (err) { error.value = apiErrorOf(err).message } })
</script>

<template>
  <div>
    <NuxtLink to="/learn/trajectories" class="link back">←</NuxtLink>
    <p v-if="error" class="error-text">{{ error }}</p>
    <TrajectoryLadder v-if="ladder" :ladder="ladder" mine />
  </div>
</template>

<style scoped>
.back { display: inline-block; margin-bottom: var(--space-3); font-size: var(--font-size-title-l); text-decoration: none; }
</style>

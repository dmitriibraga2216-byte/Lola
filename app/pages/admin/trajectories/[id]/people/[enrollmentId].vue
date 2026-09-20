<script setup lang="ts">
import type { Ladder } from '~/components/TrajectoryLadder.vue'

/** Лента прохождения глазами администратора/наставника; наставник подтверждает шаг «Наставник». */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'program.manage' })
const { t } = useI18n()
const { api } = useApi()
const route = useRoute()
const id = route.params.id as string
const enrollmentId = route.params.enrollmentId as string
const ladder = ref<Ladder | null>(null)
const error = ref('')
async function load() { try { ladder.value = await api(`/trajectories/enrollments/${enrollmentId}`) } catch (err) { error.value = apiErrorOf(err).message } }
onMounted(load)
async function confirm(nodeId: string) {
  error.value = ''
  try { await api(`/trajectories/enrollments/${enrollmentId}/nodes/${nodeId}/confirm`, { method: 'POST', body: {} }); await load() }
  catch (err) { error.value = apiErrorOf(err).message }
}
</script>

<template>
  <div>
    <PageHeader :title="ladder?.title ?? ''" :subtitle="t('traj.ladder')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('traj.title'), to: '/admin/trajectories' }, { label: t('traj.peopleTitle'), to: `/admin/trajectories/${id}/people` }]" />
    <p v-if="error" class="error-text">{{ error }}</p>
    <div class="narrow">
      <TrajectoryLadder v-if="ladder" :ladder="ladder" can-confirm @confirm="confirm" />
    </div>
  </div>
</template>

<style scoped>
.narrow { max-width: 640px; }
</style>

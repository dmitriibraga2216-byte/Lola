<script setup lang="ts">
/** Мои траектории (docs/04 §4.4 /me/trajectories) + каталог траекторий с самозаписью/заявкой. */
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface Mine { id: string, trajectoryId: string, title: string, status: string, progressPct: string, total: number, done: number, availableFrom: string | null, startedAt: string | null }
interface Cat { id: string, title: string, description: string | null, assignMode: string, blocks: number, enrollmentId: string | null, enrollmentStatus: string | null, requestedAt: string | null }
const mine = ref<Mine[]>([])
const catalog = ref<Cat[]>([])
const error = ref('')
const notice = ref('')
async function load() {
  try { [mine.value, catalog.value] = await Promise.all([api<Mine[]>('/me/trajectories'), api<Cat[]>('/me/trajectories/catalog')]) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
async function enroll(c: Cat) {
  error.value = ''; notice.value = ''
  try {
    const r = await api<{ requested?: boolean }>(`/me/trajectories/catalog/${c.id}/enroll`, { method: 'POST', body: {} })
    notice.value = r.requested ? t('traj.requested') : t('traj.enrolled'); await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
const pct = (m: Mine) => m.total ? Math.round((m.done / m.total) * 100) : Number(m.progressPct)
const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString('uk-UA') : ''
</script>

<template>
  <div>
    <h1 class="title">{{ t('traj.my') }}</h1>
    <p v-if="error" class="error-text">{{ error }}</p>
    <p v-if="notice" class="note teal">{{ notice }}</p>
    <p v-if="!mine.length" class="empty">{{ t('traj.myEmpty') }}</p>
    <div class="list">
      <NuxtLink v-for="m in mine" :key="m.id" :to="`/learn/trajectories/${m.id}`" class="card item" :data-testid="`traj-${m.trajectoryId}`">
        <div class="row"><span class="item-title">{{ m.title }}</span><span :class="['badge', m.status]">{{ t(`traj.state.${m.status}`) }}</span></div>
        <div class="bar"><span :style="{ width: `${pct(m)}%` }" /></div>
        <span class="sub">{{ t('traj.passedOf', { done: m.done, total: m.total }) }} · {{ pct(m) }}%<template v-if="m.availableFrom && !m.startedAt"> · {{ t('traj.opensAt', { date: fmt(m.availableFrom) }) }}</template></span>
      </NuxtLink>
    </div>
    <template v-if="catalog.length">
      <h2 class="title h2">{{ t('traj.catalog') }}</h2>
      <div class="list">
        <div v-for="c in catalog" :key="c.id" class="card item">
          <span class="item-title">{{ c.title }}</span>
          <span v-if="c.description" class="sub">{{ c.description }}</span>
          <span class="sub">{{ t('traj.tasksN', { n: c.blocks }) }}</span>
          <div class="row">
            <span v-if="c.enrollmentId" class="badge">{{ c.enrollmentStatus === 'not_assigned' ? t('traj.state.requested') : t(`traj.state.${c.enrollmentStatus}`) }}</span>
            <button v-else class="btn primary small" @click="enroll(c)">{{ c.assignMode === 'catalog_request' ? t('traj.request') : t('traj.enroll') }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.title { margin: 0 0 var(--space-4); font-size: var(--font-size-title-l); font-weight: 900; }
.h2 { margin-top: var(--space-5); }
.list { display: grid; gap: var(--space-3); }
.item { display: grid; gap: var(--space-2); text-decoration: none; color: inherit; }
.item-title { font-weight: 800; }
.row { display: flex; justify-content: space-between; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.bar { height: 8px; background: var(--color-bg-line-soft); border-radius: var(--radius-pill); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--color-teal); }
.sub { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
.empty { color: var(--color-ink-faint); }
</style>

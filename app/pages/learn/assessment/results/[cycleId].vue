<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
const { me } = useAuth()
const route = useRoute()
interface Kind { avg: number | null, n: number }
interface Group { groupId: string, name: string, byKind: Record<string, Kind> }
interface Res { cycle: { title: string, minRatersToShow: number }, groups: Group[], overall: Record<string, number | null>, gaps: { groupId: string, selfVsManager: number | null }[], hiddenKinds: string[], comments: { criterionId: string, kind: string, comment: string }[], structure: { id: string, name: string, criteria: { id: string, text: string }[] }[] }
const res = ref<Res | null>(null)
const error = ref('')
const userId = computed(() => String(route.query.userId || me.value?.user.id))
onMounted(async () => {
  try { res.value = await api<Res>(`/assessment/results/${userId.value}?cycleId=${route.params.cycleId}`) } catch (err) { error.value = apiErrorOf(err).message }
})
const kinds = computed(() => res.value ? [...new Set(res.value.groups.flatMap(g => Object.keys(g.byKind)))] : [])
const critText = (id: string) => res.value?.structure.flatMap(g => g.criteria).find(c => c.id === id)?.text ?? ''
// Лепестковая диаграмма: одна ось на группу, радиус = средняя / 5
const R = 110
const pt = (i: number, v: number, n: number) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / n; const r = (v / 5) * R; return `${(150 + r * Math.cos(a)).toFixed(1)},${(150 + r * Math.sin(a)).toFixed(1)}` }
const poly = (kind: string) => res.value!.groups.map((g, i) => pt(i, g.byKind[kind]?.avg ?? 0, res.value!.groups.length)).join(' ')
const colors: Record<string, string> = { self: 'var(--color-sun-ink)', manager: 'var(--color-teal-deep)', peer: 'var(--color-coral-deep)', subordinate: 'var(--color-ink-muted)', mentor: 'var(--color-ink)' }
</script>
<template>
  <div>
    <NuxtLink to="/learn/assessment" class="back">← {{ t('assess.title') }}</NuxtLink>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="res">
      <h1>{{ res.cycle.title }}</h1>
      <div class="legend"><span v-for="k in kinds" :key="k" :style="{ color: colors[k] }">● {{ t(`assess.kind.${k}`) }}<template v-if="res.overall[k] != null"> {{ res.overall[k] }}</template></span></div>
      <svg v-if="res.groups.length >= 3" viewBox="0 0 300 300" class="radar">
        <polygon v-for="lvl in [1, 2, 3, 4, 5]" :key="lvl" :points="res.groups.map((_, i) => pt(i, lvl, res!.groups.length)).join(' ')" fill="none" stroke="var(--color-bg-line)" />
        <polygon v-for="k in kinds" :key="k" :points="poly(k)" :stroke="colors[k]" fill="none" stroke-width="2" />
        <text v-for="(g, i) in res.groups" :key="g.groupId" :x="pt(i, 6.2, res.groups.length).split(',')[0]" :y="pt(i, 6.2, res.groups.length).split(',')[1]" text-anchor="middle" font-size="10" fill="var(--color-ink-muted)">{{ g.name }}</text>
      </svg>
      <table class="table">
        <thead><tr><th>{{ t('assess.group') }}</th><th v-for="k in kinds" :key="k">{{ t(`assess.kind.${k}`) }}</th></tr></thead>
        <tbody>
          <tr v-for="(g, gi) in res.groups" :key="g.groupId" :class="{ gap: Math.abs(res.gaps[gi]?.selfVsManager ?? 0) > 1 }">
            <td>{{ g.name }}<span v-if="Math.abs(res.gaps[gi]?.selfVsManager ?? 0) > 1" class="gapmark"> · {{ t('assess.gap') }}</span></td>
            <td v-for="k in kinds" :key="k">{{ g.byKind[k]?.avg ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="res.hiddenKinds.length" class="note">{{ t('assess.hiddenNote', { n: res.cycle.minRatersToShow }) }}</p>
      <section v-if="res.comments.length" class="card">
        <h2>{{ t('assess.comments') }}</h2>
        <ul class="log"><li v-for="(c, i) in res.comments" :key="i"><b>{{ t(`assess.kind.${c.kind}`) }}</b> · {{ critText(c.criterionId) }}: {{ c.comment }}</li></ul>
      </section>
    </template>
  </div>
</template>
<style scoped>
.back { color: var(--color-ink-muted); text-decoration: none; font-weight: 700; }
h1 { margin: var(--space-2) 0; font-weight: 900; }
h2 { margin: 0; font-weight: 800; font-size: var(--font-size-title-l); }
.legend { display: flex; flex-wrap: wrap; gap: var(--space-3); font-weight: 700; font-size: var(--font-size-body-s); }
.radar { width: min(320px, 100%); display: block; margin: var(--space-2) auto; }
.table { width: 100%; border-collapse: collapse; background: var(--color-bg-soft); border-radius: var(--radius-m); overflow: hidden; }
th, td { text-align: left; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-bg-line-soft); }
th { font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
tr.gap td { background: var(--color-sun); }
.gapmark { color: var(--color-coral-deep); font-size: var(--font-size-body-s); font-weight: 700; }
.note { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-2); margin-top: var(--space-3); }
.log { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-1); font-size: var(--font-size-body-s); }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>

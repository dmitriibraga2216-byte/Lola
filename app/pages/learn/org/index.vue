<script setup lang="ts">
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface Loc { id: string, name: string, address: string | null, manager: string | null, people: { id: string, fullName: string, position: string }[] }
interface Unit { id: string, name: string, locations: Loc[], children: Unit[] }
const tree = ref<{ units: Unit[], totals: { locations: number, people: number } } | null>(null)
const error = ref('')
const open = ref<Record<string, boolean>>({})
onMounted(async () => { try { tree.value = await api('/org/tree') } catch (err) { error.value = apiErrorOf(err).message } })
</script>
<template>
  <div>
    <h1>{{ t('org.title') }}</h1>
    <p v-if="tree" class="sub">{{ t('org.totals', { l: tree.totals.locations, p: tree.totals.people }) }}</p>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="tree">
      <section v-for="u in tree.units" :key="u.id" class="unit">
        <h2>{{ u.name }}</h2>
        <div v-for="l in u.locations" :key="l.id" class="card">
          <button class="loc" @click="open[l.id] = !open[l.id]">
            <span><b>{{ l.name }}</b><span v-if="l.address" class="sub"> · {{ l.address }}</span></span>
            <span class="sub">{{ l.people.length }} {{ t('org.people') }} {{ open[l.id] ? '▾' : '▸' }}</span>
          </button>
          <p v-if="l.manager" class="sub">{{ t('org.manager') }}: {{ l.manager }}</p>
          <ul v-if="open[l.id]" class="people"><li v-for="p in l.people" :key="p.id"><b>{{ p.fullName }}</b> <span class="sub">{{ p.position }}</span></li></ul>
        </div>
        <section v-for="c in u.children" :key="c.id" class="unit nested">
          <h3>{{ c.name }}</h3>
          <div v-for="l in c.locations" :key="l.id" class="card">
            <button class="loc" @click="open[l.id] = !open[l.id]"><span><b>{{ l.name }}</b></span><span class="sub">{{ l.people.length }} {{ t('org.people') }} {{ open[l.id] ? '▾' : '▸' }}</span></button>
            <p v-if="l.manager" class="sub">{{ t('org.manager') }}: {{ l.manager }}</p>
            <ul v-if="open[l.id]" class="people"><li v-for="p in l.people" :key="p.id"><b>{{ p.fullName }}</b> <span class="sub">{{ p.position }}</span></li></ul>
          </div>
        </section>
      </section>
    </template>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-1); font-weight: 900; }
h2 { margin: var(--space-3) 0 var(--space-2); font-weight: 800; }
h3 { margin: var(--space-2) 0; font-weight: 800; font-size: var(--font-size-body); }
.nested { padding-left: var(--space-3); border-left: 2px solid var(--color-bg-line); }
.card { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-3); display: grid; gap: var(--space-1); margin-bottom: var(--space-2); }
.loc { font: inherit; background: none; border: none; padding: 0; display: flex; justify-content: space-between; gap: var(--space-2); text-align: left; cursor: pointer; color: inherit; }
.people { list-style: none; margin: 0; padding: var(--space-2) 0 0; display: grid; gap: 4px; border-top: 1px solid var(--color-bg-line-soft); }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.error { background: var(--color-coral); color: var(--color-coral-deep); padding: var(--space-3); border-radius: var(--radius-m); }
</style>

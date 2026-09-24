<script setup lang="ts">
/** Мої оголошення: назначенные человеку с отметкой «Ознайомився» (docs/21 §14.5). */
const { formatShortDate } = useFormat()
definePageMeta({ layout: 'learner' })
const { t } = useI18n()
const { api } = useApi()
interface N { id: string, title: string, kind: string, priority: string, publishedAt: string | null, endsAt: string | null, dueAt: string | null, ackedAt: string | null, phase: string }
const items = ref<N[]>([])
const simple = ref<{ id: string, title: string, body: unknown[], endsAt: string | null }[]>([])
const error = ref('')
const d = (s: string | null) => s ? formatShortDate(new Date(s)) : ''
onMounted(async () => {
  try { items.value = await api<N[]>('/notices/mine'); simple.value = await api('/simple-notices') } catch (err) { error.value = apiErrorOf(err).message }
})
</script>
<template>
  <div>
    <h1>{{ t('notices.title') }}</h1>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>
    <ul class="list">
      <li v-for="n in items" :key="n.id">
        <NuxtLink :to="`/learn/notices/${n.id}`" class="card item">
          <span class="chips"><span class="badge sun">{{ t(`notices.kind.${n.kind}`) }}</span><span v-if="n.priority === 'critical'" class="badge coral">{{ t('news.prio.critical') }}</span><span :class="['badge', n.ackedAt ? 'teal' : 'muted']">{{ n.ackedAt ? t('notices.ackedOn', { d: d(n.ackedAt) }) : t('notices.notAckedYet') }}</span></span>
          <b>{{ n.title }}</b>
          <span class="muted">{{ n.publishedAt ? t('notices.publishedOn', { d: d(n.publishedAt) }) : '' }}<template v-if="n.dueAt && !n.ackedAt"> · {{ t('notices.ackUntil', { d: d(n.dueAt) }) }}</template></span>
        </NuxtLink>
      </li>
      <li v-if="!items.length && !simple.length" class="faint empty">{{ t('notices.emptyMine') }}</li>
    </ul>
    <template v-if="simple.length">
      <h2>{{ t('notices.simple.title') }}</h2>
      <ul class="list">
        <li v-for="s in simple" :key="s.id" class="card item plain">
          <b>{{ s.title }}</b>
          <LessonBlocks :blocks="s.body as never" :blocks-state="{}" readonly />
          <span v-if="s.endsAt" class="muted">{{ t('notices.simple.untilDate', { d: d(s.endsAt) }) }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>
<style scoped>
h1 { margin: 0 0 var(--space-3); font-weight: 900; }
h2 { margin: var(--space-4) 0 var(--space-2); font-weight: 800; font-size: var(--font-size-body); }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.item { display: grid; gap: var(--space-1); text-decoration: none; color: var(--color-ink); }
.item .muted { font-size: var(--font-size-body-s); }
.empty { text-align: center; padding: var(--space-6); }
</style>

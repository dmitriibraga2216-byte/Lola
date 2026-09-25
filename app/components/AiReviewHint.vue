<script setup lang="ts">
/**
 * «Підказка ШІ» в картці перевірки (docs/v2/30-ai-interview.md §5.5, §7.13, §13 к. 11).
 *
 * Згорнута панель з позначкою «Це не оцінка»; розкривається кліком — лише тоді сервер ставить
 * `shown_at`, і рішення наставника звіряється з підказкою (не розкрив — `not_shown`, контрольна
 * група). Усередині три списки: «Збіглося з ключем» (бірюза, з цитатами), «Не згадано» (сірі),
 * «Суперечить ключу» (корал, з цитатою і поясненням), внизу «Покриття ключа: 4 з 6».
 *
 * **Підказка — не відповідь** (інваріант 18): компонент нічого не повертає батьку — ні балу, ні
 * «зараховано», ні значень критеріїв; форма наставника його не читає і лишається порожньою.
 */
const props = defineProps<{ targetKind: 'attempt_answer' | 'workshop_submission', targetId: string }>()

const { t } = useI18n()
const { api } = useApi()

interface Hint {
  state: string
  matched: { keyPoint: string, quote: string }[]
  missing: { keyPoint: string }[]
  contradictions: { keyPoint: string, quote: string, why: string }[]
  coverage: { matched: number, total: number } | null
  aiStub: boolean
  reason: string | null
}

const open = ref(false)
const loading = ref(false)
const hint = ref<Hint | null>(null)
const absent = ref(false)

async function toggle() {
  open.value = !open.value
  if (!open.value || hint.value || absent.value) return
  loading.value = true
  try {
    hint.value = await api<Hint>(`/review-hints/${props.targetKind}/${props.targetId}`)
    if (hint.value.state !== 'ready') absent.value = true
  }
  catch {
    // 404 hint.absent, 409 hint.degraded, 403 — одна фраза без техніки: перевірте самостійно (§5.5)
    absent.value = true
  }
  finally {
    loading.value = false
  }
}
</script>

<template>
  <aside class="ai-hint">
    <button class="head" type="button" :aria-expanded="open" @click="toggle">
      <span class="title">{{ t('reviewHint.title') }}</span>
      <span class="badge muted">{{ t('reviewHint.notScore') }}</span>
      <span class="toggle">{{ open ? t('reviewHint.hide') : t('reviewHint.open') }}</span>
    </button>
    <div v-if="open" class="body">
      <p v-if="loading" class="sub" role="status">{{ t('reviewHint.loading') }}</p>
      <template v-else-if="hint && !absent">
        <p class="sub">{{ t('reviewHint.decide') }}</p>
        <p v-if="hint.aiStub" class="note coral">{{ t('reviewHint.stub') }}</p>
        <section v-if="hint.matched.length">
          <h4>{{ t('reviewHint.matched') }}</h4>
          <ul class="list teal">
            <li v-for="(m, i) in hint.matched" :key="`m${i}`">{{ m.keyPoint }} <span class="quote">«{{ m.quote }}»</span></li>
          </ul>
        </section>
        <section v-if="hint.missing.length">
          <h4>{{ t('reviewHint.missing') }}</h4>
          <ul class="list muted">
            <li v-for="(m, i) in hint.missing" :key="`n${i}`">{{ m.keyPoint }}</li>
          </ul>
        </section>
        <section v-if="hint.contradictions.length">
          <h4>{{ t('reviewHint.contradictions') }}</h4>
          <ul class="list coral">
            <li v-for="(c, i) in hint.contradictions" :key="`c${i}`">{{ c.keyPoint }} <span class="quote">«{{ c.quote }}»</span> <span class="sub">{{ c.why }}</span></li>
          </ul>
        </section>
        <p v-if="hint.coverage" class="coverage">{{ t('reviewHint.coverage', { matched: hint.coverage.matched, total: hint.coverage.total }) }}</p>
      </template>
      <template v-else>
        <p class="sub">{{ t('reviewHint.absent') }}</p>
        <p v-if="hint?.reason" class="sub">{{ t('reviewHint.reason', { reason: hint.reason }) }}</p>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.ai-hint { border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); background: var(--color-bg); }
.head { font: inherit; display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; width: 100%; background: transparent; border: 0; padding: var(--space-2) var(--space-3); cursor: pointer; text-align: left; color: var(--color-ink); min-height: 44px; }
.title { font-weight: 800; }
.toggle { margin-left: auto; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.body { display: grid; gap: var(--space-2); padding: 0 var(--space-3) var(--space-3); }
h4 { margin: 0 0 var(--space-1); font-size: var(--font-size-body-s); font-weight: 900; }
.list { margin: 0; padding-left: var(--space-4); display: grid; gap: var(--space-1); }
.list.teal li::marker { color: var(--color-teal); }
.list.coral li::marker { color: var(--color-coral); }
.list.muted { color: var(--color-ink-muted); }
.quote { font-style: italic; }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.coverage { margin: 0; font-weight: 700; }
</style>

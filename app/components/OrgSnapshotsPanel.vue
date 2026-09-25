<script setup lang="ts">
/**
 * «Знімки» и откат к снимку (docs/v2/32 §3.3, §7 п. 7, §10, критерий приёмки 7; PR-31).
 *
 * Список — новые сверху, «Показати ще» по ключевому курсору. «Відкотити» спрашивает
 * подтверждение: откат возвращает дерево **и назначения людей** на момент снимка, уволенных
 * после снимка не возвращает, а текущее состояние сохраняет отдельным снимком — поэтому откат
 * тоже можно откатить. Считает всё сервер; экран показывает итог его же словами.
 */
import type { OrgSnapshotKind } from '#shared/enums'

interface Snapshot { id: string, label: string, kind: OrgSnapshotKind, nodeCount: number, createdAt: string, createdByName: string | null }
interface RollbackResult { nodes: number, archived: number, assignmentsCreated: number, assignmentsEnded: number, dismissedSkipped: number }

const emit = defineEmits<{ close: [], changed: [message: string] }>()

const { t } = useI18n()
const { api } = useApi()
const { formatDateTime } = useFormat()

const rows = ref<Snapshot[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const confirming = ref<Snapshot | null>(null)
const dialog = ref<HTMLElement | null>(null)

async function load(more = false) {
  loading.value = true
  error.value = ''
  try {
    const page = await api<{ rows: Snapshot[], cursor: string | null }>('/org-structure/snapshots', { query: { limit: 20, ...(more && cursor.value ? { cursor: cursor.value } : {}) } })
    rows.value = more ? [...rows.value, ...page.rows] : page.rows
    cursor.value = page.cursor
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { loading.value = false }
}

onMounted(async () => {
  await load()
  dialog.value?.querySelector<HTMLElement>('button')?.focus()
})

function messageOf(err: unknown): string {
  const e = apiErrorOf(err)
  const key = `orgStructure.err.${e.code}`
  return t(key) === key ? e.message : t(key)
}

async function rollback() {
  const s = confirming.value
  if (!s) return
  busy.value = true
  error.value = ''
  try {
    const r = await api<RollbackResult>(`/org-structure/snapshots/${s.id}/rollback`, { method: 'POST' })
    const parts = [t('orgStructure.rollbackDone', { nodes: r.nodes, created: r.assignmentsCreated, ended: r.assignmentsEnded })]
    if (r.dismissedSkipped) parts.push(t('orgStructure.rollbackDismissed', { n: r.dismissedSkipped }))
    notice.value = parts.join(' ')
    confirming.value = null
    emit('changed', notice.value)
    await load()
  }
  catch (err) { error.value = messageOf(err) }
  finally { busy.value = false }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')" @keydown.esc="emit('close')">
    <section ref="dialog" class="modal" role="dialog" aria-modal="true" aria-labelledby="snapshots-title">
      <h2 id="snapshots-title">{{ t('orgStructure.snapshotsTitle') }}</h2>
      <p class="sub">{{ t('orgStructure.snapshotsHint') }}</p>

      <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
      <p v-if="error" class="error-text" role="alert">{{ error }}</p>

      <div v-if="confirming" class="note sun confirm" role="alertdialog" aria-labelledby="rollback-title">
        <h3 id="rollback-title">{{ t('orgStructure.rollbackTitle') }}</h3>
        <p>{{ t('orgStructure.rollbackConfirm', { label: confirming.label, date: formatDateTime(confirming.createdAt) }) }}</p>
        <p class="sub">{{ t('orgStructure.rollbackDismissedNote') }}</p>
        <div class="actions">
          <button type="button" class="btn danger" :disabled="busy" @click="rollback">{{ t('orgStructure.rollback') }}</button>
          <button type="button" class="btn ghost" :disabled="busy" @click="confirming = null">{{ t('orgStructure.cancel') }}</button>
        </div>
      </div>

      <p v-if="!loading && !rows.length" class="sub">{{ t('orgStructure.snapshotsEmpty') }}</p>
      <ul v-else class="list">
        <li v-for="s in rows" :key="s.id" class="row">
          <span class="main">
            <b class="label">{{ s.label }}</b>
            <span class="meta">
              <span class="badge">{{ t(`orgStructure.snapshotKind.${s.kind}`) }}</span>
              <span>{{ t('orgStructure.snapshotCol.date') }}: {{ formatDateTime(s.createdAt) }}</span>
              <span>{{ t('orgStructure.snapshotCol.nodes') }}: {{ s.nodeCount }}</span>
              <span v-if="s.createdByName">{{ t('orgStructure.snapshotCol.author') }}: {{ s.createdByName }}</span>
            </span>
          </span>
          <button type="button" class="btn ghost small" :disabled="busy" @click="confirming = s">{{ t('orgStructure.rollback') }}</button>
        </li>
      </ul>

      <div class="actions">
        <button v-if="cursor" type="button" class="btn ghost" :disabled="loading" @click="load(true)">{{ t('common.loadMore') }}</button>
        <button type="button" class="btn ghost" @click="emit('close')">{{ t('orgStructure.close') }}</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--color-ink) 45%, transparent); display: grid; place-items: center; padding: var(--space-3); z-index: 30; overflow: auto; }
.modal { background: var(--color-bg-soft); border-radius: var(--radius-l); padding: var(--space-4); display: grid; gap: var(--space-3); width: min(640px, 100%); box-sizing: border-box; max-height: calc(100vh - 2 * var(--space-3)); overflow: auto; }
.modal h2 { margin: 0; font-weight: 900; }
.modal h3 { margin: 0 0 var(--space-2); font-size: var(--font-size-body); font-weight: 800; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); margin: 0; }
.confirm p { margin: 0 0 var(--space-2); overflow-wrap: anywhere; }
.list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.row { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; background: var(--color-bg); border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); }
.main { display: grid; gap: var(--space-1); flex: 1 1 200px; min-width: 0; }
.label { overflow-wrap: anywhere; }
.meta { display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
</style>

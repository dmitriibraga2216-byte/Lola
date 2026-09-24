<script setup lang="ts">
/**
 * «Кошик» (docs/v2/34-storage.md §5.2): те же колонки, что у реестра, плюс «Видалено» (дата и
 * кто) и «Буде очищено» (обратный отсчёт до `purge_after`). «Відновити» — в один клик, сверх
 * лимита тоже (§12). Срок корзины — из политики хранения (`44` §8), не константа экрана.
 *
 * «Очистити зараз» документа здесь нет: до ответа владельца продукта об удалении объектов
 * (`44` §8) досрочная очистка значила бы только «лишить права восстановить» — места она не
 * освобождает, квота свободна с момента удаления.
 */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'storage.view' })

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatBytes, formatShortDate, formatDateTime } = useFormat()

interface TrashRow {
  id: string, originalName: string, kind: string, mime: string, bytes: number, origin: string, isEvidence: boolean
  ownerUserId: string | null, ownerName: string | null, courseTitle: string | null, createdAt: string
  deletedAt: string | null, deletedByName: string | null, deleteReason: string | null, purgeAfter: string | null
}

const rows = ref<TrashRow[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(true)
const loadError = ref(false)
const busy = ref<string | null>(null)
const notice = ref('')
const error = ref('')
const trashDays = ref(30)

async function load(reset = true) {
  loadError.value = false
  if (reset) loading.value = true
  try {
    const page = await api<{ items: TrashRow[], nextCursor: string | null }>('/storage/trash', { query: !reset && nextCursor.value ? { cursor: nextCursor.value } : {} })
    rows.value = reset ? page.items : [...rows.value, ...page.items]
    nextCursor.value = page.nextCursor
  }
  catch { loadError.value = true }
  finally { loading.value = false }
}
onMounted(async () => {
  load()
  try { trashDays.value = (await api<{ trashDays: number }>('/storage/summary')).trashDays } catch { /* подпись по умолчанию */ }
})

async function restore(r: TrashRow) {
  busy.value = r.id
  error.value = ''
  notice.value = ''
  try {
    await api(`/storage/files/${r.id}/restore`, { method: 'POST' })
    rows.value = rows.value.filter(x => x.id !== r.id)
    notice.value = t('storage.trash.restored')
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = null }
}

/** «Буде очищено»: сколько дней осталось до перевода в `purged` задачей `storage.purge`. */
function purgeIn(r: TrashRow): string {
  if (!r.purgeAfter) return '—'
  const days = Math.ceil((new Date(r.purgeAfter).getTime() - Date.now()) / 86_400_000)
  return days <= 0 ? t('storage.trash.purgeToday') : t('storage.trash.purgeIn', { n: days })
}
const fileLabel = (r: TrashRow) => r.originalName || `${r.kind}.${r.mime.split('/')[1] ?? ''}`
</script>

<template>
  <div>
    <PageHeader :title="t('storage.tabs.trash')" :crumbs="[{ label: t('admin.section.settings') }, { label: t('storage.title'), to: '/admin/settings/storage' }, { label: t('storage.tabs.trash') }]" />
    <StorageTabs />

    <p v-if="notice" class="note teal" role="status">{{ notice }}</p>
    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div v-if="loading" class="skeletons" aria-busy="true">
      <div v-for="i in 8" :key="i" class="skeleton" />
    </div>
    <template v-else-if="loadError">
      <p class="error-text" role="alert">{{ t('storage.loadError') }}</p>
      <button type="button" class="btn ghost" @click="load()">{{ t('storage.retry') }}</button>
    </template>
    <p v-else-if="!rows.length" class="help empty">{{ t('storage.trash.empty', { days: trashDays }) }}</p>
    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th scope="col">{{ t('storage.col.file') }}</th>
            <th scope="col">{{ t('storage.col.origin') }}</th>
            <th scope="col">{{ t('storage.col.owner') }}</th>
            <th scope="col" class="num">{{ t('storage.col.size') }}</th>
            <th scope="col">{{ t('storage.col.deleted') }}</th>
            <th scope="col">{{ t('storage.col.purge') }}</th>
            <th scope="col"><span class="sr-only">{{ t('storage.col.actions') }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="file-cell">
              <span class="file-name">{{ fileLabel(r) }}</span>
              <span v-if="r.isEvidence" class="badge sun">{{ t('storage.evidence') }}</span>
              <span v-if="r.deleteReason" class="sub">{{ t('storage.trash.reason', { reason: r.deleteReason }) }}</span>
            </td>
            <td>{{ t(`storage.origin.${r.origin}`) }}</td>
            <td>{{ r.ownerName ?? (r.ownerUserId ? '—' : t('storage.ownerDeleted')) }}</td>
            <td class="num nowrap">{{ formatBytes(r.bytes) }}</td>
            <td class="nowrap">
              <time v-if="r.deletedAt" :datetime="r.deletedAt" :title="formatDateTime(r.deletedAt)">{{ formatShortDate(r.deletedAt) }}</time>
              <span class="sub">{{ r.deletedByName ?? '—' }}</span>
            </td>
            <td class="nowrap">{{ purgeIn(r) }}</td>
            <td>
              <button v-if="hasScope('storage.delete')" type="button" class="btn ghost small" :disabled="busy === r.id" @click="restore(r)">{{ t('storage.trash.restore') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <button v-if="nextCursor && !loading" type="button" class="btn ghost" @click="load(false)">{{ t('common.loadMore') }}</button>
  </div>
</template>

<style scoped>
.file-cell { max-width: 280px; }
.file-name { display: block; font-weight: 700; overflow-wrap: anywhere; }
.file-cell .badge { margin-top: var(--space-1); }
.nowrap { white-space: nowrap; }
.empty { margin: var(--space-4) 0; }
.skeletons { display: grid; gap: var(--space-2); }
.skeleton { height: 44px; border-radius: var(--radius-s); background: var(--color-bg-line-soft); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>

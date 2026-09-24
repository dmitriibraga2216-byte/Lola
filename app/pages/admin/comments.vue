<script setup lang="ts">
/** Єдина стрічка коментарів (мокап Comments, докс/10 §14.2): джерело · автор · дата · коментар · стан. */
definePageMeta({ layout: 'admin', middleware: 'admin-scope', requiredScope: 'course.view' })

const { t } = useI18n()
const { formatShortDate } = useFormat()
const { api } = useApi()

type SourceType = 'task' | 'course' | 'program' | 'knowledge' | 'notice'
interface Row {
  id: string
  body: string
  sourceType: SourceType
  sourceId: string
  sourceTitle: string | null
  isRead: boolean
  authorId: string
  authorName: string
  createdAt: string
  replyToId: string | null
}

const SOURCE_FILTERS = ['all', 'task', 'course', 'program', 'knowledge', 'notice'] as const
const sourceFilter = ref<typeof SOURCE_FILTERS[number]>('all')
const readFilter = ref<'all' | 'read' | 'unread'>('all')
const rows = ref<Row[]>([])
const error = ref('')
const busy = ref('')
const replyOpen = ref('')
const replyText = ref<Record<string, string>>({})

async function load() {
  error.value = ''
  try {
    rows.value = await api<Row[]>('/comments', {
      query: {
        sourceType: sourceFilter.value === 'all' ? undefined : sourceFilter.value,
        isRead: readFilter.value === 'all' ? undefined : readFilter.value,
      },
    })
  }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)
watch([sourceFilter, readFilter], load)

const fmtDate = (iso: string) => formatShortDate(new Date(iso))

async function markRead(r: Row) {
  if (r.isRead) return
  busy.value = r.id
  try { await api(`/comments/${r.id}/read`, { method: 'POST' }); r.isRead = true }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}

function toggleReply(r: Row) {
  replyOpen.value = replyOpen.value === r.id ? '' : r.id
}

async function sendReply(r: Row) {
  const body = (replyText.value[r.id] ?? '').trim()
  if (!body) return
  busy.value = r.id
  error.value = ''
  try {
    await api(`/comments/${r.id}/reply`, { method: 'POST', body: { body } })
    replyText.value[r.id] = ''
    replyOpen.value = ''
    r.isRead = true
    await load()
  }
  catch (err) { error.value = apiErrorOf(err).message }
  finally { busy.value = '' }
}
</script>

<template>
  <div>
    <PageHeader :title="t('comments.title')" :crumbs="[{ label: t('admin.section.learning') }, { label: t('comments.title') }]" :subtitle="t('comments.hint')" />

    <div class="filters">
      <select v-model="sourceFilter" class="field" :aria-label="t('comments.filterSource')">
        <option v-for="s in SOURCE_FILTERS" :key="s" :value="s">{{ t(`comments.source.${s}`) }}</option>
      </select>
      <select v-model="readFilter" class="field" :aria-label="t('comments.filterState')">
        <option value="all">{{ t('comments.stateAll') }}</option>
        <option value="unread">{{ t('comments.stateUnread') }}</option>
        <option value="read">{{ t('comments.stateRead') }}</option>
      </select>
    </div>

    <p v-if="error" class="error-text" role="alert">{{ error }}</p>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>{{ t('comments.colSource') }}</th>
            <th>{{ t('comments.colAuthor') }}</th>
            <th>{{ t('comments.colDate') }}</th>
            <th>{{ t('comments.colBody') }}</th>
            <th>{{ t('comments.colState') }}</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="r in rows" :key="r.id">
            <tr>
              <td>
                <b>{{ t(`comments.source.${r.sourceType}`) }}<template v-if="r.sourceTitle">: {{ r.sourceTitle }}</template></b>
              </td>
              <td>{{ r.authorName }}</td>
              <td>{{ fmtDate(r.createdAt) }}</td>
              <td>
                {{ r.body }}
                <div><button class="chip" type="button" @click="toggleReply(r)">{{ t('comments.reply') }}</button></div>
              </td>
              <td>
                <button type="button" class="btn ghost small" :disabled="busy === r.id || r.isRead" @click="markRead(r)">
                  <span :class="['badge', r.isRead ? 'muted' : 'coral']">{{ r.isRead ? t('comments.stateRead') : t('comments.stateUnread') }}</span>
                </button>
              </td>
            </tr>
            <tr v-if="replyOpen === r.id">
              <td colspan="5">
                <div class="reply">
                  <textarea v-model="replyText[r.id]" class="field" rows="2" maxlength="2000" :placeholder="t('comments.replyPh')" />
                  <button class="btn primary small" :disabled="busy === r.id" @click="sendReply(r)">{{ t('comments.replySend') }}</button>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="rows.length === 0">
            <td colspan="5" class="muted">{{ t('comments.empty') }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.filters { display: flex; gap: var(--space-2); margin-bottom: var(--space-4); flex-wrap: wrap; }
.reply { display: flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-2) 0; }
.reply .field { flex: 1; }
</style>

<script setup lang="ts">
import { CONTENT_ISSUE_COMMENT_REQUIRED, CONTENT_ISSUE_TYPES } from '#shared/enums'
import type { ContentIssueTargetType, ContentIssueType, ContentReportSource } from '#shared/enums'

/**
 * «Повідомити про помилку» (docs/v2/36 §5.1, §5.2, §6.1): флажок и модалка из двух полей.
 *
 * Правило модуля — **минимум трения**: два тапа, ноль обязательных полей у семи типов
 * из одиннадцати, не выходя из урока. Поэтому компонент ничего не спрашивает о контексте:
 * урок, версию, попытку и позицию плеера собирает система (§7.1), а человеку показывает
 * одной серой строкой «Ми вже бачимо, де ти зараз».
 *
 * Жалоба не прерывает того, что человек делал: модалка не перезагружает урок, не трогает
 * таймер попытки и после отправки возвращает ровно туда, где он был (§5.2, §7.7).
 * Время, проведённое в форме, засекается здесь и уходит на сервер — он вернёт его сдвигом
 * дедлайна попытки сам, в своих пределах (§7.7 б).
 *
 * Пока форма открыта, счётчик времени экрана стоит (`useLearningTime`, docs/v2/37 §7.10,
 * решение PR-21 Р-21.9): время в форме — не «Час на випробування» и не «Час на контент».
 * Сигнал общий на страницу (`issue:formOpen`), потому что флажки живут и в шапке плеера, и в
 * блоках материала, и в строке вопроса — пробрасывать события через все обёртки незачем.
 */
const props = defineProps<{
  targetType: ContentIssueTargetType
  targetId: string
  /** Блок внутри материала — точечный флажок у абзаца, видео, файла (§5.1). */
  blockId?: string | null
  source: ContentReportSource
  /** Строка-подтверждение «Ми вже бачимо, де ти зараз»: урок, версия, питання. */
  whereLabel?: string
  enrollmentId?: string | null
  lessonId?: string | null
  attemptId?: string | null
  /** Позиция плеера и прокрутка на момент открытия формы — их знает только экран. */
  collect?: () => { scrollPct?: number, playerPositionSec?: number }
  /** Компактный флажок у блока/вопроса вместо кнопки с подписью. */
  compact?: boolean
}>()

const { t } = useI18n()
const { api } = useApi()
const { upload, compressImage } = useMediaUpload()

const open = ref(false)
const issueType = ref<ContentIssueType | null>(null)
const comment = ref('')
const screenshotMediaId = ref<string | null>(null)
const screenshotName = ref('')
const busy = ref(false)
const error = ref('')
const sent = ref(false)
const openedAt = ref(0)
const formsOpen = useState<number>('issue:formOpen', () => 0)
watch(open, (now, before) => {
  if (now && !before) formsOpen.value += 1
  else if (!now && before) formsOpen.value = Math.max(0, formsOpen.value - 1)
})
onUnmounted(() => {
  if (open.value) formsOpen.value = Math.max(0, formsOpen.value - 1)
})

const commentRequired = computed(() => !!issueType.value && CONTENT_ISSUE_COMMENT_REQUIRED.includes(issueType.value))
const canSend = computed(() => !!issueType.value && !busy.value
  && (!commentRequired.value || comment.value.trim().length >= 10))

function start() {
  issueType.value = null
  comment.value = ''
  screenshotMediaId.value = null
  screenshotName.value = ''
  error.value = ''
  sent.value = false
  openedAt.value = Date.now()
  open.value = true
}

function close() {
  open.value = false
}

async function pickScreenshot(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  error.value = ''
  if (file.size > 5 * 1024 * 1024) { error.value = t('issue.errScreenshotSize'); return }
  busy.value = true
  try {
    const blob = await compressImage(file)
    screenshotMediaId.value = await upload(blob, file.name, 'issue_screenshot', { sourceEntity: 'content_report' })
    screenshotName.value = file.name
  }
  catch { error.value = t('issue.errScreenshot') }
  finally { busy.value = false }
}

async function send() {
  if (!canSend.value) return
  busy.value = true
  error.value = ''
  const extra = props.collect?.() ?? {}
  try {
    await api('/content-issues/reports', {
      method: 'POST',
      body: {
        targetType: props.targetType,
        targetId: props.targetId,
        blockId: props.blockId ?? null,
        issueType: issueType.value,
        comment: comment.value.trim() ? comment.value.trim() : null,
        screenshotMediaId: screenshotMediaId.value,
        source: props.source,
        enrollmentId: props.enrollmentId ?? null,
        lessonId: props.lessonId ?? null,
        attemptId: props.attemptId ?? null,
        context: {
          ...extra,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          device: window.innerWidth < 768 ? 'mobile' : 'desktop',
          locale: navigator.language,
          url: location.pathname,
          clientTs: new Date().toISOString(),
          // Секунды в форме: сервер обрежет своими пределами, завысить их отсюда нельзя
          formSeconds: Math.max(0, Math.round((Date.now() - openedAt.value) / 1000)),
        },
      },
    })
    sent.value = true
    setTimeout(() => { open.value = false }, 1600)
  }
  catch (err) {
    const e = apiErrorOf(err)
    // Отказ объясняет, что делать (§6.1): молча форма не закрывается никогда
    if (e.code === 'content_issue.rate_limited') error.value = t('issue.errRateLimited', { n: (e.details?.limit as number) ?? 5 })
    else if (e.code === 'content_issue.reporter_muted') error.value = t('issue.errMuted')
    else if (e.code === 'content_issue.already_reported') error.value = t('issue.errAlready')
    else error.value = e.message
  }
  finally { busy.value = false }
}
</script>

<template>
  <span class="issue-report">
    <button
      type="button"
      :class="['flag', { compact }]"
      :aria-label="t('issue.report')"
      :title="t('issue.report')"
      @click.stop="start"
    >
      <span aria-hidden="true">⚑</span>
      <span v-if="!compact" class="label">{{ t('issue.report') }}</span>
    </button>

    <div
      v-if="open"
      class="modal-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-label="t('issue.title')"
      @click.self="close"
      @keydown.esc="close"
    >
      <div class="modal">
        <template v-if="sent">
          <h2 class="head">{{ t('issue.sentTitle') }}</h2>
          <p class="sub">{{ t('issue.sentHint') }}</p>
        </template>
        <template v-else>
          <h2 class="head">{{ t('issue.title') }}</h2>
          <fieldset class="types">
            <legend class="sr-only">{{ t('issue.typeLegend') }}</legend>
            <button
              v-for="k in CONTENT_ISSUE_TYPES"
              :key="k"
              type="button"
              :class="['type', { on: issueType === k }]"
              :aria-pressed="issueType === k"
              @click="issueType = k"
            >
              {{ t(`issue.type.${k}`) }}
            </button>
          </fieldset>

          <label class="label" for="issue-comment">{{ t('issue.comment') }}<span v-if="commentRequired"> *</span></label>
          <textarea
            id="issue-comment"
            v-model="comment"
            class="field"
            rows="3"
            maxlength="1000"
            :placeholder="t('issue.commentPh')"
          />

          <label class="ghost attach">
            {{ screenshotName || t('issue.screenshot') }}
            <input type="file" accept="image/jpeg,image/png,image/webp" hidden :disabled="busy" @change="pickScreenshot">
          </label>

          <p v-if="whereLabel" class="where">{{ t('issue.where', { where: whereLabel }) }}</p>
          <p v-if="error" class="error" role="alert">{{ error }}</p>

          <div class="actions">
            <button type="button" class="btn ghost" :disabled="busy" @click="close">{{ t('common.cancel') }}</button>
            <button type="button" class="btn primary" :disabled="!canSend" @click="send">{{ t('issue.send') }}</button>
          </div>
        </template>
      </div>
    </div>
  </span>
</template>

<style scoped>
.issue-report { display: inline-flex; }
.flag { font: inherit; font-weight: 800; display: inline-flex; align-items: center; gap: var(--space-2); background: var(--color-bg-soft); color: var(--color-ink-muted); border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-1) var(--space-3); cursor: pointer; }
.flag:hover { border-color: var(--color-ink); color: var(--color-ink); }
.flag.compact { padding: var(--space-1) var(--space-2); background: transparent; border-color: transparent; }
.flag:focus-visible { outline: 2px solid var(--color-sun); outline-offset: 2px; }
.label { font-size: var(--font-size-body-s); }
.modal-backdrop { position: fixed; inset: 0; background: rgba(12, 15, 20, 0.5); display: flex; align-items: flex-end; justify-content: center; padding: var(--space-3); z-index: 60; }
.modal { background: var(--color-bg); border-radius: var(--radius-l); padding: var(--space-4); max-width: 420px; width: 100%; max-height: 90dvh; overflow-y: auto; display: grid; gap: var(--space-2); }
.head { margin: 0; font-size: var(--font-size-title-l); font-weight: 900; }
.sub { margin: 0; color: var(--color-ink-muted); }
.types { display: flex; flex-wrap: wrap; gap: var(--space-2); border: none; padding: 0; margin: 0 0 var(--space-2); }
.type { font: inherit; font-weight: 700; font-size: var(--font-size-body-s); text-align: left; background: var(--color-bg-soft); color: var(--color-ink); border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-3); cursor: pointer; }
.type.on { background: var(--color-sun); color: var(--color-sun-ink); border-color: var(--color-sun); }
.type:focus-visible { outline: 2px solid var(--color-ink); outline-offset: 2px; }
.label { font-weight: 800; font-size: var(--font-size-body-s); }
.field { font: inherit; width: 100%; box-sizing: border-box; background: var(--color-bg-soft); border: 1px solid var(--color-bg-line); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); color: var(--color-ink); }
.attach { font-weight: 800; font-size: var(--font-size-body-s); background: var(--color-bg-soft); color: var(--color-ink); border: 1px solid var(--color-bg-line); border-radius: var(--radius-pill); padding: var(--space-2) var(--space-4); cursor: pointer; text-align: center; overflow: hidden; text-overflow: ellipsis; }
.where { margin: 0; font-size: var(--font-size-body-s); color: var(--color-ink-faint); }
.error { margin: 0; color: var(--color-coral-ink); font-weight: 700; }
.actions { display: flex; gap: var(--space-2); justify-content: flex-end; flex-wrap: wrap; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (min-width: 560px) { .modal-backdrop { align-items: center; } }
</style>

<script setup lang="ts">
/**
 * Вкладка «Співбесіда» картки кандидата (docs/v2/30-ai-interview.md §5.3, §7.2, §7.8, §7.17).
 *
 * Поруч з оцінкою ШІ — завжди чотири речі (§7.2): обґрунтування, цитати з переходом до репліки,
 * впевненість словом і техпаспорт (модель, версія промпту, дата). П'ята — пометка заглушки
 * (Р-28.4): оцінку профілю-заглушки не можна брати за підставу рішення, і екран каже це прямо.
 * Плашка «Це оцінка програми. Рішення ухвалює людина.» — завжди, коли оцінка є.
 *
 * Аудіо — лише з `interview.listen`: посилання на 15 хвилин, кожне прослуховування — рядок
 * журналу; кнопки «завантажити» немає ні в кого. Видалене аудіо — дата видалення, цитата і
 * розшифровка лишаються на місці (§12 п. 10).
 */
const props = defineProps<{ candidateId: string }>()

const { t } = useI18n()
const { api } = useApi()
const { hasScope } = useAuth()
const { formatDate, formatDateTime } = useFormat()

interface Evidence { turnId: string, ordinal: number, quote: string }
interface Criterion { criterionId: string, name: string, description: string, scaleMax: number, value: number | null, confidenceWord: 'high' | 'medium' | 'low' | null, rationale: string | null, evidence: Evidence[], redacted: boolean }
interface Turn { id: string, ordinal: number, promptText: string | null, answerMode: string | null, durationMs: number | null, transcript: string | null, transcriptStatus: string, audio: 'available' | 'deleted' | 'none', audioDeletedAt: string | null }
interface Session {
  id: string
  scenarioName: string
  scenarioVersion: number
  state: string
  degradedReason: string | null
  needsHumanReason: string | null
  aiScore: number | null
  confidenceWord: 'high' | 'medium' | 'low' | null
  aiStub: boolean
  model: { name: string, version: string | null, promptVersion: string, at: string } | null
  finishedAt: string | null
  redactedAt: string | null
  metrics: { turnsTotal: number, turnsAnswered: number, disconnects: number, resumes: number, silenceEvents: number, tabSwitches: number, ipChanges: number, retakes: number }
  flags: { code: string, ordinal: number | null }[]
  criteria: Criterion[]
  turns: Turn[]
}
interface Data { sessions: Session[], declined: { scenarioName: string, alternative: string | null, decidedAt: string }[] }

const data = ref<Data | null>(null)
const error = ref('')
const audio = ref<Record<string, string>>({})
const audioError = ref<Record<string, string>>({})
const highlight = ref('')

async function load() {
  error.value = ''
  try { data.value = await api<Data>(`/candidates/${props.candidateId}/interview`) }
  catch (err) { error.value = apiErrorOf(err).message }
}
onMounted(load)

async function listen(turnId: string) {
  audioError.value = { ...audioError.value, [turnId]: '' }
  try {
    const r = await api<{ url: string }>(`/candidates/${props.candidateId}/interview/media/${turnId}`)
    audio.value = { ...audio.value, [turnId]: r.url }
  }
  catch (err) { audioError.value = { ...audioError.value, [turnId]: apiErrorOf(err).message } }
}

/** Цитата → репліка: прокрутка і підсвітка фрагмента (§5.3). */
function jump(e: Evidence) {
  highlight.value = e.turnId
  const el = document.getElementById(`turn-${e.turnId}`)
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el?.focus()
}

const confidenceText = (w: string | null) => (w ? t(`interview.card.confidenceWord.${w}`) : '—')
</script>

<template>
  <div class="stack">
    <p v-if="error" class="note coral" role="alert">{{ error }}</p>
    <template v-else-if="data">
      <p v-if="!data.sessions.length && !data.declined.length" class="muted">{{ t('interview.card.none') }}</p>

      <p v-for="(d, i) in data.declined" :key="`d${i}`" class="note sun">
        {{ t('interview.history.declined') }}: {{ d.alternative ? t(`interview.history.alternative.${d.alternative}`) : '—' }} · {{ formatDate(d.decidedAt) }}
      </p>

      <article v-for="s in data.sessions" :key="s.id" class="card stack">
        <header class="row between">
          <div>
            <h3 class="h3">{{ s.scenarioName }}</h3>
            <p class="sub">{{ t('interview.card.version', { n: s.scenarioVersion }) }} · {{ t(`interview.card.state.${s.state}`) }}<template v-if="s.finishedAt"> · {{ formatDateTime(s.finishedAt) }}</template></p>
          </div>
          <div v-if="s.aiScore !== null" class="score">
            <b>{{ s.aiScore }}</b><span>/100</span>
          </div>
        </header>

        <template v-if="s.aiScore !== null">
          <p class="note sun">{{ t('interview.card.humanDecides') }}</p>
          <p v-if="s.aiStub" class="note coral" role="note">{{ t('interview.card.stub') }}</p>
          <p class="sub">
            {{ t('interview.card.confidence') }}: {{ confidenceText(s.confidenceWord) }}
            <template v-if="s.model"> · {{ t('interview.card.passport', { model: `${s.model.name}${s.model.version ? ` ${s.model.version}` : ''}`, prompt: s.model.promptVersion, date: formatDateTime(s.model.at) }) }}</template>
          </p>
        </template>
        <p v-else-if="s.state === 'needs_human'" class="note coral">
          {{ t('interview.card.needsHuman') }}<template v-if="s.needsHumanReason">: {{ s.needsHumanReason }}</template>
        </p>
        <p v-if="s.redactedAt" class="note sun">{{ t('interview.card.redacted', { date: formatDate(s.redactedAt) }) }}</p>

        <section v-if="s.criteria.some(c => c.value !== null)" class="stack">
          <h4 class="h4">{{ t('interview.card.criteria') }}</h4>
          <div v-for="c in s.criteria" :key="c.criterionId" class="crit">
            <div class="row between">
              <strong>{{ c.name }}</strong>
              <span v-if="c.value !== null" class="badge teal">{{ c.value }} / {{ c.scaleMax }}</span>
            </div>
            <p class="sub">{{ t('interview.card.confidence') }}: {{ confidenceText(c.confidenceWord) }}</p>
            <p v-if="c.rationale">{{ c.rationale }}</p>
            <p v-else-if="c.redacted" class="sub">{{ t('interview.card.rationaleRedacted') }}</p>
            <div v-if="c.evidence.length" class="quotes">
              <button v-for="(e, i) in c.evidence" :key="i" class="quote" type="button" @click="jump(e)">
                «{{ e.quote }}» <span class="sub">— {{ t('interview.card.turn', { n: e.ordinal }) }}</span>
              </button>
            </div>
          </div>
        </section>

        <section v-if="s.flags.length" class="stack">
          <h4 class="h4">{{ t('interview.card.flagsTitle') }}</h4>
          <ul class="flags">
            <li v-for="(f, i) in s.flags" :key="i">
              {{ t(`interview.card.flag.${f.code}`) }}<template v-if="f.ordinal"> — {{ t('interview.card.turn', { n: f.ordinal }) }}</template>
            </li>
          </ul>
          <p class="sub">{{ t('interview.card.flagsHint') }}</p>
        </section>

        <section class="stack">
          <h4 class="h4">{{ t('interview.card.transcript') }}</h4>
          <ol class="turns">
            <li v-for="tr in s.turns" :id="`turn-${tr.id}`" :key="tr.id" tabindex="-1" :class="{ hl: highlight === tr.id }">
              <p class="sub">{{ t('interview.card.turn', { n: tr.ordinal }) }} · {{ tr.answerMode ? t(`interview.card.mode.${tr.answerMode}`) : t('interview.card.noAnswer') }}<template v-if="tr.durationMs"> · {{ Math.round(tr.durationMs / 1000) }} {{ t('interview.card.sec') }}</template></p>
              <p v-if="tr.promptText" class="q">{{ tr.promptText }}</p>
              <p v-if="tr.transcript">{{ tr.transcript }}</p>
              <p v-else-if="tr.transcriptStatus === 'failed'" class="sub">{{ t('interview.card.transcriptMissing') }}</p>
              <p v-if="tr.transcriptStatus === 'low_confidence'" class="note sun">{{ t('interview.card.unreliable') }}</p>
              <template v-if="tr.audio === 'available' && hasScope('interview.listen')">
                <audio v-if="audio[tr.id]" :src="audio[tr.id]" controls controlslist="nodownload" preload="none" />
                <button v-else class="btn ghost small" type="button" @click="listen(tr.id)">{{ t('interview.card.listen') }}</button>
                <p v-if="audioError[tr.id]" class="error-text">{{ audioError[tr.id] }}</p>
              </template>
              <p v-else-if="tr.audio === 'deleted'" class="sub">{{ t('interview.card.audioDeleted', { date: tr.audioDeletedAt ? formatDate(tr.audioDeletedAt) : '—' }) }}</p>
            </li>
          </ol>
        </section>

        <p class="sub">
          {{ t('interview.card.metrics', { answered: s.metrics.turnsAnswered, total: s.metrics.turnsTotal, disconnects: s.metrics.disconnects, retakes: s.metrics.retakes, silence: s.metrics.silenceEvents }) }}
        </p>
      </article>
    </template>
  </div>
</template>

<style scoped>
.stack { display: grid; gap: var(--space-3); }
.row { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; }
.between { justify-content: space-between; }
.h3 { margin: 0; font-size: var(--font-size-body); font-weight: 900; }
.h4 { margin: 0; font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-ink-muted); }
.sub { margin: 0; color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.score b { font-size: var(--font-size-display); font-weight: 900; }
.score span { color: var(--color-ink-muted); font-weight: 700; }
.crit { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-2); display: grid; gap: var(--space-1); }
.crit p { margin: 0; }
.quotes { display: grid; gap: var(--space-1); }
.quote { font: inherit; text-align: left; border: 1px solid var(--color-teal); background: var(--color-teal-soft); color: var(--color-ink); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); cursor: pointer; }
.flags { margin: 0; padding-left: var(--space-4); }
.turns { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.turns li { border: 1px solid var(--color-bg-line-soft); border-radius: var(--radius-s); padding: var(--space-2) var(--space-3); display: grid; gap: var(--space-1); }
.turns li.hl { border-color: var(--color-teal); background: var(--color-teal-soft); }
.turns p { margin: 0; }
.q { font-weight: 700; }
audio { width: 100%; }
</style>

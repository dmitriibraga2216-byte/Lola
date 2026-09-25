<script setup lang="ts">
/**
 * Тело «Підсумку кандидата» (docs/v2/30-ai-interview.md §5.4, §7.14) — одно для рекрутера (вкладка
 * картки) і для кандидата (сторінка за посиланням). Розділи, яких немає в `doc`, не малюються:
 * рекрутеру приходить документ повністю, кандидату — лише ввімкнені розділи без ПД третіх осіб.
 *
 * Рядок «Документ сформовано автоматично…» — завжди внизу і завжди з тексту документа (`disclaimerLine`),
 * а не з перекладу інтерфейсу: це частина самого документа, і вимкнути її нічим (§13 к. 14).
 */
interface Criterion { name: string, value: number | null, scaleMax: number, humanValue: number | null, rationale: string | null, quote: string | null }
interface Doc {
  candidate?: { fullName: string, vacancyTitle: string | null }
  progress?: { items: { title: string, kind: string, status: string, score: number | null, finishedAt: string | null }[] }
  scores?: { items: { kind: string, value: number | null, authorName: string | null, at: string, aiStub: boolean }[] }
  interview?: { scenarioName: string, finishedAt: string | null, aiScore: number | null, confidenceWord: string | null, aiStub: boolean, needsHuman: boolean, criteria: Criterion[] } | null
  strengthsRisks?: { status: 'ready' | 'unavailable', strengths: string[], risks: string[], caveat: string, aiStub: boolean }
  incomplete?: { items: { title: string, status: string }[] }
  passport?: { generatedAt: string, model: string | null, promptVersion: string | null, humanChecked: boolean, aiStub: boolean }
}

const props = defineProps<{ doc: Doc, disclaimerLine: string | null, off?: string[] }>()

const { t } = useI18n()
const { formatDate } = useFormat()

const isOff = (section: string) => (props.off ?? []).includes(section)
const confidence = (w: string | null) => (w ? t(`interview.card.confidenceWord.${w}`) : '—')
</script>

<template>
  <div class="doc">
    <section v-if="doc.candidate" :class="['sec', { off: isOff('candidate') }]">
      <h4 class="h4">{{ t('candidateSummary.section.candidate') }}</h4>
      <p class="lead">{{ doc.candidate.fullName }}</p>
      <p class="sub">{{ t('candidateSummary.vacancy') }}: {{ doc.candidate.vacancyTitle ?? t('candidateSummary.noVacancy') }}</p>
    </section>

    <section v-if="doc.progress" :class="['sec', { off: isOff('progress') }]">
      <h4 class="h4">{{ t('candidateSummary.section.progress') }}</h4>
      <ul v-if="doc.progress.items.length" class="list">
        <li v-for="(p, i) in doc.progress.items" :key="i">
          <span>{{ p.title }}</span>
          <span class="sub">{{ t(`candidateSummary.kind.${p.kind}`) }} · {{ t(`enrollment.${p.status}`) }}<template v-if="p.score !== null"> · {{ t('candidateSummary.score', { value: p.score }) }}</template></span>
        </li>
      </ul>
      <p v-else class="sub">{{ t('candidateSummary.nothing') }}</p>
    </section>

    <section v-if="doc.scores" :class="['sec', { off: isOff('scores') }]">
      <h4 class="h4">{{ t('candidateSummary.section.scores') }}</h4>
      <ul v-if="doc.scores.items.length" class="list">
        <li v-for="(s, i) in doc.scores.items" :key="i">
          <span>{{ t(`candidate.scoreKind.${s.kind}`) }}: <b>{{ s.value ?? '—' }}</b><template v-if="s.aiStub"> · {{ t('candidateSummary.stubScore') }}</template></span>
          <span class="sub">{{ s.authorName ? t('candidateSummary.by', { author: s.authorName, date: formatDate(s.at) }) : formatDate(s.at) }}</span>
        </li>
      </ul>
      <p v-else class="sub">{{ t('candidateSummary.nothing') }}</p>
    </section>

    <section v-if="doc.interview" :class="['sec', { off: isOff('interview') }]">
      <h4 class="h4">{{ t('candidateSummary.section.interview') }}</h4>
      <p class="sub">{{ doc.interview.scenarioName }}<template v-if="doc.interview.finishedAt"> · {{ formatDate(doc.interview.finishedAt) }}</template></p>
      <p v-if="doc.interview.aiScore !== null">{{ t('candidateSummary.interviewScore', { value: doc.interview.aiScore, confidence: confidence(doc.interview.confidenceWord) }) }}</p>
      <p v-if="doc.interview.needsHuman" class="note sun">{{ t('candidateSummary.needsHuman') }}</p>
      <p v-if="doc.interview.aiStub" class="note coral">{{ t('interview.card.stub') }}</p>
      <div v-for="(c, i) in doc.interview.criteria" :key="i" class="crit">
        <p><b>{{ c.name }}</b>: {{ c.value ?? '—' }} / {{ c.scaleMax }}<template v-if="c.humanValue !== null"> · {{ t('candidateSummary.human', { value: c.humanValue }) }}</template></p>
        <p v-if="c.rationale" class="sub">{{ c.rationale }}</p>
        <p v-if="c.quote" class="quote">«{{ c.quote }}»</p>
      </div>
    </section>

    <section v-if="doc.strengthsRisks" :class="['sec', { off: isOff('strengths_risks') }]">
      <h4 class="h4">{{ t('candidateSummary.section.strengths_risks') }}</h4>
      <template v-if="doc.strengthsRisks.status === 'ready'">
        <p class="sub">{{ t('candidateSummary.strengths') }}</p>
        <ul class="list">
          <li v-for="(x, i) in doc.strengthsRisks.strengths" :key="`s${i}`">{{ x }}</li>
          <li v-if="!doc.strengthsRisks.strengths.length" class="sub">{{ t('candidateSummary.nothing') }}</li>
        </ul>
        <p class="sub">{{ t('candidateSummary.risks') }}</p>
        <ul class="list">
          <li v-for="(x, i) in doc.strengthsRisks.risks" :key="`r${i}`">{{ x }}</li>
          <li v-if="!doc.strengthsRisks.risks.length" class="sub">{{ t('candidateSummary.nothing') }}</li>
        </ul>
        <p v-if="doc.strengthsRisks.aiStub" class="note coral">{{ t('interview.card.stub') }}</p>
      </template>
      <p v-else class="sub">{{ t('candidateSummary.unavailable') }}</p>
      <p class="note sun">{{ doc.strengthsRisks.caveat }}</p>
    </section>

    <section v-if="doc.incomplete && doc.incomplete.items.length" :class="['sec', { off: isOff('incomplete') }]">
      <h4 class="h4">{{ t('candidateSummary.section.incomplete') }}</h4>
      <ul class="list">
        <li v-for="(x, i) in doc.incomplete.items" :key="i">{{ x.title }} <span class="sub">· {{ t(`enrollment.${x.status}`) }}</span></li>
      </ul>
    </section>

    <section v-if="doc.passport" :class="['sec', { off: isOff('passport') }]">
      <h4 class="h4">{{ t('candidateSummary.section.passport') }}</h4>
      <p class="sub">{{ t('candidateSummary.generatedAt', { date: formatDate(doc.passport.generatedAt) }) }}</p>
      <p v-if="doc.passport.model" class="sub">{{ t('candidateSummary.model', { model: doc.passport.model, prompt: doc.passport.promptVersion ?? '—' }) }}</p>
    </section>

    <p v-if="disclaimerLine" class="disclaimer" role="note">{{ disclaimerLine }}</p>
  </div>
</template>

<style scoped>
.doc { display: grid; gap: var(--space-3); }
.sec { border-top: 1px solid var(--color-bg-line-soft); padding-top: var(--space-2); display: grid; gap: var(--space-1); }
.sec.off { opacity: 0.55; }
.sec p { margin: 0; }
.h4 { margin: 0; font-size: var(--font-size-body-s); font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-ink-muted); }
.lead { font-weight: 900; }
.sub { color: var(--color-ink-muted); font-size: var(--font-size-body-s); }
.list { margin: 0; padding-left: var(--space-4); display: grid; gap: var(--space-1); }
.list li { display: grid; }
.crit { display: grid; gap: var(--space-1); border-left: 3px solid var(--color-teal); padding-left: var(--space-2); }
.quote { font-style: italic; }
.disclaimer { margin: 0; border-top: 1px solid var(--color-bg-line); padding-top: var(--space-2); font-size: var(--font-size-body-s); color: var(--color-ink-muted); }
</style>

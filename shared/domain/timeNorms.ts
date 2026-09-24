import type { ContentTimeDeviationFlag, ContentTimeNormSource } from '../enums'

/**
 * Нормы времени на контент — правила в чистом виде (docs/v2/37-review-delegation.md §3.5,
 * §6.3, §7.13–7.15, §8, §9.3; PR-22). Один источник порогов для сервера
 * (`server/services/timeNorms.ts`), экрана (`TimeNormEditor.vue`, отчёт «План і факт часу») и
 * тестов (`tests/unit/time-norms.spec.ts`).
 *
 * **Отклонение факта от плана — сигнал качества материала, а не основание наказывать
 * человека** (`37` §7.14). Поэтому здесь нет и не будет ни одной функции «от человека»: все
 * входы — агрегаты по элементу (медиана, размер выборки) и норма элемента. Время не участвует
 * ни в одной формуле балла, зачёта, рейтинга или начисления баллов — ни прямо, ни коэффициентом
 * (§7.14 б); это проверяет `tests/integration/v2-time-norms.spec.ts` и тринадцатая сквозная
 * проверка `scripts/v2-crosschecks.sh`.
 */
export const TIME_NORM_RULES = {
  /** Медиана факта больше нормы вдвое — «Повільніше за план» (`too_slow`). */
  tooSlowFactor: 2,
  /** Медиана факта меньше 0,4 нормы — «Швидше за план» (`too_fast`). */
  tooFastFactor: 0.4,
  /**
   * Меньше 10 достоверных прохождений — `no_data`: флаг не ставится (§7.14), а медиана, p25 и
   * p75 не показываются вовсе (решение Р-22.4): на выборке из двух-трёх человек «обезличенный»
   * процентиль — это время конкретного человека, чьё имя известно из состава курса.
   */
  minSample: 10,
  /** С 20 прохождений — уведомление автору (§8) и кнопка «Застосувати» (§6.3). */
  notifySample: 20,
  /** Норма — от 1 минуты до 60 часов (`ctn_author_chk`, форма §6.3 «Від 1 хвилини до 60 годин»). */
  minSeconds: 60,
  maxSeconds: 216_000,
  /** Текст: знаков / 1100 в минуту (≈140 слов украинского текста), округление вверх (§7.13). */
  textCharsPerMinute: 1100,
  /** Тест: 45 с на вопрос плюс 150 с на развёрнутый (§7.13). */
  questionSeconds: 45,
  openQuestionSeconds: 150,
} as const

const R = TIME_NORM_RULES

/** Норма в допустимых границах: целые секунды, не меньше минуты и не больше 60 часов. */
export function clampNorm(seconds: number): number {
  return Math.min(R.maxSeconds, Math.max(R.minSeconds, Math.round(seconds)))
}

/** Число автора годится в норму как есть — без округления и подрезки (§6.3, `422 norm.value_range`). */
export function authorSecondsValid(seconds: unknown): seconds is number {
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= R.minSeconds && seconds <= R.maxSeconds
}

export interface NormValues {
  source: ContentTimeNormSource
  authorSeconds: number | null
  autoSeconds: number | null
}

/**
 * «Розрахунковий час» — действующая норма элемента (§7.13). `author` и `observed` — число,
 * которое утвердил автор: введённое руками или медиана, принятая «Застосувати» (она
 * замораживается в `author_seconds` в момент нажатия — решение Р-22.2); `auto` — расчёт по
 * объёму. Нет числа — нормы нет (`null`, в очереди и отчёте «—»): у практикума авторасчёта
 * не бывает, объём работы вне экрана система не видит.
 */
export function plannedSeconds(n: NormValues): number | null {
  const raw = n.source === 'auto' ? n.autoSeconds : n.authorSeconds
  return raw === null || raw === undefined || raw <= 0 ? null : clampNorm(raw)
}

/** «Факт / план» — во сколько раз медиана факта отличается от нормы; без нормы или факта — `null`. */
export function deviationFactor(planned: number | null, observed: number | null): number | null {
  if (!planned || observed === null || observed === undefined) return null
  return observed / planned
}

/**
 * Флаг отклонения (§7.14): `factor > 2` — `too_slow`, `< 0,4` — `too_fast`, иначе `none`;
 * выборка меньше 10 прохождений или нормы нет — `no_data`, флаг не ставится.
 */
export function deviationFlag(i: { plannedSeconds: number | null, observedSeconds: number | null, sample: number }): ContentTimeDeviationFlag {
  if (i.sample < R.minSample) return 'no_data'
  const f = deviationFactor(i.plannedSeconds, i.observedSeconds)
  if (f === null) return 'no_data'
  if (f > R.tooSlowFactor) return 'too_slow'
  if (f < R.tooFastFactor) return 'too_fast'
  return 'none'
}

export function isDeviation(flag: ContentTimeDeviationFlag): flag is 'too_slow' | 'too_fast' {
  return flag === 'too_slow' || flag === 'too_fast'
}

/** Медиану, p25 и p75 показывают только с 10 достоверных прохождений (Р-22.4). */
export function observedShown(sample: number): boolean {
  return sample >= R.minSample
}

/**
 * Уведомление автору `content_time_deviation` (§8): флаг `too_slow`/`too_fast` при выборке
 * ≥ 20 — **при входе в это состояние**, а не каждую неделю, пока оно держится (решение Р-22.6).
 * Состояние, в которое вошли раньше, повторно не уведомляет; вернулись в норму и снова ушли —
 * уведомляет заново. Выборка доросла до 20 при уже стоящем флаге — это вход: раньше
 * уведомления не было.
 */
export function deviationNoticeDue(
  prev: { flag: ContentTimeDeviationFlag, sample: number } | null,
  next: { flag: ContentTimeDeviationFlag, sample: number },
): boolean {
  const due = (s: { flag: ContentTimeDeviationFlag, sample: number }) => isDeviation(s.flag) && s.sample >= R.notifySample
  if (!due(next)) return false
  return !(prev && due(prev) && prev.flag === next.flag)
}

/** «Застосувати» (§6.3) доступно с 20 достоверных прохождений и при посчитанной медиане. */
export function canApplyObserved(n: { observedSeconds: number | null, observedSample: number }): boolean {
  return n.observedSample >= R.notifySample && n.observedSeconds !== null && n.observedSeconds > 0
}

/**
 * Медиана, которую автор принимает нормой: форма §6.3 ведёт норму в целых минутах, поэтому
 * медиана округляется вверх до минуты и подрезается границами нормы.
 */
export function appliedObservedSeconds(median: number): number {
  return clampNorm(Math.ceil(median / 60) * 60)
}

// ── Авторасчёт по объёму (§7.13) ──────────────────────────────────────────────────────────

/** Текст: `знаків / 1100` минут, округление вверх; пустой текст нормы не даёт. */
export function autoTextSeconds(chars: number): number | null {
  if (!chars || chars <= 0) return null
  return Math.ceil(chars / R.textCharsPerMinute) * 60
}

/** Видео и аудио — фактическая длительность; неизвестная длительность нормы не даёт. */
export function autoMediaSeconds(durationSec: number | null | undefined): number | null {
  return durationSec && durationSec > 0 ? Math.round(durationSec) : null
}

/** Тест: `питань × 45 с` плюс `розгорнутих питань × 150 с`; тест без вопросов нормы не даёт. */
export function autoQuizSeconds(questions: number, openQuestions: number): number | null {
  if (!questions || questions <= 0) return null
  return questions * R.questionSeconds + Math.max(0, openQuestions) * R.openQuestionSeconds
}

/** Минуты для текста уведомления (§8: «{fact} хв замість {plan} хв») — целые, как в форме нормы. */
export function wholeMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60))
}

/**
 * Порядок строк отчёта «План і факт часу» (§9.3): сначала «повільніше за план» от самых
 * тяжёлых, затем «швидше за план», затем в норме, в конце — без данных. Внутри — по
 * названию, чтобы порядок был устойчивым.
 */
export function comparePlanFact(
  a: { deviation: ContentTimeDeviationFlag, factor: number | null, title: string },
  b: { deviation: ContentTimeDeviationFlag, factor: number | null, title: string },
): number {
  const rank: Record<ContentTimeDeviationFlag, number> = { too_slow: 0, too_fast: 1, none: 2, no_data: 3 }
  if (rank[a.deviation] !== rank[b.deviation]) return rank[a.deviation] - rank[b.deviation]
  if (a.deviation === 'too_slow' && a.factor !== b.factor) return (b.factor ?? 0) - (a.factor ?? 0)
  if (a.deviation === 'too_fast' && a.factor !== b.factor) return (a.factor ?? 0) - (b.factor ?? 0)
  return a.title.localeCompare(b.title, 'uk')
}

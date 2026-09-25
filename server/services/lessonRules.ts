import type { ContentBlock } from '../../shared/schemas/content'
import { COMPLETION_RULES, type ResourceKind } from '../../shared/schemas/resources'

/**
 * Правила зачёта урока по типу материала (docs/11 §7.3 и Г-11.5). Считает сервер, клиент только
 * показывает подпись «чего не хватает» (CLAUDE.md п. 3). Функция чистая: на входе факты прогресса,
 * на выходе — готов ли урок к завершению и причины, если нет. Причины — тексты для ученика
 * (docs/11 §5.5: «Ще 20 секунд», «Подивись відео до кінця», «Познач усі пункти»).
 *
 * Правила по типу:
 * - article (сторінка): доскроллена до конца + время чтения по объёму текста (180 слов/мин, минимум 20 с);
 * - video: просмотрено ≥ 90 % (порог урока `video_threshold_pct`, по умолчанию 90);
 * - file (документ): пролистан до конца либо скачан + 15 с на страницу, но не больше 10 минут;
 * - link: открыт + подтверждение «Я ознайомився».
 * Сверх этого для любого типа: `min_seconds` урока, чек-листы с `require_all`, видео-блоки внутри страницы.
 */

export interface LessonFacts {
  kind: ResourceKind
  body: ContentBlock[]
  plainText: string
  /** Число страниц документа, если известно; иначе 1 */
  pages?: number | null
  minSeconds: number | null
  videoThresholdPct: number
}

export interface ProgressFacts {
  secondsSpent: number
  scrollPct: number
  videoPct: number
  acknowledged: boolean
  downloaded: boolean
  blocksState: Record<string, unknown>
}

export interface Evaluation {
  ready: boolean
  reasons: string[]
  /** Сколько секунд требует правило типа (для подписи «Ще N секунд»); null — время не требуется */
  requiredSeconds: number | null
}

/**
 * Причины незачёта: текст для ученика (uk, как его отдаёт `evaluateLesson`) и код — для экранов,
 * которые переводят подпись на язык интерфейса (прохождение ресурса вне курса, `resourcePass.ts`).
 * Время («Ще N секунд») — отдельный код `time`: число секунд экран берёт из `requiredSeconds`.
 */
export const REASONS = {
  read_to_end: 'Прочитай сторінку до кінця',
  watch_video: 'Подивись відео до кінця',
  scroll_doc: 'Перегорни документ до кінця або завантаж його',
  ack_link: 'Підтверди: «Я ознайомився»',
  check_all: 'Познач усі пункти',
} as const
export type ReasonCode = keyof typeof REASONS | 'time'

const CODE_BY_TEXT = new Map<string, ReasonCode>(Object.entries(REASONS).map(([code, text]): [string, ReasonCode] => [text, code as ReasonCode]))

/** Коды причин в том же порядке; время — `time`. Неизвестный текст не теряется молча — он просто без кода. */
export function reasonCodes(reasons: string[]): ReasonCode[] {
  return reasons.flatMap((r) => {
    if (/^Ще \d+ секунд$/.test(r)) return ['time' as const]
    const code = CODE_BY_TEXT.get(r)
    return code ? [code] : []
  })
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0
}

/** Минимальное время чтения страницы: слова / 180 в минуту, но не меньше 20 секунд. */
export function readingSeconds(plainText: string): number {
  const r = COMPLETION_RULES.article
  return Math.max(r.minSeconds, Math.ceil(wordCount(plainText) / r.wordsPerMinute * 60))
}

/** Минимальное время на документ: 15 с на страницу, не больше 10 минут. */
export function documentSeconds(pages: number | null | undefined): number {
  const r = COMPLETION_RULES.file
  return Math.min(r.maxSeconds, r.secondsPerPage * Math.max(1, pages ?? 1))
}

export function evaluateLesson(lesson: LessonFacts, p: ProgressFacts): Evaluation {
  const reasons: string[] = []
  let requiredSeconds: number | null = lesson.minSeconds ?? null

  switch (lesson.kind) {
    case 'article': {
      requiredSeconds = Math.max(requiredSeconds ?? 0, readingSeconds(lesson.plainText))
      if (p.scrollPct < COMPLETION_RULES.article.scrollPct) reasons.push(REASONS.read_to_end)
      break
    }
    case 'video': {
      if (p.videoPct < Math.max(lesson.videoThresholdPct, COMPLETION_RULES.video.minPct)) reasons.push(REASONS.watch_video)
      break
    }
    case 'file': {
      requiredSeconds = Math.max(requiredSeconds ?? 0, documentSeconds(lesson.pages))
      if (p.scrollPct < COMPLETION_RULES.file.scrollPct && !p.downloaded) reasons.push(REASONS.scroll_doc)
      break
    }
    case 'link': {
      if (!p.acknowledged) reasons.push(REASONS.ack_link)
      break
    }
  }

  if (requiredSeconds != null && requiredSeconds > 0 && p.secondsSpent < requiredSeconds) {
    reasons.push(`Ще ${requiredSeconds - p.secondsSpent} секунд`)
  }

  // Блоки страницы (docs/11 §3.3, §7.3): видео внутри и обязательные чек-листы
  for (const block of lesson.body) {
    if (block.type === 'video' && p.videoPct < lesson.videoThresholdPct) reasons.push(REASONS.watch_video)
    if (block.type === 'checklist' && block.requireAll) {
      const checked = (p.blocksState[block.id] as number[] | undefined) ?? []
      if (checked.length < block.items.length) reasons.push(REASONS.check_all)
    }
  }

  const unique = [...new Set(reasons)]
  return { ready: unique.length === 0, reasons: unique, requiredSeconds: requiredSeconds || null }
}

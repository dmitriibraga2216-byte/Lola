import { z } from 'zod'
import { ATTEMPT_REQUEST_STATUSES, QUESTION_KINDS, SCORING_METHODS } from '../enums'
import { bodySchema } from './content'

/** Коды типов вопросов — из docs/02 (семь эталона + number, text_short, file). */
export const questionKindSchema = z.enum(QUESTION_KINDS)
export const scoringMethodSchema = z.enum(SCORING_METHODS)

const option = z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(500), imageMediaId: z.string().uuid().optional() })

/** Область на изображении в долях от его размера (docs/12 §15 Г-12.1 п. 2). */
export const mapAreaSchema = z.discriminatedUnion('shape', [
  z.object({ id: z.string().min(1).max(64), shape: z.literal('rect'), x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }),
  z.object({ id: z.string().min(1).max(64), shape: z.literal('circle'), cx: z.number().min(0).max(1), cy: z.number().min(0).max(1), r: z.number().min(0.01).max(1) }),
])

/** Эталоны по типу (docs/12 §3.3) — один источник для клиента и сервера. */
export const answerByKindSchema = {
  single: z.object({ correctId: z.string() }),
  multi: z.object({ correctIds: z.array(z.string()).min(1), requireExact: z.boolean().optional() }),
  ordering: z.object({ order: z.array(z.string()).min(3) }),
  comparison: z.object({ pairs: z.array(z.object({ leftId: z.string(), rightId: z.string() })).min(2) }),
  classification: z.object({ placements: z.array(z.object({ itemId: z.string(), groupId: z.string() })).min(1) }),
  answer_by_map: z.object({ areaIds: z.array(z.string()).min(1) }),
  number: z.object({ value: z.number(), tolerance: z.number().min(0), toleranceType: z.enum(['abs', 'pct']).optional(), unit: z.string().max(20).optional() }),
  text_short: z.object({ accepted: z.array(z.string().min(1)).min(1), caseSensitive: z.boolean().optional(), allowTypos: z.number().int().min(0).max(2).optional() }),
  free: z.object({ criteria: z.array(z.string()).optional(), reference: z.string().max(5000).optional(), minLength: z.number().int().min(0).optional(), maxLength: z.number().int().max(5000).optional() }).nullable().optional(),
  file: z.object({ criteria: z.array(z.string()).optional(), formats: z.array(z.string()).optional(), maxFiles: z.number().int().min(1).max(5).optional() }).nullable().optional(),
} as const

/** Конструктор ответа по типу (docs/12 §14.6). */
export const optionsByKindSchema = {
  single: z.array(option).min(2).max(10),
  multi: z.array(option).min(2).max(15),
  ordering: z.array(option).min(3).max(10),
  comparison: z.object({ left: z.array(option).min(2).max(10), right: z.array(option).min(2) }),
  classification: z.object({ groups: z.array(z.object({ id: z.string().min(1).max(64), title: z.string().min(1).max(200) })).min(2).max(6), items: z.array(option).min(2).max(20) }),
  answer_by_map: z.object({ imageMediaId: z.string().uuid(), areas: z.array(mapAreaSchema).min(1).max(20) }),
} as const

export const questionSchema = z.object({
  bankId: z.string().uuid(),
  kind: questionKindSchema,
  questionGroupId: z.string().uuid().nullable().optional(), // «Вибрати групу» (docs/12 §14.3)
  stem: bodySchema.min(1),
  options: z.unknown().optional(),
  answer: z.unknown().optional(),
  explanation: bodySchema.optional(),
  hint: z.string().max(300).optional(),
  graderHint: z.string().max(2000).nullable().optional(), // «Підказка для перевіряючого» — ученику не видна
  attachFiles: z.boolean().default(false), // «Дозволити прикріпляти файли до відповіді»
  isCritical: z.boolean().default(false),
  difficulty: z.number().int().min(1).max(5).default(3),
  points: z.number().min(0.1).max(100).default(1),
  scoringMethod: scoringMethodSchema.default('formula'), // «Метод підрахунку балів»
  negativeMarking: z.boolean().default(false),
  tags: z.array(z.string().max(50)).max(20).default([]),
  timeLimitSec: z.number().int().min(10).max(3600).nullable().optional(),
}).superRefine((q, ctx) => {
  // Проверки по типу (docs/12 §3.3)
  const fail = (msg: string, path: string[] = ['answer']) => ctx.addIssue({ code: 'custom', message: msg, path })
  switch (q.kind) {
    case 'single': {
      const opts = optionsByKindSchema.single.safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 2 до 10 варіантів', ['options'])
      const a = answerByKindSchema.single.safeParse(q.answer)
      if (!a.success || !opts.data.some(o => o.id === a.data.correctId)) fail('Позначте правильну відповідь')
      break
    }
    case 'multi': {
      const opts = optionsByKindSchema.multi.safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 2 до 15 варіантів', ['options'])
      const a = answerByKindSchema.multi.safeParse(q.answer)
      if (!a.success) fail('Позначте хоча б одну правильну відповідь')
      break
    }
    case 'ordering': {
      const opts = optionsByKindSchema.ordering.safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 3 до 10 елементів', ['options'])
      const a = answerByKindSchema.ordering.safeParse(q.answer)
      if (!a.success || a.data.order.length !== opts.data.length) fail('Задайте правильний порядок усіх елементів')
      break
    }
    case 'comparison': {
      const opts = optionsByKindSchema.comparison.safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 2 до 10 пар', ['options'])
      const a = answerByKindSchema.comparison.safeParse(q.answer)
      if (!a.success) fail('Задайте відповідності')
      break
    }
    case 'classification': {
      const opts = optionsByKindSchema.classification.safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 2 до 6 класів і від 2 до 20 варіантів', ['options'])
      const a = answerByKindSchema.classification.safeParse(q.answer)
      const groupIds = new Set(opts.data.groups.map(g => g.id))
      if (!a.success || opts.data.items.some(it => !a.data.placements.some(p => p.itemId === it.id && groupIds.has(p.groupId)))) {
        fail('Кожному варіанту вкажіть клас')
      }
      break
    }
    case 'answer_by_map': {
      const opts = optionsByKindSchema.answer_by_map.safeParse(q.options)
      if (!opts.success) return fail('Завантажте зображення і позначте хоча б одну область', ['options'])
      const a = answerByKindSchema.answer_by_map.safeParse(q.answer)
      if (!a.success || !a.data.areaIds.every(id => opts.data.areas.some(ar => ar.id === id))) fail('Позначте правильну область')
      break
    }
    case 'number': {
      const a = answerByKindSchema.number.safeParse(q.answer)
      if (!a.success) fail('Вкажіть значення і допуск')
      break
    }
    case 'text_short': {
      const a = answerByKindSchema.text_short.safeParse(q.answer)
      if (!a.success) fail('Вкажіть хоча б одну прийнятну відповідь')
      break
    }
    case 'free':
    case 'file':
      break
  }
})

export const questionUpdateSchema = questionSchema.innerType().partial().extend({
  status: z.enum(['active', 'archived']).optional(),
})

// ── Группы вопросов (docs/12 §14.3, docs/04 §4.8) ─────────────────────

export const questionGroupSchema = z.object({
  title: z.string().min(1).max(120),
  sortOrder: z.number().int().min(0).max(1000).default(0),
})
export const questionGroupUpdateSchema = questionGroupSchema.partial()

/** «Питання з іншого тесту» — копия, «Створені питання» (банк) — ссылка (docs/12 §15 Г-12.2). */
export const questionsImportSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('copy'), fromQuizId: z.string().uuid(), questionIds: z.array(z.string().uuid()).min(1).max(200), questionGroupId: z.string().uuid().nullable().optional() }),
  z.object({ mode: z.literal('link'), questionIds: z.array(z.string().uuid()).min(1).max(200), questionGroupId: z.string().uuid().nullable().optional() }),
])

// ── Очередь проверки по ответам (docs/12 §14.4, docs/04 §4.7) ─────────

export const reviewAnswersQuerySchema = z.object({
  checked: z.enum(['unchecked', 'checked', 'all']).default('unchecked'), // Неперевірені · Перевірені · Усі
  tags: z.array(z.string().max(50)).max(20).default([]), // «Мітки питань»
  outsidePrograms: z.boolean().default(false), // «Поза програмами»
  outsideCourses: z.boolean().default(false), // «Поза курсами»
  locationId: z.string().uuid().optional(), // «Точка»
  quizId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(500).default(200),
})

/** Вложение к свободному ответу — файл уже загружен через /media (docs/04 §4.6). */
export const answerFileSchema = z.object({
  mediaId: z.string().uuid(),
  name: z.string().min(1).max(255),
  kind: z.enum(['photo', 'video', 'file']).default('file'),
  bytes: z.number().int().min(0),
})

// ── Запросы дополнительных попыток (docs/12 §6.3, §14.5) ──────────────

export const attemptRequestSchema = z.object({
  reason: z.string().min(10).max(300),
  enrollmentId: z.string().uuid().optional(),
})

export const attemptRequestDecideSchema = z.object({
  approved: z.boolean(),
  comment: z.string().max(500).optional(),
})

export const attemptRequestsQuerySchema = z.object({
  status: z.enum([...ATTEMPT_REQUEST_STATUSES, 'all']).default('pending'), // фильтр по умолчанию — «Очікує»
  quizId: z.string().uuid().optional(),
})

/** «Перерахувати» (docs/22 §13.7): причина пишется в запись результата и аудит. */
export const recalculateSchema = z.object({
  comment: z.string().max(500).optional(),
})

export const bankSchema = z.object({
  name: z.string().min(3).max(120),
  description: z.string().max(500).optional(),
  categoryId: z.string().uuid().optional(),
})

/**
 * Параметры прохождения теста (docs/12 §3.5 + docs/02 §2.7, группы эталона «Загальне ·
 * Термін · Результат · Нагороди»). Живут в assignments.params, копируются в attempts.params
 * при старте. У самого теста этих полей нет (CLAUDE.md п. 11).
 */
export const quizParamsSchema = z.object({
  passScore: z.number().min(1).max(100).default(80),
  attemptsAllowed: z.number().int().min(0).max(10).default(3),
  attemptCooldownMin: z.number().int().min(0).max(1440).default(0),
  timeLimitSec: z.number().int().min(60).max(14400).nullable().default(null),
  shuffleQuestions: z.boolean().default(true),
  shuffleOptions: z.boolean().default(true),
  showAnswers: z.enum(['never', 'after_question', 'after_attempt', 'after_pass']).default('after_attempt'),
  showScore: z.boolean().default(true),
  allowSkip: z.boolean().default(true),
  allowBack: z.boolean().default(true),
  requireAllAnswered: z.boolean().default(false),
  // «Загальне» (docs/15 §14.3)
  questionsMode: z.enum(['all', 'one_per_group', 'limited']).default('all'), // «Кількість питань»
  questionsCount: z.number().int().min(1).max(200).nullable().default(null), // для limited
  trainingMode: z.boolean().default(false), // «Режим тренування»
  allowOtherPages: z.boolean().default(true), // «Дозволити відкриття інших сторінок порталу»
  showErrorProtocol: z.boolean().default(true), // «Показати протокол помилок»
  hideCorrectInProtocol: z.boolean().default(false), // «Приховати правильні відповіді з протоколу»
  protocolAfterLastAttempt: z.boolean().default(false), // Г-12.4, наше: протокол лише після останньої спроби
  instantFeedback: z.boolean().default(false), // «Показувати, чи правильно він дав відповідь»
  manualNext: z.boolean().default(false), // «Перейти до наступного питання вручну»
  questionTimeLimit: z.boolean().default(false), // использовать лимит на вопрос (docs/12 §3.5)
  // «Результат»
  resultSource: z.enum(['last', 'best']).default('last'), // «Результатом виконання буде»
  fixResult: z.boolean().default(true), // «Фіксувати результат завдання»
  scaleId: z.string().uuid().nullable().default(null), // «Перетворити результат за шкалою»
  // «Нагороди»
  badgeId: z.string().uuid().nullable().default(null),
  certificateId: z.string().uuid().nullable().default(null),
  points: z.number().int().min(0).max(10000).default(0), // рейтинг
  bonuses: z.number().int().min(0).max(10000).default(0), // магазин подарунків
  // «Інші параметри»
  allowComments: z.boolean().default(true),
  notifyOnResult: z.boolean().default(true),
})

export const quizSchema = z.object({
  title: z.string().min(3).max(200),
  description: bodySchema.optional(),
  kind: z.enum(['quiz', 'certification']).default('quiz'),
  tags: z.array(z.string().max(50)).max(20).default([]),
  selectionMode: z.enum(['fixed', 'random']).default('fixed'),
  randomRules: z.array(z.object({
    bankId: z.string().uuid(),
    tags: z.array(z.string()).optional(),
    difficultyMin: z.number().int().min(1).max(5).optional(),
    difficultyMax: z.number().int().min(1).max(5).optional(),
    count: z.number().int().min(1).max(100),
  })).optional(),
  requiresOfflineConfirm: z.boolean().default(false),
})

export const quizUpdateSchema = quizSchema.partial().extend({
  status: z.enum(['draft', 'published', 'archived']).optional(),
})

export const quizQuestionsSchema = z.object({
  items: z.array(z.object({
    questionId: z.string().uuid(),
    sort: z.number().int().min(0),
    pointsOverride: z.number().min(0.1).max(100).nullable().optional(),
    isCriticalOverride: z.boolean().nullable().optional(),
  })).max(200),
})

export const answerSchema = z.object({
  answer: z.unknown(),
  timeSpentSec: z.number().int().min(0).max(3600).optional(),
})

export const gradeSchema = z.object({
  isCorrect: z.boolean(),
  score: z.number().min(0).optional(),
  comment: z.string().max(2000).optional(),
})

export const annulSchema = z.object({
  reason: z.string().min(5).max(500),
})

export const revokeSchema = z.object({
  reason: z.string().min(10).max(500),
  notify: z.boolean().default(true),
})

/** GET /certificates — список виданих (докс/33 D-065): пошук за ПІБ/номером, курс, стан. */
export const certificateListQuerySchema = z.object({
  courseId: z.string().uuid().optional(),
  status: z.enum(['active', 'revoked']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
})

export type QuizParamsInput = z.infer<typeof quizParamsSchema>

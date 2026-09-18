import { z } from 'zod'
import { bodySchema } from './content'

const kindSchema = z.enum(['single', 'multiple', 'order', 'match', 'number', 'text_short', 'text_long', 'file'])

const option = z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(500), imageMediaId: z.string().uuid().optional() })

export const questionSchema = z.object({
  bankId: z.string().uuid(),
  kind: kindSchema,
  stem: bodySchema.min(1),
  options: z.unknown().optional(),
  answer: z.unknown().optional(),
  explanation: bodySchema.optional(),
  hint: z.string().max(300).optional(),
  isCritical: z.boolean().default(false),
  difficulty: z.number().int().min(1).max(5).default(3),
  points: z.number().min(0.1).max(100).default(1),
  partialCredit: z.boolean().default(true),
  negativeMarking: z.boolean().default(false),
  tags: z.array(z.string().max(50)).max(20).default([]),
  timeLimitSec: z.number().int().min(10).max(3600).nullable().optional(),
}).superRefine((q, ctx) => {
  // Проверки по типу (docs/12 §3.3)
  const fail = (msg: string, path: string[] = ['answer']) => ctx.addIssue({ code: 'custom', message: msg, path })
  switch (q.kind) {
    case 'single': {
      const opts = z.array(option).min(2).max(10).safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 2 до 10 варіантів', ['options'])
      const a = z.object({ correctId: z.string() }).safeParse(q.answer)
      if (!a.success || !opts.data.some(o => o.id === a.data.correctId)) fail('Позначте правильну відповідь')
      break
    }
    case 'multiple': {
      const opts = z.array(option).min(2).max(15).safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 2 до 15 варіантів', ['options'])
      const a = z.object({ correctIds: z.array(z.string()).min(1), requireExact: z.boolean().optional() }).safeParse(q.answer)
      if (!a.success) fail('Позначте хоча б одну правильну відповідь')
      break
    }
    case 'order': {
      const opts = z.array(option).min(3).max(10).safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 3 до 10 елементів', ['options'])
      const a = z.object({ order: z.array(z.string()).min(3) }).safeParse(q.answer)
      if (!a.success || a.data.order.length !== opts.data.length) fail('Задайте правильний порядок усіх елементів')
      break
    }
    case 'match': {
      const opts = z.object({ left: z.array(option).min(2).max(10), right: z.array(option).min(2) }).safeParse(q.options)
      if (!opts.success) return fail('Потрібно від 2 до 10 пар', ['options'])
      const a = z.object({ pairs: z.array(z.object({ leftId: z.string(), rightId: z.string() })).min(2) }).safeParse(q.answer)
      if (!a.success) fail('Задайте відповідності')
      break
    }
    case 'number': {
      const a = z.object({ value: z.number(), tolerance: z.number().min(0), toleranceType: z.enum(['abs', 'pct']).optional(), unit: z.string().max(20).optional() }).safeParse(q.answer)
      if (!a.success) fail('Вкажіть значення і допуск')
      break
    }
    case 'text_short': {
      const a = z.object({ accepted: z.array(z.string().min(1)).min(1), caseSensitive: z.boolean().optional(), allowTypos: z.number().int().min(0).max(2).optional() }).safeParse(q.answer)
      if (!a.success) fail('Вкажіть хоча б одну прийнятну відповідь')
      break
    }
    case 'text_long':
    case 'file':
      break
  }
})

export const questionUpdateSchema = questionSchema.innerType().partial().extend({
  status: z.enum(['active', 'archived']).optional(),
})

export const bankSchema = z.object({
  name: z.string().min(3).max(120),
  description: z.string().max(500).optional(),
  categoryId: z.string().uuid().optional(),
})

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
  params: quizParamsSchema.partial().optional(),
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

export type QuizParamsInput = z.infer<typeof quizParamsSchema>

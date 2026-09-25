import { z } from 'zod'
import { KEYSETS } from '../domain/keyset'
import { INTERVIEW_TEXT_ANSWER_MAX } from '../domain/interview'
import { INTERVIEW_ALTERNATIVE_PATHS, INTERVIEW_ANSWER_MODES, INTERVIEW_SCENARIO_STATUSES } from '../enums'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты ИИ-собеседования (`docs/v2/30-ai-interview.md` §6.1–§6.3, §10; план `45` PR-28).
 * Схема отвечает за форму поля и тексты ошибок формы (§6), сервис
 * `server/services/interview/*` — за правила, которым нужны другие строки: альтернатива и
 * критерии при публикации, вид теста, согласие до попытки.
 */

// ── Сценарий (форма §6.1) ───────────────────────────────────────────────────────────────

const scenarioFields = {
  name: z.string().trim().min(3, 'Назва від 3 символів').max(200),
  interviewerName: z.string().trim().min(2, 'Вкажіть ім\'я').max(40),
  introText: z.string().trim().min(50, 'Від 50 символів').max(1500),
  outroText: z.string().trim().min(20, 'Від 20 символів').max(800),
  answerModes: z.array(z.enum(INTERVIEW_ANSWER_MODES)).min(1, 'Оберіть хоча б один формат').max(2)
    .transform(v => [...new Set(v)]),
  minAnswerSec: z.number().int().min(1).max(599),
  maxAnswerSec: z.number().int().min(30, 'Від 30 до 600 секунд').max(600, 'Від 30 до 600 секунд'),
  thinkTimeSec: z.number().int().min(0, 'Від 0 до 120 секунд').max(120, 'Від 0 до 120 секунд'),
  silenceTimeoutSec: z.number().int().min(5).max(600),
  retakeLimit: z.number().int().min(0, 'Від 0 до 5').max(5, 'Від 0 до 5'),
  /** Видео в PR-28 не пишется (Р-28.7) — поле формы есть, включить его нельзя. */
  recordVideo: z.literal(false),
  transcribeLang: z.enum(['uk', 'en', 'ru']),
  minConfidence: z.number().min(0.3, 'Від 0.3 до 0.95').max(0.95, 'Від 0.3 до 0.95'),
  alternativePath: z.enum(INTERVIEW_ALTERNATIVE_PATHS, { errorMap: () => ({ message: 'Оберіть альтернативу' }) }).nullable(),
}

/** `POST /interview-scenarios` — новый сценарий-черновик для теста вида `interview`. */
export const interviewScenarioCreateSchema = z.object({
  quizId: z.string().uuid('Оберіть модуль співбесіди'),
  name: scenarioFields.name,
  interviewerName: scenarioFields.interviewerName.default('Лола'),
  introText: scenarioFields.introText,
  outroText: scenarioFields.outroText,
  answerModes: scenarioFields.answerModes.default(['voice', 'text']),
  minAnswerSec: scenarioFields.minAnswerSec.default(5),
  maxAnswerSec: scenarioFields.maxAnswerSec.default(180),
  thinkTimeSec: scenarioFields.thinkTimeSec.default(15),
  silenceTimeoutSec: scenarioFields.silenceTimeoutSec.default(45),
  retakeLimit: scenarioFields.retakeLimit.default(2),
  recordVideo: scenarioFields.recordVideo.default(false),
  transcribeLang: scenarioFields.transcribeLang.default('uk'),
  minConfidence: scenarioFields.minConfidence.default(0.6),
  alternativePath: scenarioFields.alternativePath.default(null),
}).strict().refine(v => v.minAnswerSec < v.maxAnswerSec, { path: ['minAnswerSec'], message: 'Мінімальна тривалість відповіді має бути меншою за максимальну' })

export type InterviewScenarioCreate = z.infer<typeof interviewScenarioCreateSchema>

/**
 * `PUT /interview-scenarios/:id` — правка переданных полей и смена статуса. Опубликованный
 * сценарий на месте не правится: правка создаёт новую версию-черновик (`30` §12 п. 9).
 * `status: 'published'` — публикация: без альтернативы `422 scenario.alternative_required`,
 * без критериев `422 criteria.required` (`30` §7.5, §10, §13 к. 3).
 */
export const interviewScenarioUpdateSchema = z.object({
  name: scenarioFields.name.optional(),
  interviewerName: scenarioFields.interviewerName.optional(),
  introText: scenarioFields.introText.optional(),
  outroText: scenarioFields.outroText.optional(),
  answerModes: scenarioFields.answerModes.optional(),
  minAnswerSec: scenarioFields.minAnswerSec.optional(),
  maxAnswerSec: scenarioFields.maxAnswerSec.optional(),
  thinkTimeSec: scenarioFields.thinkTimeSec.optional(),
  silenceTimeoutSec: scenarioFields.silenceTimeoutSec.optional(),
  retakeLimit: scenarioFields.retakeLimit.optional(),
  recordVideo: scenarioFields.recordVideo.optional(),
  transcribeLang: scenarioFields.transcribeLang.optional(),
  minConfidence: scenarioFields.minConfidence.optional(),
  alternativePath: scenarioFields.alternativePath.optional(),
  status: z.enum(INTERVIEW_SCENARIO_STATUSES).optional(),
}).strict()

export type InterviewScenarioUpdate = z.infer<typeof interviewScenarioUpdateSchema>

/** `GET /interview-scenarios` — список: фильтр по статусу и тесту, ключевой курсор (`04` §4.1). */
export const interviewScenarioListSchema = z.object({
  status: z.enum(INTERVIEW_SCENARIO_STATUSES).optional(),
  quizId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: keysetCursorSchema(KEYSETS.interviewScenarios).optional(),
})

export type InterviewScenarioListQuery = z.infer<typeof interviewScenarioListSchema>

// ── Критерий (форма §6.2) ───────────────────────────────────────────────────────────────

export const interviewCriterionSchema = z.object({
  name: z.string().trim().min(3, 'Назва від 3 символів').max(100),
  description: z.string().trim().min(20, 'Опис критерію від 20 символів').max(500, 'Опис — до 500 символів'),
  weight: z.number().min(0.1, 'Вага від 0.1 до 10').max(10, 'Вага від 0.1 до 10').default(1),
  scaleMax: z.number().min(2, 'Максимальний бал від 2 до 100').max(100, 'Максимальний бал від 2 до 100').default(5),
  isCritical: z.boolean().default(false),
  sort: z.number().int().min(0).max(1000).optional(),
}).strict()

export type InterviewCriterionInput = z.infer<typeof interviewCriterionSchema>

export const interviewCriterionUpdateSchema = z.object({
  name: z.string().trim().min(3, 'Назва від 3 символів').max(100).optional(),
  description: z.string().trim().min(20, 'Опис критерію від 20 символів').max(500, 'Опис — до 500 символів').optional(),
  weight: z.number().min(0.1).max(10).optional(),
  scaleMax: z.number().min(2).max(100).optional(),
  isCritical: z.boolean().optional(),
  sort: z.number().int().min(0).max(1000).optional(),
}).strict()

export type InterviewCriterionUpdate = z.infer<typeof interviewCriterionUpdateSchema>

// ── Кандидат: вход, согласие, старт (§5.1, §6.3, §10) ─────────────────────────────────────

/** Где открыт тест: самостоятельное назначение или урок курса (как у обычного теста). */
export const interviewEntryQuerySchema = z.object({
  enrollmentId: z.string().uuid().optional(),
  lessonId: z.string().uuid().optional(),
})

export type InterviewEntryQuery = z.infer<typeof interviewEntryQuerySchema>

/**
 * `POST /interviews/entry/:quizId/consent` (`30` §10 `{decision, scopes, text_version,
 * alternative?}`). `textVersion` и `textHash` — та редакция текста, которую человек видел:
 * другая редакция — `422 interview_consent.invalid` («оновіть сторінку»).
 */
export const interviewConsentSchema = z.object({
  decision: z.enum(['accepted', 'declined']),
  textVersion: z.string().trim().min(1).max(60),
  textHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** При отказе — альтернатива сценария (радио формы §6.3). */
  alternative: z.enum(INTERVIEW_ALTERNATIVE_PATHS).optional(),
  /** «Зручний час для дзвінка» (§6.3, необязательно, 0–200). */
  preferredTime: z.string().trim().max(200, 'До 200 символів').optional(),
}).merge(interviewEntryQuerySchema).strict()

export type InterviewConsentInput = z.infer<typeof interviewConsentSchema>

/**
 * `POST /interviews/entry/:quizId/alternative` — альтернативный путь без отказа: ИИ сейчас
 * недоступен (подписка, исчерпанный лимит — `30` §7.12, §7.20) или нет микрофона при сценарии
 * без текстовых ответов (`30` §12 п. 1).
 */
export const interviewAlternativeSchema = z.object({
  reason: z.enum(['ai_unavailable', 'no_microphone']),
  preferredTime: z.string().trim().max(200, 'До 200 символів').optional(),
}).merge(interviewEntryQuerySchema).strict()

export type InterviewAlternativeInput = z.infer<typeof interviewAlternativeSchema>

/** `POST /interviews/entry/:quizId/start` (`30` §10 `{answer_mode}`). */
export const interviewStartSchema = z.object({
  answerMode: z.enum(INTERVIEW_ANSWER_MODES),
  device: z.enum(['mobile', 'desktop']).optional(),
}).merge(interviewEntryQuerySchema).strict()

export type InterviewStartInput = z.infer<typeof interviewStartSchema>

// ── Кандидат: реплики, связь, завершение (§5.2, §7.12, §10) ───────────────────────────────

/** `POST /interviews/:sessionId/turns/:ordinal/upload` — метаданные файла; сам файл идёт в S3 напрямую. */
export const interviewUploadSchema = z.object({
  mime: z.enum(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg']),
  bytes: z.number().int().min(1),
}).strict()

export type InterviewUploadInput = z.infer<typeof interviewUploadSchema>

/** `POST /interviews/:sessionId/turns/:ordinal/answer` (`30` §10 `{mode, media_id?, text?}`). */
export const interviewAnswerSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('voice'),
    mediaId: z.string().uuid(),
    durationMs: z.number().int().min(0).max(3_600_000),
    firstSoundDelayMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
    silenceMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
  }).strict(),
  z.object({
    mode: z.literal('text'),
    text: z.string().max(INTERVIEW_TEXT_ANSWER_MAX, `До ${INTERVIEW_TEXT_ANSWER_MAX} символів`),
  }).strict(),
  z.object({
    mode: z.literal('none'),
    silenceMs: z.number().int().min(0).max(3_600_000).nullable().optional(),
  }).strict(),
])

export type InterviewAnswerInput = z.infer<typeof interviewAnswerSchema>

/** Биение сессии раз в 5 секунд (`30` §7.12): переключения вкладки считает браузер. */
export const interviewHeartbeatSchema = z.object({
  tabSwitches: z.number().int().min(0).max(10_000).optional(),
  silenceEvents: z.number().int().min(0).max(10_000).optional(),
}).strict()

export type InterviewHeartbeatInput = z.infer<typeof interviewHeartbeatSchema>

/** `POST /interviews/:sessionId/withdraw` (`30` §10 `{reason?}`). */
export const interviewWithdrawSchema = z.object({
  reason: z.string().trim().max(500).optional(),
}).strict()

// ── Письменная форма — альтернатива `text_form` (§6.3, §7.5) ─────────────────────────────

export const interviewTextAnswerSchema = z.object({
  text: z.string().max(INTERVIEW_TEXT_ANSWER_MAX, `До ${INTERVIEW_TEXT_ANSWER_MAX} символів`),
}).strict()

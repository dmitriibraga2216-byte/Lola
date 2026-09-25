import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, inet, integer, jsonb, numeric, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { attemptAnswers, attempts, quizzes } from './quizzes'
import { mediaAssets } from './content'
import { candidateScores } from './recruiting'
import { aiCalls } from './ai'

/**
 * ИИ-собеседование (`docs/v2/30-ai-interview.md` §3.3–§3.5; план `45` PR-28, миграция
 * `0095_v2_interview`). **Собеседование — режим теста, а не вторая система прохождения**
 * (`30` §3.1): сценарий привязан к тесту `quizzes.kind = 'interview'` (решение `44` В-12),
 * сессия — поверх строки `attempts`, ответ кандидата — строка `attempt_answers`. Здесь только то,
 * чего в модели попытки нет: согласие, характеристики записи, расшифровка, обрывы, флаги и
 * объяснённые оценки ИИ по критериям. Баллы и статусы попытки здесь не дублируются.
 *
 * **ИИ не принимает решений о людях** (инвариант 18, `30` §7.1): ни одна из этих таблиц не
 * ссылается на состояние кандидата, а оценка ИИ ложится в карточку одной строкой
 * `candidate_scores.kind = 'ai'` — рядом с человеческими, а не вместо них.
 */

/**
 * Сценарий собеседования (`30` §3.3, форма §6.1). Опубликованный сценарий не правится на месте:
 * правка создаёт новую версию-черновик с копией критериев, публикация архивирует прежнюю —
 * идущие сессии держат свою версию (`30` §12 п. 9). `alternative_path` в черновике может быть
 * пуст, но опубликовать сценарий без альтернативы нельзя ни сервисом (`422
 * scenario.alternative_required`), ни мимо него (`interview_scenarios_alt_published_chk`).
 */
export const interviewScenarios = pgTable('interview_scenarios', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  quizId: uuid('quiz_id').notNull().references(() => quizzes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  interviewerName: text('interviewer_name').notNull().default('Лола'),
  introText: text('intro_text').notNull(),
  outroText: text('outro_text').notNull(),
  /** Подмножество `INTERVIEW_ANSWER_MODES`; текст — единственный способ ответить без микрофона. */
  answerModes: text('answer_modes').array().notNull().default(sql`'{voice,text}'::text[]`),
  minAnswerSec: integer('min_answer_sec').notNull().default(5),
  maxAnswerSec: integer('max_answer_sec').notNull().default(180),
  thinkTimeSec: integer('think_time_sec').notNull().default(15),
  silenceTimeoutSec: integer('silence_timeout_sec').notNull().default(45),
  retakeLimit: integer('retake_limit').notNull().default(2),
  /** Видео в PR-28 не пишется (Р-28.7): колонка по DDL, значение — только `false`. */
  recordVideo: boolean('record_video').notNull().default(false),
  transcribeLang: text('transcribe_lang').notNull().default('uk'),
  minConfidence: numeric('min_confidence', { precision: 4, scale: 3 }).notNull().default('0.600'),
  /** Одно из `INTERVIEW_ALTERNATIVE_PATHS`; пусто только у черновика. */
  alternativePath: text('alternative_path'),
  /** Одно из `INTERVIEW_SCENARIO_STATUSES`. */
  status: text('status').notNull().default('draft'),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, t => [
  unique('uq_interview_scenarios_version').on(t.tenantId, t.quizId, t.version),
  index('idx_interview_scenarios_tenant').on(t.tenantId, t.status),
  uniqueIndex('uq_interview_scenarios_published').on(t.tenantId, t.quizId).where(sql`status = 'published'`),
  check('interview_scenarios_alt_chk', sql`${t.alternativePath} is null or ${t.alternativePath} in ('human_interview', 'text_form')`),
  check('interview_scenarios_alt_published_chk', sql`${t.status} = 'draft' or ${t.alternativePath} is not null`),
  check('interview_scenarios_modes_chk', sql`array_length(${t.answerModes}, 1) between 1 and 2 and ${t.answerModes} <@ array['voice', 'text']::text[]`),
  check('interview_scenarios_status_chk', sql`${t.status} in ('draft', 'published', 'archived')`),
  check('interview_scenarios_time_chk', sql`${t.maxAnswerSec} between 30 and 600 and ${t.minAnswerSec} >= 1 and ${t.minAnswerSec} < ${t.maxAnswerSec}`),
  check('interview_scenarios_think_chk', sql`${t.thinkTimeSec} between 0 and 120 and ${t.silenceTimeoutSec} between 5 and 600`),
  check('interview_scenarios_retake_chk', sql`${t.retakeLimit} between 0 and 5`),
  check('interview_scenarios_confidence_chk', sql`${t.minConfidence} between 0.3 and 0.95`),
  check('interview_scenarios_lang_chk', sql`${t.transcribeLang} in ('uk', 'en', 'ru')`),
  check('interview_scenarios_video_chk', sql`not ${t.recordVideo}`),
])

/**
 * Критерий оценки (`30` §3.3, форма §6.2). `description` 20–500 знаков — определение, которое
 * получает модель и читает человек рядом с баллом: «Комунікабельність» без расшифровки даёт
 * необъяснимый балл. Принадлежит версии сценария: новая версия копирует критерии.
 */
export const interviewCriteria = pgTable('interview_criteria', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  scenarioId: uuid('scenario_id').notNull().references(() => interviewScenarios.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  nameUk: text('name_uk').notNull(),
  description: text('description').notNull(),
  weight: numeric('weight', { precision: 5, scale: 2 }).notNull().default('1'),
  scaleMax: numeric('scale_max', { precision: 5, scale: 2 }).notNull().default('5'),
  isCritical: boolean('is_critical').notNull().default(false),
  sort: integer('sort').notNull().default(0),
  /** Одно из `INTERVIEW_CRITERION_SOURCES`. */
  source: text('source').notNull().default('manual'),
}, t => [
  unique('uq_interview_criteria_code').on(t.tenantId, t.scenarioId, t.code),
  index('idx_interview_criteria_tenant').on(t.tenantId, t.scenarioId, t.sort),
  check('interview_criteria_source_chk', sql`${t.source} in ('manual', 'ai_suggested')`),
  check('interview_criteria_desc_chk', sql`char_length(${t.description}) between 20 and 500`),
  check('interview_criteria_name_chk', sql`char_length(${t.nameUk}) between 3 and 100`),
  check('interview_criteria_weight_chk', sql`${t.weight} > 0 and ${t.scaleMax} between 2 and 100`),
])

/**
 * Согласие на запись и обработку ответов (`30` §3.3, §7.4–§7.6). Решение по паре «человек —
 * версия сценария», а не по сессии: при отказе сессия не создаётся вовсе (`30` §13 к. 2), а
 * согласие должно быть до создания попытки (к. 1). `text_hash` — sha256 ровно того текста,
 * который увидел человек: через год нужно доказать, **что именно** он прочитал.
 *
 * Отзыв меняет `decision` на `withdrawn` и ставит `withdrawn_at` — момент согласия остаётся в
 * `decided_at`. Согласие на обработку ПД кандидата (`users.consent_given_at`) это согласие не
 * заменяет: там анкета, здесь голос. `request_context` — журнал (CLAUDE.md п. 14); IP и браузер
 * при обезличивании стираются вместе с остальными ПД.
 */
export const interviewConsents = pgTable('interview_consents', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  scenarioId: uuid('scenario_id').notNull().references(() => interviewScenarios.id, { onDelete: 'cascade' }),
  /** Одно из `INTERVIEW_CONSENT_DECISIONS`. */
  decision: text('decision').notNull(),
  /** `{audio, video, transcript, share_with_hiring_manager}` — на что именно дано согласие. */
  scopes: jsonb('scopes').notNull().default(sql`'{}'::jsonb`),
  textVersion: text('text_version').notNull(),
  textHash: text('text_hash').notNull(),
  lang: text('lang').notNull().default('uk'),
  /** Одно из `INTERVIEW_ALTERNATIVE_PATHS` — у отказа обязательно. */
  alternativeChosen: text('alternative_chosen'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  requestContext: jsonb('request_context'),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
}, t => [
  index('idx_interview_consents_tenant').on(t.tenantId, t.userId, t.decidedAt.desc()),
  check('interview_consents_decision_chk', sql`${t.decision} in ('accepted', 'declined', 'withdrawn')`),
  check('interview_consents_alt_chk', sql`${t.alternativeChosen} is null or ${t.alternativeChosen} in ('human_interview', 'text_form')`),
  check('interview_consents_declined_alt_chk', sql`${t.decision} <> 'declined' or ${t.alternativeChosen} is not null`),
  check('interview_consents_withdrawn_chk', sql`(${t.decision} = 'withdrawn') = (${t.withdrawnAt} is not null)`),
  check('interview_consents_hash_chk', sql`${t.textHash} ~ '^[0-9a-f]{64}$'`),
])

/**
 * Сессия собеседования поверх строки `attempts` (`30` §3.4, §4). Создаётся **после** согласия,
 * вместе с попыткой: `attempt_id` обязателен, а до решения кандидата попытки ещё нет (к. 1).
 *
 * `ai_stub` — явный признак, что хоть один вывод модели в сессии (расшифровка или оценка) дал
 * профиль-заглушка (`driver = 'stub'`, `44` §8). Оценка заглушки не бывает основанием решения
 * человека без пометки (Р-28.4): признак ставится в момент вывода и не выводится задним числом
 * из имени модели, которое профиль мог сменить.
 *
 * `redacted_at` — расшифровки, цитаты и обоснования стёрты отзывом согласия или обезличиванием
 * (`30` §7.6, §7.9): баллы, уверенность и метрики остаются для статистики.
 */
export const interviewSessions = pgTable('interview_sessions', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  attemptId: uuid('attempt_id').notNull().references(() => attempts.id, { onDelete: 'cascade' }),
  scenarioId: uuid('scenario_id').notNull().references(() => interviewScenarios.id),
  candidateId: uuid('candidate_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  consentId: uuid('consent_id').references(() => interviewConsents.id, { onDelete: 'set null' }),
  /** Одно из `INTERVIEW_SESSION_STATES`. */
  state: text('state').notNull().default('created'),
  /** Одно из `INTERVIEW_ANSWER_MODES` — выбранный на старте основной способ ответа. */
  answerMode: text('answer_mode'),
  turnsTotal: integer('turns_total').notNull().default(0),
  turnsAnswered: integer('turns_answered').notNull().default(0),
  disconnects: integer('disconnects').notNull().default(0),
  resumes: integer('resumes').notNull().default(0),
  silenceEvents: integer('silence_events').notNull().default(0),
  tabSwitches: integer('tab_switches').notNull().default(0),
  device: text('device'),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  ipChanges: integer('ip_changes').notNull().default(0),
  aiScore: numeric('ai_score', { precision: 6, scale: 2 }),
  aiConfidence: numeric('ai_confidence', { precision: 4, scale: 3 }),
  aiVerdictText: text('ai_verdict_text'),
  aiStub: boolean('ai_stub').notNull().default(false),
  candidateScoreId: uuid('candidate_score_id').references(() => candidateScores.id, { onDelete: 'set null' }),
  /** Одно из `INTERVIEW_DEGRADED_REASONS`. */
  degradedReason: text('degraded_reason'),
  needsHumanReason: text('needs_human_reason'),
  /** Измеримые факты для человека (`30` §7.17): ни один не влияет на балл и не виден кандидату. */
  flags: jsonb('flags').notNull().default(sql`'[]'::jsonb`),
  purgeAfter: timestamp('purge_after', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  redactedAt: timestamp('redacted_at', { withTimezone: true }),
}, t => [
  unique('uq_interview_sessions_attempt').on(t.tenantId, t.attemptId),
  index('idx_interview_sessions_tenant').on(t.tenantId, t.state, t.createdAt.desc()),
  index('idx_interview_sessions_tenant_cand').on(t.tenantId, t.candidateId, t.createdAt.desc()),
  index('idx_interview_sessions_tenant_purge').on(t.tenantId, t.purgeAfter).where(sql`purge_after is not null`),
  check('interview_sessions_state_chk', sql`${t.state} in ('created', 'consent_pending', 'in_progress', 'paused', 'submitted', 'transcribing', 'scoring', 'scored', 'needs_human', 'abandoned', 'expired', 'failed')`),
  check('interview_sessions_degr_chk', sql`${t.degradedReason} is null or ${t.degradedReason} in ('provider_down', 'limit_exhausted', 'transcribe_failed', 'low_confidence', 'consent_withdrawn', 'timeout', 'unexplained')`),
  check('interview_sessions_mode_chk', sql`${t.answerMode} is null or ${t.answerMode} in ('voice', 'text')`),
  check('interview_sessions_score_chk', sql`(${t.aiScore} is null or ${t.aiScore} between 0 and 100) and (${t.aiConfidence} is null or ${t.aiConfidence} between 0 and 1)`),
  check('interview_sessions_flags_chk', sql`jsonb_typeof(${t.flags}) = 'array'`),
])

/**
 * Реплика собеседования (`30` §3.4): одна строка на вопрос снимка попытки — вопрос интервьюера
 * (`prompt_text`) и ответ кандидата с характеристиками записи. Расшифровка живёт в реплике, а не
 * отдельной таблицей: она одна на реплику и всегда нужна вместе с ней; повторная расшифровка
 * увеличивает `transcript_version`, прежняя остаётся в `ai_calls.output`. У текстового ответа
 * «расшифровка» — сам текст (`transcript_status = 'not_needed'`): оценка читает реплики одинаково.
 */
export const interviewTurns = pgTable('interview_turns', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => interviewSessions.id, { onDelete: 'cascade' }),
  attemptAnswerId: uuid('attempt_answer_id').references(() => attemptAnswers.id, { onDelete: 'set null' }),
  ordinal: integer('ordinal').notNull(),
  /** Одно из `INTERVIEW_TURN_ROLES`. */
  role: text('role').notNull(),
  questionId: uuid('question_id'),
  questionVersion: integer('question_version'),
  promptText: text('prompt_text'),
  /** Одно из `INTERVIEW_TURN_MODES`. */
  answerMode: text('answer_mode'),
  mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  durationMs: integer('duration_ms'),
  silenceMs: integer('silence_ms'),
  retakes: integer('retakes').notNull().default(0),
  firstSoundDelayMs: integer('first_sound_delay_ms'),
  transcript: text('transcript'),
  transcriptLang: text('transcript_lang'),
  transcriptConfidence: numeric('transcript_confidence', { precision: 4, scale: 3 }),
  transcriptEngine: text('transcript_engine'),
  transcriptVersion: integer('transcript_version').notNull().default(1),
  /** Одно из `INTERVIEW_TRANSCRIPT_STATUSES`. */
  transcriptStatus: text('transcript_status').notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
}, t => [
  unique('uq_interview_turns_ordinal').on(t.tenantId, t.sessionId, t.ordinal),
  index('idx_interview_turns_tenant_media').on(t.tenantId, t.mediaId).where(sql`media_id is not null`),
  check('interview_turns_role_chk', sql`${t.role} in ('interviewer', 'candidate')`),
  check('interview_turns_mode_chk', sql`${t.answerMode} is null or ${t.answerMode} in ('voice', 'text', 'none')`),
  check('interview_turns_tr_chk', sql`${t.transcriptStatus} in ('pending', 'ok', 'low_confidence', 'failed', 'skipped', 'manual', 'not_needed')`),
  check('interview_turns_ordinal_chk', sql`${t.ordinal} >= 1 and ${t.retakes} >= 0`),
])

/**
 * Оценка ИИ по критерию (`30` §3.5, §7.2). **Обоснование и хотя бы одна цитата — ограничения
 * БД, а не пожелание интерфейса**: балл, который нечем объяснить, физически не сохраняется, а
 * сессия уходит в `needs_human`. Это самый дешёвый способ сделать правило `30` §7.1 неотключаемым.
 *
 * Единственное исключение — строка, **стёртая** отзывом согласия или обезличиванием
 * (`redacted_at`, `30` §7.9): балл, уверенность и расхождение остаются статистике, обоснование и
 * цитаты — нет. Вставить уже «стёртую» строку нельзя (триггер `ics_insert_guard`), поэтому
 * исключение не превращается в обход: новая оценка без объяснения не записывается ни при каком пути.
 */
export const interviewCriterionScores = pgTable('interview_criterion_scores', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull().references(() => interviewSessions.id, { onDelete: 'cascade' }),
  criterionId: uuid('criterion_id').notNull().references(() => interviewCriteria.id, { onDelete: 'cascade' }),
  value: numeric('value', { precision: 5, scale: 2 }),
  confidence: numeric('confidence', { precision: 4, scale: 3 }).notNull(),
  rationale: text('rationale'),
  /** `[{turnId, ordinal, quote, charFrom, charTo, msFrom}]` — цитаты из расшифровки. */
  evidence: jsonb('evidence').notNull().default(sql`'[]'::jsonb`),
  aiCallId: bigint('ai_call_id', { mode: 'number' }).references(() => aiCalls.id, { onDelete: 'set null' }),
  humanValue: numeric('human_value', { precision: 5, scale: 2 }),
  humanBy: uuid('human_by').references(() => users.id, { onDelete: 'set null' }),
  humanAt: timestamp('human_at', { withTimezone: true }),
  humanComment: text('human_comment'),
  /** Одно из `INTERVIEW_SCORE_AGREEMENTS`. */
  agreement: text('agreement').notNull().default('pending'),
  redactedAt: timestamp('redacted_at', { withTimezone: true }),
}, t => [
  unique('uq_interview_criterion_scores').on(t.tenantId, t.sessionId, t.criterionId),
  index('idx_interview_criterion_scores_tenant_agr').on(t.tenantId, t.agreement).where(sql`agreement <> 'pending'`),
  check('ics_agreement_chk', sql`${t.agreement} in ('pending', 'match', 'minor', 'major')`),
  check('ics_confidence_chk', sql`${t.confidence} between 0 and 1`),
  check('ics_rationale_chk', sql`${t.redactedAt} is not null or (${t.rationale} is not null and char_length(${t.rationale}) between 20 and 2000)`),
  check('ics_evidence_chk', sql`${t.redactedAt} is not null or (jsonb_typeof(${t.evidence}) = 'array' and jsonb_array_length(${t.evidence}) >= 1)`),
  check('ics_evidence_quote_chk', sql`${t.redactedAt} is not null or not jsonb_path_exists(${t.evidence}, '$[*] ? (!exists(@.quote) || @.quote == "")')`),
  check('ics_redacted_chk', sql`${t.redactedAt} is null or (${t.rationale} is null and ${t.evidence} = '[]'::jsonb)`),
])

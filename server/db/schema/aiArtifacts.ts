import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { baseColumns, tenantId } from './_common'
import { tenants } from './tenants'
import { users } from './people'
import { mediaAssets } from './content'
import { aiCalls } from './ai'

/**
 * Машинные артефакты вокруг решений людей (`docs/v2/30-ai-interview.md` §3.5, §3.6, §4, §7.13–§7.16;
 * план `45` PR-29, миграция `0096_v2_ai_summary`): Підсумок кандидата, подсказка проверяющему и
 * выборочная перепроверка качества модели.
 *
 * **ИИ не принимает решений о людях** (инвариант 18, `30` §7.1). Здесь это держат сами таблицы:
 * - в Підсумке строка «Документ сформовано автоматично» — CHECK таблицы, а не пункт интерфейса:
 *   ни настройка тенанта, ни правка текста, ни прямая запись её не снимут (`30` §7.14, §13 к. 14);
 * - в подсказке **нет полей вердикта** — `is_correct`, `score`, `verdict`, `passed` (`30` §3.6
 *   [решение]): подсказка структурно не умеет сказать «зараховано», только «пункт ключа прозвучал
 *   вот здесь», «не прозвучал», «сказано противоположное»;
 * - перепроверка качества пишет вердикт о **модели**, а не о человеке.
 */

/**
 * Підсумок кандидата (`30` §3.5, §5.4, §7.14, §7.15). Новая генерация — новая версия; старые версии
 * видны рекрутеру и по ссылке недоступны (`30` §4). `body` — все семь секций §7.14 плюс
 * неснимаемая строка `disclaimer`; `sections` — какие секции включены в отправляемый документ.
 *
 * Сверх DDL `30` §3.5 (пометка-исправление там же): `auto_send_cancelled_at`/`_by` — отмена
 * авто-отправки рекрутером до `auto_send_due_at` (§13 к. 13: «может быть отменён»), чтобы
 * ночная сверка не поставила отменённое заново; `redacted_at` — текст стёрт отзывом согласия или
 * обезличиванием (`30` §7.6, §7.9), строка остаётся ради версии и журнала; `updated_at`.
 */
export const candidateSummaries = pgTable('candidate_summaries', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  candidateId: uuid('candidate_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Мягкая ссылка (`40` §5 0018): вакансия к моменту выдачи могла быть закрыта и архивирована. */
  vacancyId: uuid('vacancy_id'),
  version: integer('version').notNull().default(1),
  /** Одно из `CANDIDATE_SUMMARY_STATES`. */
  state: text('state').notNull().default('draft'),
  /** Одно из `CANDIDATE_SUMMARY_COMPLETENESS`. */
  completeness: text('completeness').notNull().default('partial'),
  /** `SummaryBody` (`shared/domain/candidateSummary.ts`): секции §7.14 и `disclaimer`. */
  body: jsonb('body').notNull(),
  /** Включённые секции — подмножество `CANDIDATE_SUMMARY_SECTIONS`. */
  sections: jsonb('sections').notNull().default(sql`'[]'::jsonb`),
  lang: text('lang').notNull().default('uk'),
  /** Одно из `CANDIDATE_SUMMARY_GENERATED_BY`. */
  generatedBy: text('generated_by').notNull().default('ai'),
  aiCallId: bigint('ai_call_id', { mode: 'number' }).references(() => aiCalls.id, { onDelete: 'set null' }),
  editedBy: uuid('edited_by').references(() => users.id, { onDelete: 'set null' }),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  /** PDF (`origin = 'ai_artifact'`, `30` §7.7) — в PR-29 не формируется. */
  mediaId: uuid('media_id').references(() => mediaAssets.id, { onDelete: 'set null' }),
  shareToken: text('share_token'),
  shareExpiresAt: timestamp('share_expires_at', { withTimezone: true }),
  /** Снимок правила авто-отправки тенанта (`30` §6.5) и оценки, по которой она назначена. */
  autoSendRule: jsonb('auto_send_rule'),
  autoSendDueAt: timestamp('auto_send_due_at', { withTimezone: true }),
  autoSendCancelledAt: timestamp('auto_send_cancelled_at', { withTimezone: true }),
  autoSendCancelledBy: uuid('auto_send_cancelled_by').references(() => users.id, { onDelete: 'set null' }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  /** Одно из `CANDIDATE_SUMMARY_CHANNELS`. */
  sentChannel: text('sent_channel'),
  sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
  redactedAt: timestamp('redacted_at', { withTimezone: true }),
}, t => [
  unique('uq_candidate_summaries_version').on(t.tenantId, t.candidateId, t.version),
  unique('uq_candidate_summaries_share_token').on(t.shareToken),
  index('idx_candidate_summaries_tenant_state').on(t.tenantId, t.state, t.createdAt.desc()),
  index('idx_candidate_summaries_tenant_due').on(t.tenantId, t.autoSendDueAt).where(sql`state = 'ready'`),
  check('candidate_summaries_state_chk', sql`${t.state} in ('draft', 'ready', 'sent', 'revoked', 'expired')`),
  check('candidate_summaries_compl_chk', sql`${t.completeness} in ('full', 'partial')`),
  check('candidate_summaries_gen_chk', sql`${t.generatedBy} in ('ai', 'ai_edited', 'manual')`),
  check('candidate_summaries_lang_chk', sql`${t.lang} in ('uk', 'en', 'ru')`),
  check('candidate_summaries_channel_chk', sql`${t.sentChannel} is null or ${t.sentChannel} in ('email', 'link')`),
  check('candidate_summaries_version_chk', sql`${t.version} >= 1`),
  check('candidate_summaries_sections_chk', sql`jsonb_typeof(${t.sections}) = 'array'`),
  check('candidate_summaries_sent_chk', sql`${t.state} not in ('sent', 'expired') or (${t.shareToken} is not null and ${t.sentAt} is not null and ${t.shareExpiresAt} is not null)`),
  check('candidate_summaries_revoked_chk', sql`${t.state} <> 'revoked' or ${t.revokedAt} is not null`),
  // `coalesce(…, false)`: без подписи выражение даёт NULL, а NULL в CHECK — «проходит»
  check('candidate_summaries_disclaimer_chk', sql`${t.redactedAt} is not null or coalesce(jsonb_typeof(${t.body} -> 'disclaimer') = 'object' and (${t.body} -> 'disclaimer' ->> 'text') ~ '^(Документ сформовано автоматично|The document was generated automatically|Документ сформирован автоматически)', false)`),
  check('candidate_summaries_redacted_chk', sql`${t.redactedAt} is null or (${t.body} = '{}'::jsonb and ${t.state} <> 'sent')`),
])

/**
 * Подсказка проверяющему (`30` §3.6, §5.5, §7.13): что из контрольного ключа прозвучало в ответе
 * человека, чего нет, где сказано противоположное. **Полей вердикта нет намеренно** — ни
 * `is_correct`, ни `score`, ни `verdict`, ни `passed` (строку без них проверяет
 * `tests/integration/v2-ai-summary.spec.ts`, к. 11). Оценку ставит ментор; значения подсказки в его
 * форму не подставляются.
 *
 * Сверх DDL (пометка в `30` §3.6): `ai_stub` — подсказку дал профиль-заглушка (Р-28.4), `reason` —
 * почему подсказки нет (§5.5: «причина видна админу»), `updated_at`.
 */
export const aiReviewHints = pgTable('ai_review_hints', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Одно из `AI_REVIEW_HINT_TARGETS`. */
  targetKind: text('target_kind').notNull(),
  /** `attempt_answers.id` | `workshop_submissions.id` — мягкая ссылка (`44` В-11). */
  targetId: uuid('target_id').notNull(),
  /** Чей ответ. */
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Кто принял решение по работе. */
  reviewerId: uuid('reviewer_id').references(() => users.id, { onDelete: 'set null' }),
  /** `{questionId?, questionVersion?, workshopId?, keyPoints: [{id, text}], moduleIds[], criteriaIds[]}` — ключ на момент сверки. */
  keySource: jsonb('key_source').notNull(),
  /** `[{keyPoint, quote, charFrom, charTo}]`. */
  matched: jsonb('matched').notNull().default(sql`'[]'::jsonb`),
  /** `[{keyPoint}]`. */
  missing: jsonb('missing').notNull().default(sql`'[]'::jsonb`),
  /** `[{keyPoint, quote, why}]`. */
  contradictions: jsonb('contradictions').notNull().default(sql`'[]'::jsonb`),
  coverage: numeric('coverage', { precision: 4, scale: 3 }),
  confidence: numeric('confidence', { precision: 4, scale: 3 }),
  aiCallId: bigint('ai_call_id', { mode: 'number' }).references(() => aiCalls.id, { onDelete: 'set null' }),
  aiStub: boolean('ai_stub').notNull().default(false),
  /** Одно из `AI_REVIEW_HINT_STATES`. */
  state: text('state').notNull().default('queued'),
  reason: text('reason'),
  shownAt: timestamp('shown_at', { withTimezone: true }),
  /** `{passed, decision}` — решение ментора, каким оно было, для сверки `agreement`. */
  reviewerDecision: jsonb('reviewer_decision'),
  reviewerDecidedAt: timestamp('reviewer_decided_at', { withTimezone: true }),
  /** Одно из `AI_REVIEW_HINT_AGREEMENTS`. */
  agreement: text('agreement').notNull().default('pending'),
}, t => [
  unique('uq_ai_review_hints_target').on(t.tenantId, t.targetKind, t.targetId),
  index('idx_ai_review_hints_tenant').on(t.tenantId, t.state, t.createdAt.desc()),
  index('idx_ai_review_hints_tenant_agr').on(t.tenantId, t.agreement, t.createdAt.desc()),
  check('ai_review_hints_target_chk', sql`${t.targetKind} in ('attempt_answer', 'workshop_submission')`),
  check('ai_review_hints_state_chk', sql`${t.state} in ('queued', 'ready', 'failed', 'skipped', 'degraded')`),
  check('ai_review_hints_agree_chk', sql`${t.agreement} in ('pending', 'match', 'minor', 'major', 'not_shown')`),
  check('ai_review_hints_lists_chk', sql`jsonb_typeof(${t.matched}) = 'array' and jsonb_typeof(${t.missing}) = 'array' and jsonb_typeof(${t.contradictions}) = 'array'`),
  check('ai_review_hints_ratio_chk', sql`(${t.coverage} is null or ${t.coverage} between 0 and 1) and (${t.confidence} is null or ${t.confidence} between 0 and 1)`),
  check('ai_review_hints_decided_chk', sql`(${t.reviewerDecidedAt} is null) = (${t.reviewerDecision} is null) and (${t.agreement} = 'pending' or ${t.reviewerDecidedAt} is not null)`),
])

/**
 * Выборочная перепроверка вывода модели (`30` §3.6, §6.4, §7.16). Ставится ежедневной выборкой
 * (`ai.quality_sample`: 5 % оценок и подсказок, все `major`, все с уверенностью ниже 0,5) и сразу —
 * несогласием рекрутера с оценкой ИИ (`sampled_by = 'override'`, `30` §13 к. 6). Вердикт — о
 * модели, а не о человеке; `(tenant_id, ref_kind, ref_id)` — одна строка на вывод.
 */
export const aiQualityReviews = pgTable('ai_quality_reviews', {
  ...baseColumns,
  tenantId: tenantId().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Одно из `AI_QUALITY_REF_KINDS`. */
  refKind: text('ref_kind').notNull(),
  /** Мягкая ссылка (`40` Р-11): `interview_criterion_scores.id` | `ai_review_hints.id` | `candidate_summaries.id`. */
  refId: uuid('ref_id').notNull(),
  /** Одно из `AI_QUALITY_SAMPLED_BY`. */
  sampledBy: text('sampled_by').notNull().default('auto'),
  /** Почему в выборке: `random`, `major`, `low_confidence` (§7.16) или `override_major`, `override_flagged` (§6.4). */
  sampleReason: text('sample_reason'),
  auditorId: uuid('auditor_id').references(() => users.id, { onDelete: 'set null' }),
  /** Одно из `AI_QUALITY_VERDICTS`; пусто — ещё не проверено. */
  verdict: text('verdict'),
  notes: text('notes'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
}, t => [
  unique('uq_ai_quality_reviews_ref').on(t.tenantId, t.refKind, t.refId),
  index('idx_ai_quality_reviews_tenant').on(t.tenantId, t.verdict, t.createdAt.desc()),
  check('aqr_ref_chk', sql`${t.refKind} in ('interview_criterion_score', 'review_hint', 'summary')`),
  check('aqr_verdict_chk', sql`${t.verdict} is null or ${t.verdict} in ('correct', 'minor_error', 'major_error', 'harmful')`),
  check('aqr_sampled_by_chk', sql`${t.sampledBy} in ('auto', 'override')`),
  check('aqr_reviewed_chk', sql`(${t.verdict} is null) = (${t.reviewedAt} is null)`),
])

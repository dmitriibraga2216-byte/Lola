import { z } from 'zod'
import { KEYSETS } from '../domain/keyset'
import { AI_CALL_STATUSES, AI_DATA_REGIONS, AI_DRIVERS, AI_PROVIDER_RETENTIONS, AI_PURPOSES, AI_QUALITY_REF_KINDS, AI_QUALITY_VERDICTS } from '../enums'
import { keysetCursorSchema } from './keyset'

/**
 * Контракты профилей поставщика модели и журнала вызовов (`docs/v2/30-ai-interview.md` §3.2,
 * §6, §10; план `45` PR-27). Правила, которые требуют других строк (срок хранения у
 * расшифровки, цепочка запасных, комментарий к региону `other`), проверяет сервис
 * `server/services/ai/providers.ts`: схема отвечает за форму поля, сервис — за смысл.
 */

/** Параметры модели (`30` §3.2 «температура, лимит токенов»); таймаут — отдельное поле `maxLatencyMs`. */
export const aiProviderParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
}).strict()

const endpointUrl = z.string().trim().url('Вкажіть адресу API провайдера, наприклад https://api.example.com/v1').max(500)

/**
 * Свой ключ тенанта — только на запись: в ответах его нет, есть `hasOwnKey`. `null` в правке
 * снимает свой ключ, и профиль возвращается к ключу платформы.
 */
const apiKey = z.string().trim().min(8, 'Ключ API занадто короткий').max(500)

const fields = {
  name: z.string().trim().min(2).max(120),
  purpose: z.enum(AI_PURPOSES),
  driver: z.enum(AI_DRIVERS),
  endpointUrl: endpointUrl.nullable(),
  apiKey: apiKey.nullable(),
  modelName: z.string().trim().min(1).max(120),
  modelVersion: z.string().trim().max(60).nullable(),
  params: aiProviderParamsSchema,
  dataRegion: z.enum(AI_DATA_REGIONS),
  /** Обязателен при переводе профиля в регион `other` — уходит в `audit_log` (`30` §3.2). */
  regionComment: z.string().trim().min(10, 'Поясніть, чому дані оброблятимуться поза ЄС (від 10 символів)').max(500),
  providerRetention: z.enum(AI_PROVIDER_RETENTIONS),
  maxLatencyMs: z.number().int().min(1000).max(300_000),
  isActive: z.boolean(),
  priority: z.number().int().min(0).max(10_000),
  fallbackProviderId: z.string().uuid().nullable(),
}

/** `POST /ai/providers` — новый профиль (например, запасной для цепочки `30` §7.12). */
export const aiProviderCreateSchema = z.object({
  code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/, 'Код — латиниця в нижньому регістрі, цифри, «-» і «_», від 2 до 40 символів'),
  name: fields.name,
  purpose: fields.purpose,
  driver: fields.driver,
  endpointUrl: fields.endpointUrl.optional(),
  apiKey: fields.apiKey.optional(),
  modelName: fields.modelName,
  modelVersion: fields.modelVersion.optional(),
  params: fields.params.default({}),
  dataRegion: fields.dataRegion.default('eu'),
  regionComment: fields.regionComment.optional(),
  providerRetention: fields.providerRetention.default('unknown'),
  maxLatencyMs: fields.maxLatencyMs.default(30_000),
  isActive: fields.isActive.default(true),
  priority: fields.priority.default(100),
  fallbackProviderId: fields.fallbackProviderId.optional(),
}).strict()
export type AiProviderCreateInput = z.infer<typeof aiProviderCreateSchema>

/** `PUT /ai/providers/:id` — правка профиля: только переданные поля, код не меняется. */
export const aiProviderUpdateSchema = z.object({
  name: fields.name.optional(),
  purpose: fields.purpose.optional(),
  driver: fields.driver.optional(),
  endpointUrl: fields.endpointUrl.optional(),
  apiKey: fields.apiKey.optional(),
  modelName: fields.modelName.optional(),
  modelVersion: fields.modelVersion.optional(),
  params: fields.params.optional(),
  dataRegion: fields.dataRegion.optional(),
  regionComment: fields.regionComment.optional(),
  providerRetention: fields.providerRetention.optional(),
  maxLatencyMs: fields.maxLatencyMs.optional(),
  isActive: fields.isActive.optional(),
  priority: fields.priority.optional(),
  fallbackProviderId: fields.fallbackProviderId.optional(),
}).strict()
export type AiProviderUpdateInput = z.infer<typeof aiProviderUpdateSchema>

/** Фильтры журнала ИИ-вызовов (`30` §5.6: назначение, статус, период). */
export const aiCallsQuerySchema = z.object({
  purpose: z.enum(AI_PURPOSES).optional(),
  status: z.enum(AI_CALL_STATUSES).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  cursor: keysetCursorSchema(KEYSETS.aiCalls).optional(),
  limit: z.number().int().min(1).max(100).default(50),
})
export type AiCallsQuery = z.infer<typeof aiCallsQuerySchema>

// ── Перепроверка качества ИИ (`30` §7.16, §10 `/ai/quality-reviews`; план `45` PR-29) ────────

/** `GET /ai/quality-reviews` — очередь администратора: непроверенные сначала, ключевой курсор. */
export const aiQualityListSchema = z.object({
  status: z.enum(['pending', 'reviewed', 'all']).default('pending'),
  refKind: z.enum(AI_QUALITY_REF_KINDS).optional(),
  cursor: keysetCursorSchema(KEYSETS.aiQualityReviews).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict()
export type AiQualityListQuery = z.infer<typeof aiQualityListSchema>

/** `POST /ai/quality-reviews/:id` — вердикт о **модели**, а не о человеке (`30` §3.6). */
export const aiQualityVerdictSchema = z.object({
  verdict: z.enum(AI_QUALITY_VERDICTS, { errorMap: () => ({ message: 'Оберіть вердикт' }) }),
  notes: z.string().trim().max(2000, 'До 2000 символів').nullable().optional(),
}).strict()
export type AiQualityVerdictInput = z.infer<typeof aiQualityVerdictSchema>
